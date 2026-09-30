import QtQuick
import Quickshell.Io
import qs.Commons

// <link href size fill align links>  a run of text that opens a URL in
// the browser when clicked. The label is the child string; `href` is
// what opens. Drawn in the theme's accent, underlined, with a pointing
// cursor — the shell runs xdg-open, since the isolate cannot. An href
// beginning `action:` opens nothing: the click goes up with it, so a
// page can draw a control as a link.
//
// `links` is JSON, `[{ label, href }, …]`: several links in one run,
// separated by spaces, which is how two of them share a right edge.
Text {
  id: root
  property var client: null
  property int nodeId: 0
  property Item slot: null
  signal ev(string type, var payload)

  property string href: ""
  property string links: ""
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
  function one(label, href) { return "<a href=\"" + (href === "" ? "#" : href) + "\">" + label + "</a>" }
  function anchor() {
    if (root.links !== "") {
      var list = []
      try { list = JSON.parse(root.links) } catch (e) { list = [] }
      return list.map(function (l) { return one(String(l.label), String(l.href || "")) }).join("&nbsp;&nbsp;&nbsp;")
    }
    return one(root.label, root.href)
  }
  onTextChanged: {
    if (root.text.indexOf("<a ") === 0) return
    root.label = root.text
    root.text = anchor()
  }
  onHrefChanged: root.text = anchor()
  onLinksChanged: root.text = anchor()
  color: Color.accent
  linkColor: Color.accent
  font.family: Style.font.family
  font.pixelSize: Style.font[size] || Style.font.bodySmall
  font.underline: true
  renderType: Text.NativeRendering
  /* With no href the link is an action: the click goes up and nothing
   * opens, so a page can draw a control as a link. */
  onLinkActivated: function (link) {
    var l = String(link)
    if (l !== "#" && l.indexOf("action:") !== 0) {
      opener.command = ["xdg-open", l]
      opener.running = true
    }
    ev("click", { href: l })
  }
  HoverHandler { cursorShape: Qt.PointingHandCursor }
}
