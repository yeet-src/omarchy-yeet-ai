import QtQuick
import qs.Commons

// <column gap fill>  children stacked vertically
Column {
  id: root
  property var client: null
  property int nodeId: 0
  property Item slot: root
  signal ev(string type, var payload)
  /** What a patch may set here; see Yeetkit.setAttr. */
  readonly property var attrs: ["gap", "fill"]

  property int gap: Style.spacing.sm
  property bool fill: false
  readonly property bool inRow: parent ? parent.axis === "x" : false

  spacing: gap
  anchors.left: fill && parent && !inRow ? parent.left : undefined
  anchors.right: fill && parent && !inRow ? parent.right : undefined
}
