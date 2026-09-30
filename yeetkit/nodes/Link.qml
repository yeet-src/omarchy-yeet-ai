import QtQuick
import Quickshell.Io
import qs.Commons

// <link href size>  a run of text that opens a URL in the browser when
// clicked. The label is the child string; `href` is what opens. Drawn
// in the theme's accent, underlined, with a pointing cursor — the shell
// runs xdg-open, since the isolate cannot.
Text {
  id: root
  property var client: null
  property int nodeId: 0
  property Item slot: null
  signal ev(string type, var payload)

  property string href: ""
  property string size: "bodySmall"

  readonly property bool inRow: parent ? parent.axis === "x" : false
  anchors.verticalCenter: inRow && parent ? parent.verticalCenter : undefined

  property Process opener: Process {}

  textFormat: Text.StyledText
  text: "<a href=\"" + href + "\">" + label + "</a>"
  /* The client sets `text` from the child string; it is kept here and
   * the anchor rebuilt around it. */
  property string label: ""
  onTextChanged: if (!text.startsWith("<a ")) { label = text }
  color: Color.accent
  linkColor: Color.accent
  font.family: Style.font.family
  font.pixelSize: Style.font[size] || Style.font.bodySmall
  font.underline: true
  renderType: Text.NativeRendering
  onLinkActivated: function (link) {
    opener.command = ["xdg-open", String(link)]
    opener.running = true
    ev("click", { href: link })
  }
  HoverHandler { cursorShape: Qt.PointingHandCursor }
}
