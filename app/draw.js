/* Drawing on a character grid.
 *
 * The shell's font is monospace and the panel reports how many columns
 * it can hold, so every chart here is a list of strings that are each
 * exactly `width` characters. A braille cell is a 2x4 dot matrix, so
 * one line of N characters holds 2N samples and R lines stack into 4R
 * vertical levels — how btop fits a dense graph into a few rows.
 */

const LEFT = [0x01, 0x02, 0x04, 0x40]; /* dots 1,2,3,7 — top to bottom */
const RIGHT = [0x08, 0x10, 0x20, 0x80]; /* dots 4,5,6,8 */

/* Right-aligned: the newest sample belongs in the last cell, so a
 * series with less history than the chart is wide fills from the right
 * edge leftwards. */
const windowOf = (samples, slots) =>
  samples.length >= slots
    ? samples.slice(-slots)
    : Array(slots - samples.length).fill(undefined).concat(samples);

export function braille(samples, width, lo, hi, rows = 4) {
  const levels = rows * 4;
  const span = hi - lo || 1;
  const window = windowOf(samples, width * 2);
  const lines = [];
  for (let r = 0; r < rows; r++) {
    let line = "";
    for (let x = 0; x < width; x++) {
      let bits = 0;
      for (let col = 0; col < 2; col++) {
        const value = window[x * 2 + col];
        if (value === undefined || !Number.isFinite(value)) continue;
        /* Floored at one level so a near-zero sample still draws the
         * baseline rather than a gap. */
        const ratio = Math.max(0, Math.min(1, (value - lo) / span));
        const fill = Math.max(1, Math.round(ratio * levels));
        const dots = col === 0 ? LEFT : RIGHT;
        for (let k = 0; k < 4; k++) {
          const depth = r * 4 + k;
          if (levels - depth <= fill) bits |= dots[k];
        }
      }
      line += String.fromCharCode(0x2800 + bits);
    }
    lines.push(line);
  }
  return lines;
}

/* Top row hottest, bottom row coolest, floored well above 0 so the
 * lowest row never lands on `muted` and fades out. */
export const rowHeat = (r, rows) => (rows <= 1 ? 1 : 1 - 0.55 * (r / (rows - 1)));

/* The axis a series is drawn on. Fixed where the block says so;
 * otherwise the window's own min..max with a little air, and a floor on
 * the span so sampling noise cannot fill the frame. */
export function axis(samples, min, max) {
  const fixedLo = Number.isFinite(min) ? min : null;
  const fixedHi = Number.isFinite(max) ? max : null;
  if (fixedLo !== null && fixedHi !== null) return { lo: fixedLo, hi: fixedHi };

  const seen = samples.filter(Number.isFinite);
  if (!seen.length) return { lo: fixedLo ?? 0, hi: fixedHi ?? 1 };
  let lo = fixedLo ?? Math.min.apply(null, seen);
  let hi = fixedHi ?? Math.max.apply(null, seen);
  if (hi - lo === 0) {
    const pad = Math.abs(hi) * 0.1 || 1;
    if (fixedLo === null) lo -= pad;
    if (fixedHi === null) hi += pad;
  } else {
    const pad = (hi - lo) * 0.15;
    if (fixedLo === null) lo -= pad;
    if (fixedHi === null) hi += pad;
  }
  /* A quantity that is never negative keeps a zero floor: a chart of
   * bytes per second dipping below zero says nothing true. */
  if (fixedLo === null && lo < 0 && seen.every((v) => v >= 0)) lo = 0;
  return { lo, hi };
}

/* Horizontal bars for a ranking: label, a bar scaled to the largest
 * row, the value. Eighth-block characters give a smooth edge. */
const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

export function bars(rows, width, unit) {
  if (!rows.length) return [];
  const labelW = Math.max(6, Math.min(18, Math.floor(width / 3)));
  const valueW = Math.max(...rows.map((row) => fmt(row.value, unit).length), 4);
  const barW = Math.max(4, width - labelW - 1 - valueW - 1);
  const peak = Math.max(...rows.map((row) => Math.max(0, Number(row.value) || 0)), 1e-9);
  return rows.map((row) => {
    const share = Math.max(0, Number(row.value) || 0) / peak;
    const cells = share * barW;
    const full = Math.floor(cells);
    const rest = Math.round((cells - full) * 8);
    const bar = ("█".repeat(full) + (rest > 0 && full < barW ? EIGHTHS[rest] : "")).padEnd(barW);
    return `${clip(String(row.label ?? ""), labelW)} ${bar} ${fmt(row.value, unit).padStart(valueW)}`;
  });
}

export const clip = (text, width) =>
  (text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text).padEnd(width);

/* A number, short enough for a column. `unit` is what the block
 * declared: `B` formats bytes, `%` a percentage, anything else is a
 * suffix. */
export function fmt(value, unit) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "–";
  const n = Number(value);
  if (unit === "B" || unit === "bytes") return bytes(n);
  if (unit === "B/s") return `${bytes(n)}/s`;
  if (unit === "%") return `${n >= 10 || n === 0 ? n.toFixed(0) : n.toFixed(1)}%`;
  return `${compact(n)}${unit && unit !== true ? unit : ""}`;
}

export function bytes(n) {
  const abs = Math.abs(n);
  if (abs >= 1073741824) return `${(n / 1073741824).toFixed(1)}G`;
  if (abs >= 1048576) return `${(n / 1048576).toFixed(abs >= 104857600 ? 0 : 1)}M`;
  if (abs >= 1024) return `${(n / 1024).toFixed(0)}K`;
  return `${Math.round(n)}B`;
}

export function compact(n) {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}G`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e4) return `${(n / 1e3).toFixed(0)}k`;
  if (abs >= 100) return n.toFixed(0);
  if (abs >= 10) return n.toFixed(1);
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2);
}

/* `left` and a right-aligned `right`, exactly `width` characters, the
 * left side eliding first. */
export function line(left, right, width) {
  const r = String(right ?? "");
  const room = Math.max(1, width - r.length - 1);
  return `${clip(String(left ?? ""), room)} ${r}`;
}
