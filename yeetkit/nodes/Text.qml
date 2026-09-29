import QtQuick
import qs.Commons

// <text tone size bold fill wrap align>  a run of text; children are strings
//
//   tone   fg | muted | accent | urgent | bar        (or color="#hex")
//   size   caption | bodySmall | body | subtitle | title | heading | display | displayLarge
//   fill   in a column: the full width; in a row: whatever the other
//          children leave — one per row
//   heat   0..1, a colour taken from the theme rather than named: 0 is
//          `muted`, 0.5 is `accent`, 1 is `urgent`, interpolated. Lets a
//          page draw a gradient that still follows the user's theme.
//          Set it and it wins over `tone`; leave it unset (-1) and
//          nothing changes.
Text {
  id: root
  property var client: null
  property int nodeId: 0
  property Item slot: null
  signal ev(string type, var payload)

  property string tone: "fg"
  property string size: "body"
  property bool bold: false
  property bool fill: false
  property bool wrap: false
  property string align: "left"
  property real heat: -1

  function mixColor(a, b, t) {
    return Qt.rgba(a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t,
                   a.b + (b.b - a.b) * t, a.a + (b.a - a.a) * t)
  }

  /* Two segments, so `accent` sits at the midpoint and a theme that
   * makes accent equal to foreground still ramps to urgent. */
  readonly property color heatColor: heat < 0.5
    ? mixColor(Color.muted, Color.accent, Math.max(0, heat) * 2)
    : mixColor(Color.accent, Color.urgent, (Math.min(1, heat) - 0.5) * 2)

  readonly property bool inRow: parent ? parent.axis === "x" : false

  anchors.left: fill && parent && !inRow ? parent.left : undefined
  anchors.right: fill && parent && !inRow ? parent.right : undefined
  /* In a row, level with the buttons beside it rather than top-aligned. */
  anchors.verticalCenter: inRow && parent ? parent.verticalCenter : undefined
  width: fill && inRow ? remaining() : implicitWidth
  wrapMode: wrap ? Text.WordWrap : Text.NoWrap
  elide: !wrap && fill ? Text.ElideRight : Text.ElideNone

  /* The row's width less every sibling and the gaps between them. Reads
   * the siblings' widths, so it follows them. */
  function remaining() {
    var row = parent
    if (!row) return implicitWidth
    var used = 0
    var shown = 0
    for (var i = 0; i < row.children.length; i++) {
      var kid = row.children[i]
      if (!kid.visible) continue
      shown += 1
      if (kid !== root) used += kid.width
    }
    return Math.max(0, row.width - used - row.spacing * Math.max(0, shown - 1))
  }
  color: heat >= 0 ? heatColor
       : tone === "muted" ? Color.muted
       : tone === "accent" ? Color.accent
       : tone === "urgent" ? Color.urgent
       : tone === "bar" && client && client.bar ? client.bar.barForeground
       : Color.popups.text
  font.family: Style.font.family
  font.pixelSize: Style.font[size] || Style.font.body
  font.bold: bold
  horizontalAlignment: align === "center" ? Text.AlignHCenter : align === "right" ? Text.AlignRight : Text.AlignLeft
  renderType: Text.NativeRendering
  textFormat: Text.PlainText
}
