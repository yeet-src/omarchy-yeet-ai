import QtQuick
import qs.Commons

// <panel contentWidth gap open onOpen onClose onCols>  the popup under
// the bar widget. Children stack; the entry file anchors and frames it.
//
// `cols` goes shell -> app: the width the page can fill, in characters,
// and the same less what a <box> spends on padding and border. The
// shell's font is monospace, so a page that lays itself out as a
// character grid needs this to know how wide to pad — it has no way to
// measure text itself, and the width depends on the user's font size.
// The same event carries `width` and `height`, the pixels the panel
// has, and `availableWidth` and `availableHeight`, the most the shell
// would give it on this screen — so a page that grows can stop before
// it is clipped.
//
// `open` goes app -> shell: set it and the panel is shown or hidden.
// `open`/`close` events go shell -> app, so a page can start a stream
// only while someone is looking.
Item {
  id: root
  property var client: null
  property int nodeId: 0
  property Item slot: inner
  signal ev(string type, var payload)
  /** What a patch may set here; see Yeetkit.setAttr. */
  readonly property var attrs: ["contentWidth", "gap", "open"]

  property int contentWidth: Style.space(280)
  property int gap: Style.spacing.md
  property var open: undefined

  signal openRequested(bool wanted)
  onOpenChanged: if (open === true || open === false) openRequested(open)

  FontMetrics {
    id: metrics
    font.family: Style.font.family
    font.pixelSize: Style.font.body
  }

  readonly property real charWidth: metrics.advanceWidth("0")
  readonly property int cols: charWidth > 0 ? Math.max(1, Math.floor(width / charWidth)) : 0
  readonly property int boxCols: charWidth > 0
    ? Math.max(1, Math.floor((width - Style.spacing.md * 2 - Style.normalBorderWidth * 2) / charWidth))
    : 0

  /* Set by the entry file from the shell's own limits. */
  property real availableWidth: 0
  property real availableHeight: 0

  function report() {
    ev("cols", {
      cols: cols,
      boxCols: boxCols,
      width: width,
      height: height,
      availableWidth: availableWidth,
      availableHeight: availableHeight
    })
  }
  onColsChanged: report()
  onAvailableWidthChanged: report()
  onAvailableHeightChanged: report()

  property bool shown: false
  function shellOpened(isOpen) {
    if (shown === isOpen) return
    shown = isOpen
    ev(isOpen ? "open" : "close", {})
  }

  width: parent ? parent.width : contentWidth
  implicitHeight: inner.implicitHeight
  height: implicitHeight

  Column {
    id: inner
    width: root.width
    spacing: root.gap
  }
}
