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

  readonly property bool inRow: parent ? parent.axis === "x" : false
  anchors.left: parent && !inRow ? parent.left : undefined
  anchors.right: parent && !inRow ? parent.right : undefined
  spacing: Style.spacing.xs

  property string url: ""
  property string failure: ""
  property bool copied: false

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

  Text {
    width: root.width
    wrapMode: Text.WordWrap
    text: root.url !== "" ? "Log in at"
        : root.failure !== "" ? root.failure
        : "Getting a login code…"
    color: root.failure !== "" && root.url === "" ? Color.urgent : Color.popups.text
    font.family: Style.font.family
    font.pixelSize: Style.font.bodySmall
  }

  TextEdit {
    id: field
    width: root.width
    visible: root.url !== ""
    readOnly: true
    selectByMouse: true
    textFormat: TextEdit.PlainText
    wrapMode: TextEdit.WrapAnywhere
    text: root.url
    color: Color.accent
    font.family: Style.font.family
    font.pixelSize: Style.font.body
  }

  Row {
    visible: root.url !== ""
    spacing: Style.spacing.sm

    Button {
      text: "open"
      fontSize: Style.font.bodySmall
      horizontalPadding: Style.spacing.sm
      verticalPadding: 0
      tooltipText: "Open the login page in the browser"
      onClicked: root.openUrl()
    }

    Button {
      text: root.copied ? "copied" : "copy"
      fontSize: Style.font.bodySmall
      horizontalPadding: Style.spacing.sm
      verticalPadding: 0
      tooltipText: "Copy the URL to the clipboard"
      onClicked: root.copyUrl()
    }
  }
}
