import QtQuick
import Quickshell.Io
import qs.Commons

// <link href size fill align>  a run of text that opens a URL in the browser when
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
  property bool fill: false
  property string align: "left"

  readonly property bool inRow: parent ? parent.axis === "x" : false
  anchors.verticalCenter: inRow && parent ? parent.verticalCenter : undefined
  /* In a column, `fill` takes the width and `align` places the label in it. */
  anchors.left: fill && parent && !inRow ? parent.left : undefined
  anchors.right: fill && parent && !inRow ? parent.right : undefined
  horizontalAlignment: align === "right" ? Text.AlignRight : align === "center" ? Text.AlignHCenter : Text.AlignLeft

  property Process opener: Process {}

  textFormat: Text.StyledText
  /* The client assigns `text` from the child string, which replaces
   * any binding — so the label is kept aside and the anchor written
   * back over it. */
  property string label: ""
  function anchor() { return "<a href=\"" + root.href + "\">" + root.label + "</a>" }
  onTextChanged: {
    if (root.text.indexOf("<a ") === 0) return
    root.label = root.text
    root.text = anchor()
  }
  onHrefChanged: root.text = anchor()
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
