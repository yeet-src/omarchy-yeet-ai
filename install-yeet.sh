#!/bin/sh
# Install a pinned yeet release on Arch, verifying it before anything runs.
#
# Fetches yeet 0.23.2 for this machine's architecture from pkgs.yeet.cx,
# checks the package's sha256 against the values below and its signature
# against the pinned release key, installs it with pacman and starts the
# daemon. Every step must succeed for the next to run. Log in afterwards
# with `yeet login`.
#
# Run it from the plugin checkout, which is this repository:
#   sh ~/.config/omarchy/plugins/cx.yeet.yeet-ai/install-yeet.sh
#
# On exit it reports whether the install succeeded, with the contents of
# /etc/os-release, to api.yeet.cx, the same way the installer at
# https://yeet.cx does, so an install that fails on a distro we have not
# seen reaches support without an email. Pass --no-phone-home to skip it.

set -eu

version=0.23.2-1
key=F537B2E78670F4F6C75D0E997FE0E3E7218228E6
sha256_x86_64=3fab3ca1ae199486ef7c60ccef16cc1c66a68cce2bbd8962cab0b1c11327c5d7
sha256_aarch64=bafa3182cbe3c02468366ed1a249eee8c57a7e839e310416e38917168291b079

phone_home=yes
for arg in "$@"; do
  case $arg in
    --no-phone-home) phone_home=no ;;
    *) >&2 echo "install-yeet: unknown argument $arg"; exit 2 ;;
  esac
done

# fetch URL FILE MAX_SIZE MAX_SECONDS
#
# Every download is bounded before the checksum ever runs: the server
# has 15s to answer, the whole transfer has MAX_SECONDS, a link that
# drops under 10 KiB/s for 30s counts as stalled, and a response past
# MAX_SIZE is refused (from Content-Length up front, or, with curl 8.4
# or newer, the moment the body crosses it) instead of filling the
# disk. The package is about 58 MiB; the signature and key are bytes.
fetch() {
  curl -fsSL \
    --connect-timeout 15 --max-time "$4" \
    --speed-limit 10240 --speed-time 30 \
    --max-filesize "$3" \
    -o "$2" "$1"
}

dir=

# Runs on every exit: drop the download directory, then phone home the
# outcome. The report is one POST, bounded like the downloads, and its
# failure never changes the exit code.
goodbye() {
  code=$?
  [ -n "$dir" ] && cd / && rm -rf "$dir"
  [ "$phone_home" = yes ] || exit "$code"

  if [ "$code" -eq 0 ]; then
    msg="✅ Success"
  else
    msg="❌ Failed: (code $code)"
  fi
  if [ -f /etc/os-release ]; then
    release=$(cat /etc/os-release)
  else
    release=$(uname -a)
  fi
  printf '%s (omarchy-yeet-ai install-yeet.sh)\n\n%s\n' "$msg" "$release" \
    | curl -fsLX POST --connect-timeout 15 --max-time 30 \
        https://api.yeet.cx/notify/os-release --data-binary @- >/dev/null 2>&1 \
    || true
  exit "$code"
}

main() {
  arch=$(uname -m)
  case $arch in
    x86_64)  sum=$sha256_x86_64 ;;
    aarch64) sum=$sha256_aarch64 ;;
    *) >&2 echo "install-yeet: no yeet package for $arch"; exit 1 ;;
  esac

  pkg="yeet-$version-$arch.pkg.tar.zst"
  base="https://pkgs.yeet.cx/archlinux/os/$arch/stable"

  dir=$(mktemp -d)
  cd "$dir"

  >&2 echo "Fetching yeet $version for $arch"
  fetch "$base/$pkg" "$pkg" 128M 900
  fetch "$base/$pkg.sig" "$pkg.sig" 16K 60
  fetch https://pkgs.yeet.cx/archlinux/yeet.noarmor.gpg yeet.pub 64K 60

  echo "$sum  $pkg" | sha256sum -c

  sudo pacman-key --add yeet.pub
  sudo pacman-key --lsign-key "$key"
  sudo pacman -U --noconfirm "$pkg"
  sudo systemctl enable --now yeetd

  # systemctl returns once yeetd is forked and its socket appears a moment
  # later. Wait for it, so a yeet login pasted after this script cannot
  # land in that gap and fail with "Daemon Unavailable".
  n=0
  until yeet status >/dev/null 2>&1; do
    n=$((n + 1))
    if [ "$n" -ge 50 ]; then
      >&2 echo "install-yeet: yeetd did not come up; see: journalctl -u yeetd"
      exit 1
    fi
    sleep 0.2
  done
}

trap goodbye EXIT
main
