import QtQuick
import qs.Commons

// <code source>  a run of JavaScript, highlighted.
//
// Comments, strings, keywords and numbers each take a colour drawn from
// the theme's accent — the accent itself for keywords, hues turned from
// it for the rest, lightness steps on a monochrome theme — so the code
// reads as code and still belongs to the theme. Everything else is the
// popup's text colour. The source is escaped before any markup is added,
// so nothing in it can become markup of its own.
//
// An Item around a Text rather than a Text: the client sets a node's
// `text` from its text children, and this node has none, so a Text at
// the root would have its highlighted text set to nothing.
Item {
  id: root
  property var client: null
  property int nodeId: 0
  property Item slot: null
  signal ev(string type, var payload)

  property string source: ""

  readonly property bool inRow: parent ? parent.axis === "x" : false
  anchors.left: parent && !inRow ? parent.left : undefined
  anchors.right: parent && !inRow ? parent.right : undefined
  implicitWidth: body.implicitWidth
  implicitHeight: body.implicitHeight
  height: implicitHeight

  Text {
    id: body
    width: root.width
    textFormat: Text.StyledText
    wrapMode: Text.WrapAnywhere
    color: Color.popups.text
    font.family: Style.font.family
    font.pixelSize: Style.font.caption
    renderType: Text.NativeRendering
    text: root.highlight(root.source)
  }

  /* Series i: the accent, then colours that stay in its family — hues a
   * few steps either side of it, alternating lighter and darker — so a
   * chart of five series still reads as one theme. A monochrome accent
   * has no hue to turn, so those steps are in lightness alone. */
  readonly property var hueSteps: [0, 0.05, -0.06, 0.10, -0.12, 0.15, -0.18, 0.20]
  readonly property var lightSteps: [0, 0.16, -0.12, 0.24, -0.18, 0.08, -0.06, 0.18]
  readonly property var greyLadder: [0, 0.58, 0.34, 0.76, 0.46, 0.88, 0.26, 0.66]
  function tone(i) {
    var a = Color.accent
    if (i === 0) return a
    var k = i % hueSteps.length
    /* A monochrome accent may sit at either end of the lightness range,
     * where steps from it would all clamp to one grey — so its series
     * take a fixed ladder of greys, far enough apart to tell. */
    if (a.hslSaturation < 0.12) return Qt.hsla(a.hslHue, a.hslSaturation, greyLadder[k], 1)
    var l = Math.max(0.28, Math.min(0.88, a.hslLightness + lightSteps[k]))
    var hue = (a.hslHue + hueSteps[k] + 1) % 1
    return Qt.hsla(hue, Math.min(1, a.hslSaturation), l, 1)
  }

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  }

  /* Whitespace survives styled text only as entities: a run of spaces
   * becomes non-breaking ones, a newline a break. */
  function space(s) {
    return s.replace(/\n/g, "<br>").replace(/ {2,}/g, function (m) { return m.replace(/ /g, "&nbsp;") })
  }

  readonly property var pattern: new RegExp(
    "(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)"
    + "|(`(?:\\\\.|[^`])*`|\"(?:\\\\.|[^\"\\n])*\"|'(?:\\\\.|[^'\\n])*')"
    + "|\\b(const|let|var|function|return|if|else|for|while|do|of|in|new|await|async|null|undefined|true|false|typeof|instanceof|try|catch|finally|throw|class|this|switch|case|break|continue|default|yield|import|export|from)\\b"
    + "|\\b(\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?)\\b",
    "g")

  function highlight(src) {
    var out = ""
    var last = 0
    var text = String(src)
    pattern.lastIndex = 0
    var m
    while ((m = pattern.exec(text)) !== null) {
      out += space(escapeHtml(text.slice(last, m.index)))
      var color = m[1] !== undefined ? tone(3)
                : m[2] !== undefined ? tone(1)
                : m[3] !== undefined ? tone(0)
                : tone(2)
      out += "<font color=\"" + color.toString() + "\">" + space(escapeHtml(m[0])) + "</font>"
      last = m.index + m[0].length
      if (m[0].length === 0) pattern.lastIndex += 1
    }
    out += space(escapeHtml(text.slice(last)))
    return out
  }
}
