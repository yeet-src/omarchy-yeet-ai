import QtQuick
import qs.Commons

// <box pad gap fill>  a bordered surface; children stack inside it
Rectangle {
  id: root
  property var client: null
  property int nodeId: 0
  property Item slot: inner
  signal ev(string type, var payload)
  /** What a patch may set here; see Yeetkit.setAttr. */
  readonly property var attrs: ["pad", "gap", "fill"]

  property int pad: Style.spacing.md
  property int gap: Style.spacing.sm
  property bool fill: true

  color: Style.normalFill
  radius: Style.cornerRadius
  border.width: Style.normalBorderWidth
  border.color: Style.normalBorderColor

  readonly property bool inRow: parent ? parent.axis === "x" : false
  anchors.left: fill && parent && !inRow ? parent.left : undefined
  anchors.right: fill && parent && !inRow ? parent.right : undefined
  width: inner.implicitWidth + pad * 2
  implicitHeight: inner.implicitHeight + pad * 2
  height: implicitHeight

  Column {
    id: inner
    x: root.pad
    y: root.pad
    width: root.width - root.pad * 2
    spacing: root.gap
  }
}
