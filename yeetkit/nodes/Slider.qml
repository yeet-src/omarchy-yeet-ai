import QtQuick
import qs.Ui

// <slider value minimum maximum step integer onInput onChange>
// `input` fires while dragging, `change` on release — both carry `value`.
PanelSlider {
  id: root
  property var client: null
  property int nodeId: 0
  property Item slot: null
  signal ev(string type, var payload)
  /** What a patch may set here; see Yeetkit.setAttr. */
  readonly property var attrs: ["value", "minimum", "maximum", "step", "integer"]

  bar: client ? client.bar : null
  readonly property bool inRow: parent ? parent.axis === "x" : false
  anchors.left: parent && !inRow ? parent.left : undefined
  anchors.right: parent && !inRow ? parent.right : undefined

  onMoved: function (next) { ev("input", { value: next }) }
  onReleased: function (next) { ev("change", { value: next }) }
}
