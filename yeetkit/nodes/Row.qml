import QtQuick
import qs.Commons

// <row gap fill>  children side by side
Row {
  id: root
  property var client: null
  property int nodeId: 0
  property Item slot: root
  signal ev(string type, var payload)
  /** What a patch may set here; see Yeetkit.setAttr. */
  readonly property var attrs: ["gap", "fill"]

  property int gap: Style.spacing.sm
  property bool fill: false
  /* Children read this to tell a Row from a Column: inside a Row the
   * horizontal anchors are not allowed, and "fill" means the remaining
   * width rather than all of it. */
  readonly property string axis: "x"
  readonly property bool inRow: parent ? parent.axis === "x" : false

  spacing: gap
  /* Stretching is done with anchors, not a width binding: binding a
   * child's width to a positioner parent's width loops. */
  anchors.left: fill && parent && !inRow ? parent.left : undefined
  anchors.right: fill && parent && !inRow ? parent.right : undefined
}
