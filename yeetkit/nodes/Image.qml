import QtQuick

// <image src size> — `src` is a data: image or a file under the plugin
// folder; the client refuses anything else (see Yeetkit.assetUrl).
Image {
  id: root
  property var client: null
  property int nodeId: 0
  property Item slot: null
  signal ev(string type, var payload)

  property string src: ""
  property int size: 0

  source: client ? client.assetUrl(src) : ""
  width: size > 0 ? size : implicitWidth
  height: size > 0 ? size : implicitHeight
  fillMode: Image.PreserveAspectFit
  asynchronous: true
}
