import QtQuick
import qs.Commons

// <icon tone>  one glyph from the icon font; the child string is the glyph
Text {
  id: root
  property var client: null
  property int nodeId: 0
  property Item slot: null
  signal ev(string type, var payload)
  /** What a patch may set here; see Yeetkit.setAttr. */
  readonly property var attrs: ["tone"]

  property string tone: "fg"

  color: tone === "muted" ? Color.muted
       : tone === "accent" ? Color.accent
       : tone === "urgent" ? Color.urgent
       : tone === "bar" && client && client.bar ? client.bar.barForeground
       : Color.popups.text
  font.family: Style.font.family
  font.pixelSize: Style.font.icon
  renderType: Text.NativeRendering
  textFormat: Text.PlainText
}
