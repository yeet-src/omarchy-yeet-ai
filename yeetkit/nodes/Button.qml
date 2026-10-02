import QtQuick
import qs.Ui

// <button iconText selected active bordered tooltipText onClick onContextMenu>
// The label is the child string.
Button {
  id: root
  property var client: null
  property int nodeId: 0
  property Item slot: null
  signal ev(string type, var payload)
  /** What a patch may set here; see Yeetkit.setAttr. */
  readonly property var attrs: ["iconText", "selected", "active", "bordered", "tooltipText", "horizontalPadding", "verticalPadding"]

  onClicked: ev("click", { button: 0 })
  onRightClicked: ev("contextmenu", { button: 2 })
}
