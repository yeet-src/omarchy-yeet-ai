import QtQuick
import qs.Commons

// <spacer size>  empty room
Item {
  id: root
  property var client: null
  property int nodeId: 0
  property Item slot: null
  signal ev(string type, var payload)
  /** What a patch may set here; see Yeetkit.setAttr. */
  readonly property var attrs: ["size"]

  property int size: Style.spacing.md

  width: size
  height: size
}
