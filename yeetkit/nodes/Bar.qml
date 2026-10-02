import QtQuick
import qs.Commons
import qs.Ui

// <bar tooltipText active dimmed heat image onClick onWheel>  the
// widget in the bar.
// Its children are strings — the label — and it borrows every bit of
// chrome from the host's own WidgetButton: hover, tooltip, click
// registration, vertical bars.
//
// `image` is a path under the plugin folder (`assets/logo.png`); set,
// it is drawn at the left of the label, scaled to the bar, and the host
// button's own label stands aside for a row of the two.
//
// `heat` is 0..1 and colours the label from the theme — 0 is `muted`,
// 0.5 `accent`, 1 `urgent` — the same scale <text heat> uses. It
// applies to the whole label, because the host draws it as one Text:
// there is no way to colour part of a bar item.
WidgetButton {
  id: root
  property var client: null
  property int nodeId: 0
  property Item slot: null
  signal ev(string type, var payload)
  /** What a patch may set here; see Yeetkit.setAttr. */
  readonly property var attrs: ["tooltipText", "active", "dimmed", "heat", "image"]

  bar: client ? client.bar : null

  property real heat: -1
  property string image: ""
  /* Under the plugin folder, and nowhere else: the client checks. */
  readonly property url imageUrl: image !== "" && client ? client.assetUrl(image) : ""

  labelVisible: image === ""
  hasVisualContent: text !== "" || image !== ""
  fixedWidth: image !== "" ? content.implicitWidth + scaledHorizontalMargin * 2 : -1

  Row {
    id: content
    anchors.centerIn: parent
    spacing: text !== "" ? 6 : 0
    visible: root.image !== ""

    Image {
      source: root.imageUrl
      height: root.barSize - 8
      width: height
      anchors.verticalCenter: parent.verticalCenter
      fillMode: Image.PreserveAspectFit
      smooth: true
      mipmap: true
      asynchronous: true
    }

    Text {
      visible: root.text !== ""
      anchors.verticalCenter: parent.verticalCenter
      textFormat: Text.PlainText
      text: root.text
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: root.fontSize
      renderType: Text.NativeRendering
    }
  }

  function mixColor(a, b, t) {
    return Qt.rgba(a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t,
                   a.b + (b.b - a.b) * t, a.a + (b.a - a.a) * t)
  }

  readonly property color heatColor: heat < 0.5
    ? mixColor(Color.muted, Color.accent, Math.max(0, heat) * 2)
    : mixColor(Color.accent, Color.urgent, (Math.min(1, heat) - 0.5) * 2)

  foreground: heat >= 0 ? heatColor : (bar ? bar.barForeground : Color.foreground)

  onPressed: function (button) {
    ev("click", { button: button === Qt.LeftButton ? 0 : button === Qt.MiddleButton ? 1 : 2 })
  }
  onWheelMoved: function (delta) { ev("wheel", { delta: delta }) }
}
