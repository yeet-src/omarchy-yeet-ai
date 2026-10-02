import QtQuick
import qs.Ui

// <toggle label description checked onChange>
// Controlled: the click reports the state the user asked for, and
// `checked` follows whatever the app decides.
Toggle {
  id: root
  property var client: null
  property int nodeId: 0
  property Item slot: null
  signal ev(string type, var payload)
  /** What a patch may set here; see Yeetkit.setAttr. */
  readonly property var attrs: ["label", "description", "checked"]

  readonly property bool inRow: parent ? parent.axis === "x" : false
  anchors.left: parent && !inRow ? parent.left : undefined
  anchors.right: parent && !inRow ? parent.right : undefined

  onClicked: ev("change", { checked: !checked })
}
