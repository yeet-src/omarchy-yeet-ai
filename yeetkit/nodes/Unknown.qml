import QtQuick

// Any tag without a node of its own. Its children still render, stacked.
Column {
  id: root
  property var client: null
  property int nodeId: 0
  property Item slot: root
  signal ev(string type, var payload)
  /** What a patch may set here; see Yeetkit.setAttr. */
  readonly property var attrs: []

  readonly property bool inRow: parent ? parent.axis === "x" : false
  anchors.left: parent && !inRow ? parent.left : undefined
  anchors.right: parent && !inRow ? parent.right : undefined
}
