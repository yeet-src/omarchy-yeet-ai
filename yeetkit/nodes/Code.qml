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
Text {
  id: root
  property var client: null
  property int nodeId: 0
  property Item slot: null
  signal ev(string type, var payload)

  property string source: ""

  readonly property bool inRow: parent ? parent.axis === "x" : false
  anchors.left: parent && !inRow ? parent.left : undefined
  anchors.right: parent && !inRow ? parent.right : undefined

  textFormat: Text.StyledText
  wrapMode: Text.WrapAnywhere
  color: Color.popups.text
  font.family: Style.font.family
  font.pixelSize: Style.font.caption
  renderType: Text.NativeRendering
  text: highlight(source)

  function tone(i) {
    var a = Color.accent
    if (i === 0) return a
    if (a.hslSaturation < 0.12) {
      var l = a.hslLightness + (i % 2 === 1 ? -1 : 1) * 0.16 * Math.ceil(i / 2)
      return Qt.hsla(a.hslHue, a.hslSaturation, Math.max(0.25, Math.min(0.9, l)), 1)
    }
    return Qt.hsla((a.hslHue + i * 0.11) % 1, Math.min(1, a.hslSaturation * 0.95), a.hslLightness, 1)
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
