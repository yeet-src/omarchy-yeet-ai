import QtQuick
import Quickshell.Io
import qs.Commons
import qs.Ui

// <login onDone>  log this host in to yeet, from the panel.
//
// Runs `yeet login`, which mints a one-time code and prints the URL to
// finish it at, and shows that URL — selectable, with a copy button and
// one that opens it in the browser — until the login completes. Then
// `done {ok}` goes up, so the page can carry on with what needed the
// platform. Already logged in, `yeet login` says so and exits at once,
// and `done` follows.
//
// The process is the node's: it is started when the node is built and
// stopped when the node goes away, so a page shows <login> while it
// needs one and drops it when it does not.
Column {
  id: root
  property var client: null
  property int nodeId: 0
  property Item slot: null
  signal ev(string type, var payload)
  /** What a patch may set here; see Yeetkit.setAttr. */
  readonly property var attrs: []

  readonly property bool inRow: parent ? parent.axis === "x" : false
  anchors.left: parent && !inRow ? parent.left : undefined
  anchors.right: parent && !inRow ? parent.right : undefined
  spacing: Style.spacing.xs

  property string url: ""
  property string failure: ""
  property bool copied: false

  /* A spinner turns while the process runs: first for the code, then
   * for the login to finish in the browser. */
  readonly property var frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
  property int frame: 0
  property Timer spin: Timer {
    interval: 100
    repeat: true
    running: root.login.running
    onTriggered: root.frame = (root.frame + 1) % root.frames.length
  }

  property Process login: Process {
    command: ["yeet", "login"]
    /* The URL comes after a QR code drawn in escape sequences; the one
     * line that names it is the one read. */
    stdout: SplitParser {
      onRead: function (line) {
        var match = /Please login at: (\S+)/.exec(line)
        if (match) root.url = match[1]
      }
    }
    stderr: SplitParser {
      onRead: function (line) {
        var text = line.trim()
        if (text !== "") root.failure = text
      }
    }
    onExited: function (code, status) { root.ev("done", { ok: code === 0 }) }
  }

  property Process opener: Process {}

  function openUrl() {
    opener.command = ["xdg-open", root.url]
    opener.running = true
  }

  /* TextEdit.copy() puts the selection on the clipboard: select the
   * line, copy it, drop the selection — no helper process. */
  function copyUrl() {
    field.selectAll()
    field.copy()
    field.deselect()
    root.copied = true
    revert.restart()
  }

  property Timer revert: Timer {
    interval: 1500
    onTriggered: root.copied = false
  }

  Component.onCompleted: login.running = true
  Component.onDestruction: if (login.running) login.signal(15)

  Row {
    width: root.width
    spacing: Style.spacing.sm

    Text {
      visible: root.login.running
      text: root.frames[root.frame]
      color: Color.accent
      font.family: Style.font.family
      font.pixelSize: Style.font.body
    }

    /* The URL is a link: clicking it opens the browser. */
    Text {
      width: root.width - (root.login.running ? x : 0)
      wrapMode: Text.WrapAnywhere
      textFormat: root.url !== "" ? Text.StyledText : Text.PlainText
      text: root.url !== "" ? "<a href=\"" + root.url + "\">" + root.url + "</a>"
          : root.failure !== "" ? root.failure
          : "Getting a login code…"
      color: root.failure !== "" && root.url === "" ? Color.urgent : Color.popups.text
      linkColor: Color.accent
      font.family: Style.font.family
      font.pixelSize: Style.font.body
      onLinkActivated: function (link) { root.openUrl() }
      HoverHandler { cursorShape: root.url !== "" ? Qt.PointingHandCursor : Qt.ArrowCursor }
    }
  }

  Row {
    visible: root.url !== ""
    spacing: Style.spacing.sm

    Text {
      text: "Waiting for the browser…"
      color: Color.popups.text
      font.family: Style.font.family
      font.pixelSize: Style.font.bodySmall
      anchors.verticalCenter: parent.verticalCenter
    }

    Button {
      text: root.copied ? "copied" : "copy link"
      fontSize: Style.font.bodySmall
      horizontalPadding: Style.spacing.sm
      verticalPadding: 0
      tooltipText: "Copy the URL to the clipboard"
      onClicked: root.copyUrl()
    }
  }

  /* Off-screen: the clipboard is reached through TextEdit.copy(), which
   * wants a selection, so the URL is held here for `copy` to select. */
  TextEdit {
    id: field
    visible: false
    readOnly: true
    text: root.url
  }
}
