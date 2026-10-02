import QtQuick
import qs.Commons

// <scroll maxHeight gap>  children stack; past maxHeight the list scrolls
Flickable {
  id: root
  property var client: null
  property int nodeId: 0
  property Item slot: inner
  signal ev(string type, var payload)
  /** What a patch may set here; see Yeetkit.setAttr. */
  readonly property var attrs: ["maxHeight", "gap"]

  property int maxHeight: Style.space(320)
  property int gap: Style.spacing.sm

  readonly property bool inRow: parent ? parent.axis === "x" : false
  anchors.left: parent && !inRow ? parent.left : undefined
  anchors.right: parent && !inRow ? parent.right : undefined
  width: inner.implicitWidth
  implicitHeight: Math.min(inner.implicitHeight, maxHeight)
  height: implicitHeight
  contentWidth: width
  contentHeight: inner.implicitHeight
  clip: true
  boundsBehavior: Flickable.StopAtBounds

  /* The wheel stays with this scroll while it has anywhere to go: a
   * Flickable hands the wheel on to its parent once it reaches an end,
   * which for a short box under a trackpad happens almost at once and
   * reads as the whole panel jumping. Nested scrolls stop that here. */
  WheelHandler {
    enabled: root.contentHeight > root.height + 1
    acceptedDevices: PointerDevice.Mouse | PointerDevice.TouchPad
    target: null
    onWheel: function (event) {
      var dy = event.pixelDelta.y !== 0 ? event.pixelDelta.y : (event.angleDelta.y / 120) * 40
      root.contentY = Math.max(0, Math.min(root.contentHeight - root.height, root.contentY - dy))
      event.accepted = true
    }
  }

  Column {
    id: inner
    width: root.width
    spacing: root.gap
  }
}
