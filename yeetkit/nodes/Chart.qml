import QtQuick
import qs.Commons

// <chart kind payload min max unit chartWidth chartHeight>  a drawn chart.
//
// `payload` is JSON, one of three shapes:
//   { series: { name: [numbers…] } }   readings over time, newest last
//   { bars: [{ label, value }] }        a ranking, or the parts of a whole
//   { points: [{ x, y }] }              a scatter
//
// `kind` says how it is drawn. Over time: `area` (one series, filled),
// `line`, `overlay` (several lines on one axis), `stacked` (bands of a
// whole), `split` (a strip per series, each on its own axis), `heat`
// (a row per series, cells shaded by value), `gauge` (the latest
// value as an arc), `stat` (the latest value as a figure over a
// sparkline), `sparks` (a table: name, sparkline, latest value, one row
// per series), `meters` (a vertical meter per series, at its latest
// value). Of bars: `bars` (horizontal, ranked), `pie` (a donut with a
// legend) or `meters` (a vertical meter per row). Of points: `scatter`.
//
// The marks follow one quiet spec: 2px lines with ringed end-markers,
// area fills as a wash, bars no thicker than 24px with a rounded
// data-end and a square base, a 2px gap of surface between touching
// fills, hairline solid gridlines, and text always in the popup's ink
// with a coloured mark beside it for identity.
//
// Every colour comes from the theme. Series take the accent and hues
// turned from it; on a monochrome theme they step in lightness instead.
// A new sample slides in from the right, a changed bar or sector eases
// to its new size, and the head of a live line pulses.
Item {
  id: root
  property var client: null
  property int nodeId: 0
  property Item slot: null
  signal ev(string type, var payload)

  property string kind: "area"
  property string payload: "{}"
  property string min: ""
  property string max: ""
  property string unit: ""
  property int chartWidth: Style.space(400)
  property int chartHeight: Style.space(110)

  readonly property bool inRow: parent ? parent.axis === "x" : false
  width: chartWidth
  implicitWidth: chartWidth
  height: chartHeight
  implicitHeight: chartHeight

  /* What is drawn, and what was drawn before it, so a change eases
   * between the two. */
  property var shown: ({})
  property var prev: ({})
  property real t: 1
  property bool first: true

  onPayloadChanged: {
    var next = {}
    try { next = JSON.parse(payload) } catch (e) { next = {} }
    prev = shown
    shown = next
    tween.restart()
  }
  onKindChanged: canvas.requestPaint()
  onMinChanged: canvas.requestPaint()
  onMaxChanged: canvas.requestPaint()
  onUnitChanged: canvas.requestPaint()
  onTChanged: canvas.requestPaint()

  NumberAnimation {
    id: tween
    target: root
    property: "t"
    from: 0
    to: 1
    duration: 450
    easing.type: Easing.OutCubic
    onStopped: root.first = false
  }

  /* The pulse at the head of a live line: a ring that grows and fades,
   * on its own clock while the chart is on screen. */
  property real pulse: 0
  readonly property bool live: !!(shown.series && Object.keys(shown.series).length)
  Timer {
    interval: 40
    repeat: true
    running: root.visible && root.live && ["heat", "gauge", "stat", "meters"].indexOf(root.kind) < 0
    onTriggered: {
      root.pulse = (root.pulse + 0.025) % 1
      canvas.requestPaint()
    }
  }

  // ---- colour ---------------------------------------------------------

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
  function alpha(c, a) { return Qt.rgba(c.r, c.g, c.b, a) }
  function css(c) { return c.toString() }

  // ---- numbers --------------------------------------------------------

  function lerp(a, b, k) { return a + (b - a) * k }

  function fmt(v) {
    if (v === null || v === undefined || !isFinite(v)) return "–"
    var u = root.unit
    if (u === "B" || u === "bytes") return bytes(v)
    if (u === "B/s") return bytes(v) + "/s"
    if (u === "%") return (Math.abs(v) >= 10 || v === 0 ? v.toFixed(0) : v.toFixed(1)) + "%"
    return compact(v) + u
  }
  function bytes(n) {
    var a = Math.abs(n)
    if (a >= 1073741824) return (n / 1073741824).toFixed(1) + "G"
    if (a >= 1048576) return (n / 1048576).toFixed(a >= 104857600 ? 0 : 1) + "M"
    if (a >= 1024) return (n / 1024).toFixed(0) + "K"
    return Math.round(n) + "B"
  }
  function compact(n) {
    var a = Math.abs(n)
    if (a >= 1e9) return (n / 1e9).toFixed(1) + "G"
    if (a >= 1e6) return (n / 1e6).toFixed(1) + "M"
    if (a >= 1e4) return (n / 1e3).toFixed(0) + "k"
    if (a >= 100) return n.toFixed(0)
    if (a >= 10) return n.toFixed(1)
    if (n === Math.round(n)) return String(n)
    return n.toFixed(2)
  }

  /* The axis: fixed where the block said so, else the data's own
   * min–max with a little air, floored at zero for data that never
   * goes below it. */
  function axis(values) {
    var fixedLo = root.min !== "" && isFinite(Number(root.min)) ? Number(root.min) : null
    var fixedHi = root.max !== "" && isFinite(Number(root.max)) ? Number(root.max) : null
    if (fixedLo !== null && fixedHi !== null) return { lo: fixedLo, hi: fixedHi }
    var seen = values.filter(function (v) { return v !== null && v !== undefined && isFinite(v) })
    if (!seen.length) return { lo: fixedLo !== null ? fixedLo : 0, hi: fixedHi !== null ? fixedHi : 1 }
    var lo = fixedLo !== null ? fixedLo : Math.min.apply(null, seen)
    var hi = fixedHi !== null ? fixedHi : Math.max.apply(null, seen)
    var pad = hi - lo === 0 ? (Math.abs(hi) * 0.1 || 1) : (hi - lo) * 0.15
    if (fixedLo === null) lo -= pad
    if (fixedHi === null) hi += pad
    var nonNegative = seen.every(function (v) { return v >= 0 })
    if (fixedLo === null && lo < 0 && nonNegative) lo = 0
    return { lo: lo, hi: hi }
  }

  function names() { return shown.series ? Object.keys(shown.series) : [] }
  function series(name) {
    var s = shown.series && shown.series[name]
    return Array.isArray(s) ? s : []
  }
  function prevSeries(name) {
    var s = prev.series && prev.series[name]
    return Array.isArray(s) ? s : []
  }
  function last(list) { return list.length ? list[list.length - 1] : null }

  // ---- hover ----------------------------------------------------------

  /* Where the pointer is over the chart, or null. Each kind reads it
   * while painting and draws what is under it: a sample and every
   * series' value there, a bar's figure, a sector's share, a cell. */
  property var hover: null
  MouseArea {
    anchors.fill: parent
    hoverEnabled: true
    acceptedButtons: Qt.NoButton
    onPositionChanged: function (mouse) { root.hover = { x: mouse.x, y: mouse.y }; canvas.requestPaint() }
    onExited: { root.hover = null; canvas.requestPaint() }
  }

  // ---- painting -------------------------------------------------------

  Canvas {
    id: canvas
    anchors.fill: parent
    renderStrategy: Canvas.Cooperative

    readonly property int pad: 6
    readonly property color surface: Color.popups.background
    readonly property real captionPx: Style.font.caption
    readonly property real bodyPx: Style.font.body
    readonly property string family: Style.font.family

    onPaint: {
      var ctx = getContext("2d")
      ctx.reset()
      ctx.clearRect(0, 0, width, height)
      ctx.font = captionPx + "px " + family
      ctx.textBaseline = "middle"
      var k = root.kind
      if (root.shown.points) paintScatter(ctx)
      else if (root.shown.bars) { if (k === "pie") paintPie(ctx); else if (k === "meters") paintMeters(ctx); else paintBars(ctx) }
      else if (k === "gauge") paintGauge(ctx)
      else if (k === "stat") paintStat(ctx)
      else if (k === "heat") paintHeat(ctx)
      else if (k === "meters") paintMeters(ctx)
      else if (k === "sparks") paintSparks(ctx)
      else if (k === "split") paintSplit(ctx)
      else paintTime(ctx)
    }

    function text(ctx, s, x, y, color, align, px) {
      ctx.font = (px || captionPx) + "px " + family
      ctx.fillStyle = root.css(color || Color.popups.text)
      ctx.textAlign = align || "left"
      ctx.fillText(s, x, y)
    }

    /* Faint rules at the quarter lines, and the axis figures. */
    function frame(ctx, x, y, w, h, band) {
      ctx.strokeStyle = root.css(root.alpha(Color.popups.text, 0.10))
      ctx.lineWidth = 1
      for (var i = 1; i < 4; i++) {
        var yy = Math.round(y + h * i / 4) + 0.5
        ctx.beginPath(); ctx.moveTo(x, yy); ctx.lineTo(x + w, yy); ctx.stroke()
      }
      text(ctx, root.fmt(band.hi), x + 2, y - captionPx * 0.6 - 2, root.alpha(Color.popups.text, 0.85))
      text(ctx, root.fmt(band.lo), x + 2, y + h - captionPx * 0.7, root.alpha(Color.popups.text, 0.85))
    }
    /* The caption row: figures and legend live above the plot, never on it. */
    readonly property real captionRow: captionPx + 6

    /* x for sample i of n. The step is fixed — the window is 120 samples
     * wide whatever has arrived — and the newest sample sits at the right
     * edge, so a young chart streams in from the right rather than
     * stretching what it has across the width. A new sample starts a
     * step to the right of the edge and eases in. */
    readonly property int windowSamples: 120
    function xOf(i, n, x, w) {
      var step = w / (windowSamples - 1)
      return x + w - (n - 1 - i) * step + (root.first || n <= 1 ? 0 : (1 - root.t) * step)
    }
    function yOf(v, band, y, h) {
      var r = (v - band.lo) / ((band.hi - band.lo) || 1)
      return y + h - Math.max(0, Math.min(1, r)) * h
    }

    function path(ctx, values, band, x, y, w, h) {
      var n = values.length
      var started = false
      for (var i = 0; i < n; i++) {
        var v = values[i]
        if (v === null || v === undefined || !isFinite(v)) { started = false; continue }
        var px = xOf(i, n, x, w), py = yOf(v, band, y, h)
        if (!started) { ctx.moveTo(px, py); started = true } else ctx.lineTo(px, py)
      }
    }

    function head(ctx, values, band, x, y, w, h, color) {
      var v = root.last(values)
      if (v === null || !isFinite(v)) return
      var px = xOf(values.length - 1, values.length, x, w), py = yOf(v, band, y, h)
      var p = root.pulse
      ctx.beginPath()
      ctx.arc(px, py, 3 + p * 9, 0, Math.PI * 2)
      ctx.fillStyle = root.css(root.alpha(color, (1 - p) * 0.35))
      ctx.fill()
      ctx.beginPath()
      ctx.arc(px, py, 6, 0, Math.PI * 2)
      ctx.fillStyle = root.css(surface)
      ctx.fill()
      ctx.beginPath()
      ctx.arc(px, py, 4, 0, Math.PI * 2)
      ctx.fillStyle = root.css(color)
      ctx.fill()
    }

    /* Right-aligned, after the axis figure. Entries that do not fit
     * lose their figures first, then the tail is cut. */
    function legend(ctx, entries, x, y, w) {
      ctx.font = captionPx + "px " + family
      var room = w - 44
      var widthOf = function (key) {
        return entries.reduce(function (sum, e) { return sum + ctx.measureText(e[key]).width + 19 }, 0)
      }
      var key = widthOf("text") <= room ? "text" : "name"
      var shown = entries.slice()
      while (shown.length > 1 && shown.reduce(function (sum, e) { return sum + ctx.measureText(e[key]).width + 19 }, 0) > room) shown.pop()
      var cx = x + w
      for (var i = shown.length - 1; i >= 0; i--) {
        var label = shown[i][key]
        cx -= ctx.measureText(label).width
        text(ctx, label, cx, y, Color.popups.text)
        cx -= 9
        ctx.beginPath(); ctx.arc(cx + 2, y, 3, 0, Math.PI * 2)
        ctx.fillStyle = root.css(shown[i].color); ctx.fill()
        cx -= 10
      }
    }

    function paintTime(ctx) {
      var names = root.names()
      var x = pad, y = pad + captionRow, w = width - pad * 2, h = height - pad * 2 - captionRow
      var stacked = root.kind === "stacked"
      var all = []
      var lists = names.map(function (name) { return root.series(name) })
      if (stacked) {
        var n = Math.max.apply(null, [0].concat(lists.map(function (l) { return l.length })))
        for (var i = 0; i < n; i++) {
          var sum = 0
          lists.forEach(function (l) { var v = l[l.length - n + i]; if (isFinite(v)) sum += Math.max(0, v) })
          all.push(sum)
        }
      } else lists.forEach(function (l) { all = all.concat(l) })
      var band = root.axis(all)
      /* Bands of a whole stand on zero: framed on their own min–max the
       * lower bands would be clipped away. */
      if (stacked && !(root.min !== "" && isFinite(Number(root.min)))) band.lo = 0
      frame(ctx, x, y, w, h, band)
      ctx.save()
      ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip()
      ctx.lineWidth = 2
      ctx.lineJoin = "round"
      ctx.lineCap = "round"

      if (stacked) {
        var n2 = Math.max.apply(null, [0].concat(lists.map(function (l) { return l.length })))
        var below = []
        for (var j = 0; j < n2; j++) below.push(0)
        lists.forEach(function (l, si) {
          var top = []
          for (var j2 = 0; j2 < n2; j2++) {
            var v2 = l[l.length - n2 + j2]
            top.push(below[j2] + (isFinite(v2) ? Math.max(0, v2) : 0))
          }
          ctx.beginPath()
          path(ctx, top, band, x, y, w, h)
          for (var b = n2 - 1; b >= 0; b--) ctx.lineTo(xOf(b, n2, x, w), yOf(below[b], band, y, h))
          ctx.closePath()
          ctx.fillStyle = root.css(root.alpha(root.tone(si), 0.42))
          ctx.fill()
          /* The gap of surface between this band and the one above. */
          if (si > 0) {
            ctx.beginPath(); path(ctx, below, band, x, y, w, h)
            ctx.strokeStyle = root.css(surface); ctx.lineWidth = 2; ctx.stroke()
          }
          ctx.beginPath(); path(ctx, top, band, x, y, w, h)
          ctx.strokeStyle = root.css(root.tone(si)); ctx.lineWidth = 2; ctx.stroke()
          below = top
        })
      } else {
        lists.forEach(function (l, si) {
          var color = root.tone(si)
          if (root.kind === "area" || (names.length === 1 && root.kind !== "line")) {
            var g = ctx.createLinearGradient(0, y, 0, y + h)
            g.addColorStop(0, root.css(root.alpha(color, 0.18)))
            g.addColorStop(1, root.css(root.alpha(color, 0.03)))
            ctx.beginPath()
            path(ctx, l, band, x, y, w, h)
            ctx.lineTo(xOf(l.length - 1, l.length, x, w), y + h)
            ctx.lineTo(xOf(0, l.length, x, w), y + h)
            ctx.closePath()
            ctx.fillStyle = g
            ctx.fill()
          }
          ctx.beginPath(); path(ctx, l, band, x, y, w, h)
          ctx.strokeStyle = root.css(color); ctx.stroke()
        })
      }
      lists.forEach(function (l, si) { head(ctx, l, band, x, y, w, h, root.tone(si)) })
      ctx.restore()

      if (names.length > 1 || stacked) {
        legend(ctx, names.map(function (name, si) {
          return { name: name, text: name + " " + root.fmt(root.last(root.series(name))), color: root.tone(si) }
        }), x, y - captionPx * 0.6 - 2, w - 2)
      }
      /* Last, so it sits over the legend and the axis figures. */
      hoverTime(ctx, names, lists, band, x, y, w, h, stacked)
    }

    /* One strip per series, each framed on its own band. */
    function paintSplit(ctx) {
      var names = root.names()
      if (!names.length) return
      var x = pad, w = width - pad * 2
      var strip = (height - pad * 2) / names.length
      names.forEach(function (name, si) {
        var l = root.series(name)
        var top = pad + strip * si
        var y = top + captionRow, h = strip - captionRow - 2
        var band = root.axis(l)
        var color = root.tone(si)
        ctx.save()
        ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip()
        var g = ctx.createLinearGradient(0, y, 0, y + h)
        g.addColorStop(0, root.css(root.alpha(color, 0.18)))
        g.addColorStop(1, root.css(root.alpha(color, 0.03)))
        ctx.beginPath(); path(ctx, l, band, x, y, w, h)
        ctx.lineTo(xOf(l.length - 1, l.length, x, w), y + h); ctx.lineTo(xOf(0, l.length, x, w), y + h); ctx.closePath()
        ctx.fillStyle = g; ctx.fill()
        ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.lineCap = "round"
        ctx.beginPath(); path(ctx, l, band, x, y, w, h)
        ctx.strokeStyle = root.css(color); ctx.stroke()
        head(ctx, l, band, x, y, w, h, color)
        ctx.restore()
        ctx.beginPath(); ctx.arc(x + 5, top + captionPx * 0.7, 3, 0, Math.PI * 2)
        ctx.fillStyle = root.css(color); ctx.fill()
        text(ctx, name, x + 12, top + captionPx * 0.7, Color.popups.text)
        text(ctx, root.fmt(root.last(l)), x + w - 2, top + captionPx * 0.7, Color.popups.text, "right")
      })
      var hv = root.hover
      if (hv) {
        var si = Math.floor((hv.y - pad) / strip)
        if (si >= 0 && si < names.length) {
          var sl = root.series(names[si])
          hoverTime(ctx, [names[si]], [sl], root.axis(sl), x, pad + strip * si + captionRow, w, strip - captionRow - 2, false)
        }
      }
    }

    /* A row per series, a cell per sample, shaded by value. */
    function paintHeat(ctx) {
      var names = root.names()
      if (!names.length) return
      ctx.font = captionPx + "px " + family
      var labelW = 0
      names.forEach(function (n) { labelW = Math.max(labelW, ctx.measureText(n).width) })
      labelW = Math.min(labelW + 6, width * 0.35)
      var x = pad + labelW, w = width - pad * 2 - labelW
      var rowH = (height - pad * 2) / names.length
      var all = []
      names.forEach(function (n) { all = all.concat(root.series(n)) })
      var band = root.axis(all)
      var cells = 60
      var cw = w / cells
      names.forEach(function (name, si) {
        var l = root.series(name).slice(-cells)
        var y = pad + rowH * si
        text(ctx, name, pad, y + rowH / 2, Color.popups.text)
        for (var i = 0; i < l.length; i++) {
          var v = l[i]
          if (!isFinite(v)) continue
          var r = Math.max(0, Math.min(1, (v - band.lo) / ((band.hi - band.lo) || 1)))
          ctx.fillStyle = root.css(root.alpha(Color.accent, 0.08 + r * 0.9))
          var cx = x + w - (l.length - i) * cw
          ctx.fillRect(cx + 0.5, y + 1, Math.max(1, cw - 1), Math.max(1, rowH - 2))
        }
      })
      var hv = root.hover
      if (hv && hv.x >= x && hv.x <= x + w) {
        var ri = Math.floor((hv.y - pad) / rowH)
        if (ri >= 0 && ri < names.length) {
          var hl = root.series(names[ri]).slice(-cells)
          var ci = hl.length - 1 - Math.floor((x + w - hv.x) / cw)
          if (ci >= 0 && ci < hl.length && isFinite(hl[ci])) {
            var hx = x + w - (hl.length - ci) * cw
            ctx.strokeStyle = root.css(Color.accent); ctx.lineWidth = 1.5
            ctx.strokeRect(hx + 0.5, pad + rowH * ri + 1, Math.max(1, cw - 1), Math.max(1, rowH - 2))
            tip(ctx, hx + cw / 2, pad + rowH * ri + rowH / 2, [
              { text: names[ri] + "  " + root.fmt(hl[ci]), color: Color.accent },
              { text: (hl.length - 1 - ci) === 0 ? "now" : (hl.length - 1 - ci) + " samples ago" }
            ])
          }
        }
      }
    }

    /* The latest value as an arc, 270 degrees from lo to hi, open at
     * the bottom where the two figures sit. Sized from the height so it
     * never leaves the tile. */
    function paintGauge(ctx) {
      var names = root.names()
      var l = names.length ? root.series(names[0]) : []
      var cur = root.last(l), was = root.last(names.length ? root.prevSeries(names[0]) : [])
      var v = isFinite(cur) ? (isFinite(was) ? root.lerp(was, cur, root.t) : cur) : null
      var band = root.axis(l)
      var r = Math.min(width / 2 - pad, (height - pad * 2) * 0.52)
      var cx = width / 2, cy = pad + r + (height - pad * 2 - r * 1.71) / 2
      var a0 = Math.PI * 0.75, a1 = Math.PI * 2.25
      ctx.lineWidth = Math.max(6, r * 0.18)
      ctx.lineCap = "round"
      ctx.beginPath(); ctx.arc(cx, cy, r - ctx.lineWidth / 2, a0, a1)
      ctx.strokeStyle = root.css(root.alpha(Color.accent, 0.15)); ctx.stroke()
      if (v !== null) {
        var ratio = Math.max(0, Math.min(1, (v - band.lo) / ((band.hi - band.lo) || 1)))
        if (ratio > 0) {
          ctx.beginPath(); ctx.arc(cx, cy, r - ctx.lineWidth / 2, a0, a0 + (a1 - a0) * ratio)
          ctx.strokeStyle = root.css(ratio > 0.85 ? Color.urgent : Color.accent); ctx.stroke()
        }
      }
      text(ctx, root.fmt(v), cx, cy, Color.popups.text, "center", Style.font.title)
      text(ctx, root.fmt(band.lo), cx - r * 0.42, cy + r * 0.72, Color.popups.text, "center")
      text(ctx, root.fmt(band.hi), cx + r * 0.42, cy + r * 0.72, Color.popups.text, "center")
    }

    /* The latest value as a figure, with the window as a sparkline
     * under it and how it moved over the window. */
    function paintStat(ctx) {
      var names = root.names()
      var l = names.length ? root.series(names[0]) : []
      var cur = root.last(l), was = root.last(names.length ? root.prevSeries(names[0]) : [])
      var v = isFinite(cur) ? (isFinite(was) ? root.lerp(was, cur, root.t) : cur) : null
      /* The figure and its change sit centred, the sparkline in the
       * lower third; on a taller tile the block floats to the middle. */
      var figurePx = Math.max(Style.font.title, Math.min(Style.font.displayLarge, height * 0.3))
      var sparkH = Math.max(24, height * 0.3)
      var block = figurePx + captionPx * 1.8 + sparkH
      var top = pad + Math.max(0, (height - pad * 2 - block) / 2)
      text(ctx, root.fmt(v), width / 2, top + figurePx * 0.55, Color.popups.text, "center", figurePx)
      var first = l.length ? l[0] : null
      if (isFinite(first) && isFinite(cur) && first !== 0) {
        var change = (cur - first) / Math.abs(first) * 100
        var sign = change >= 0 ? "+" : "−"
        text(ctx, sign + Math.abs(change).toFixed(change >= 10 ? 0 : 1) + "% over the window", width / 2, top + figurePx + captionPx * 0.9, Color.popups.text, "center")
      }
      var y = top + figurePx + captionPx * 1.8, h = sparkH
      if (h < 12 || l.length < 2) return
      var x = pad, w = width - pad * 2
      var band = root.axis(l)
      ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip()
      var g = ctx.createLinearGradient(0, y, 0, y + h)
      g.addColorStop(0, root.css(root.alpha(Color.accent, 0.18)))
      g.addColorStop(1, root.css(root.alpha(Color.accent, 0.03)))
      ctx.beginPath(); path(ctx, l, band, x, y, w, h)
      ctx.lineTo(xOf(l.length - 1, l.length, x, w), y + h); ctx.lineTo(xOf(0, l.length, x, w), y + h); ctx.closePath()
      ctx.fillStyle = g; ctx.fill()
      ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.lineCap = "round"
      ctx.beginPath(); path(ctx, l, band, x, y, w, h)
      ctx.strokeStyle = root.css(Color.accent); ctx.stroke()
      head(ctx, l, band, x, y, w, h, Color.accent)
      ctx.restore()
      hoverTime(ctx, [names[0]], [l], band, x, y, w, h, false)
    }

    /* A table of sparklines: a row per series — its name, the window
     * on its own band, the latest value. */
    function paintSparks(ctx) {
      var names = root.names()
      if (!names.length) return
      ctx.font = captionPx + "px " + family
      var labelW = 0, valueW = 0
      names.forEach(function (n) {
        labelW = Math.max(labelW, ctx.measureText(n).width)
        valueW = Math.max(valueW, ctx.measureText(root.fmt(root.last(root.series(n)))).width)
      })
      labelW = Math.min(labelW + 14, width * 0.35)
      var x = pad + labelW, w = width - pad * 2 - labelW - valueW - 10
      var rowH = (height - pad * 2) / names.length
      names.forEach(function (name, si) {
        var l = root.series(name)
        var top = pad + rowH * si
        var y = top + 3, h = rowH - 6
        var color = root.tone(si)
        ctx.beginPath(); ctx.arc(pad + 4, top + rowH / 2, 3, 0, Math.PI * 2)
        ctx.fillStyle = root.css(color); ctx.fill()
        ctx.save(); ctx.beginPath(); ctx.rect(pad + 10, top, labelW - 12, rowH); ctx.clip()
        text(ctx, name, pad + 12, top + rowH / 2, Color.popups.text)
        ctx.restore()
        var band = root.axis(l)
        ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip()
        var g = ctx.createLinearGradient(0, y, 0, y + h)
        g.addColorStop(0, root.css(root.alpha(color, 0.18)))
        g.addColorStop(1, root.css(root.alpha(color, 0.03)))
        ctx.beginPath(); path(ctx, l, band, x, y, w, h)
        ctx.lineTo(xOf(l.length - 1, l.length, x, w), y + h); ctx.lineTo(xOf(0, l.length, x, w), y + h); ctx.closePath()
        ctx.fillStyle = g; ctx.fill()
        ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.lineCap = "round"
        ctx.beginPath(); path(ctx, l, band, x, y, w, h)
        ctx.strokeStyle = root.css(color); ctx.stroke()
        var lv = root.last(l)
        if (isFinite(lv)) {
          var ex = xOf(l.length - 1, l.length, x, w), ey = yOf(lv, band, y, h)
          ctx.beginPath(); ctx.arc(ex, ey, 5, 0, Math.PI * 2); ctx.fillStyle = root.css(surface); ctx.fill()
          ctx.beginPath(); ctx.arc(ex, ey, 3, 0, Math.PI * 2); ctx.fillStyle = root.css(color); ctx.fill()
        }
        ctx.restore()
        text(ctx, root.fmt(lv), width - pad, top + rowH / 2, Color.popups.text, "right")
      })
      var hv = root.hover
      if (hv && hv.x >= x && hv.x <= x + w) {
        var si2 = Math.floor((hv.y - pad) / rowH)
        if (si2 >= 0 && si2 < names.length) {
          var sl = root.series(names[si2])
          hoverTime(ctx, [names[si2]], [sl], root.axis(sl), x, pad + rowH * si2 + 3, w, rowH - 6, false)
        }
      }
    }

    /* A bank of vertical meters: one per row, or per series at its
     * latest value. Each fills from the base to its share of the axis,
     * the figure above it, the label beneath. */
    function paintMeters(ctx) {
      var items = []
      if (root.shown.bars) {
        root.shown.bars.forEach(function (row, i) { items.push({ label: String(row.label), value: barValue(row, i), color: root.tone(0) }) })
      } else {
        root.names().forEach(function (name, si) {
          var cur = root.last(root.series(name)), was = root.last(root.prevSeries(name))
          var v = isFinite(cur) ? (isFinite(was) ? root.lerp(was, cur, root.t) : cur) : null
          items.push({ label: name, value: v, color: root.tone(si) })
        })
      }
      if (!items.length) return
      var band = root.axis(items.map(function (it) { return it.value }))
      if (!(root.min !== "" && isFinite(Number(root.min)))) band.lo = Math.min(0, band.lo)
      var slot = (width - pad * 2) / items.length
      var bw = Math.max(6, Math.min(24, slot * 0.5))
      var top = pad + captionRow, base = height - pad - captionRow
      var h = base - top
      items.forEach(function (it, i) {
        var cx = pad + slot * i + slot / 2
        var x = cx - bw / 2
        /* the track: a lighter step of the same colour */
        ctx.fillStyle = root.css(root.alpha(it.color, 0.15))
        ctx.fillRect(x, top, bw, h)
        if (it.value !== null && isFinite(it.value)) {
          var ratio = Math.max(0, Math.min(1, (it.value - band.lo) / ((band.hi - band.lo) || 1)))
          var fh = Math.max(ratio > 0 ? 3 : 0, ratio * h)
          ctx.fillStyle = root.css(it.color)
          ctx.save(); ctx.translate(cx, base); ctx.rotate(-Math.PI / 2)
          endRect(ctx, 0, -bw / 2, fh, bw, 4); ctx.fill()
          ctx.restore()
        }
        ctx.save(); ctx.beginPath(); ctx.rect(pad + slot * i, 0, slot, height); ctx.clip()
        text(ctx, root.fmt(it.value), cx, top - captionPx * 0.6 - 2, Color.popups.text, "center")
        text(ctx, it.label, cx, base + captionPx * 0.7 + 2, Color.popups.text, "center")
        ctx.restore()
      })
      ctx.strokeStyle = root.css(root.alpha(Color.popups.text, 0.14)); ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(pad, base + 0.5); ctx.lineTo(width - pad, base + 0.5); ctx.stroke()
      var hv = root.hover
      if (hv) {
        var hi = Math.floor((hv.x - pad) / slot)
        if (hi >= 0 && hi < items.length && hv.y >= top && hv.y <= base) {
          var it2 = items[hi]
          var pct = Math.round(100 * Math.max(0, Math.min(1, (it2.value - band.lo) / ((band.hi - band.lo) || 1))))
          tip(ctx, pad + slot * hi + slot / 2, hv.y, [
            { text: it2.label + "  " + root.fmt(it2.value), color: it2.color },
            { text: pct + "% of " + root.fmt(band.hi) }
          ])
        }
      }
    }

    function barValue(row, i) {
      var v = Number(row.value)
      var before = null
      if (root.prev.bars) {
        var match = root.prev.bars.filter(function (b) { return b.label === row.label })[0]
        if (match) before = Number(match.value)
      }
      if (!isFinite(v)) v = 0
      return before !== null && isFinite(before) ? root.lerp(before, v, root.t) : v * (root.first ? root.t : 1)
    }

    /* Horizontal bars, ranked: the label, a rounded bar scaled to the
     * largest, the figure. */
    function paintBars(ctx) {
      var rows = root.shown.bars
      if (!rows.length) return
      ctx.font = captionPx + "px " + family
      var labelW = 0, valueW = 0
      rows.forEach(function (row) {
        labelW = Math.max(labelW, ctx.measureText(String(row.label)).width)
        valueW = Math.max(valueW, ctx.measureText(root.fmt(Number(row.value))).width)
      })
      labelW = Math.min(labelW, width * 0.38)
      var x = pad + labelW + 8, w = width - pad * 2 - labelW - valueW - 16
      var rowH = (height - pad * 2) / rows.length
      var peak = 1e-9
      rows.forEach(function (row) { peak = Math.max(peak, Number(row.value) || 0) })
      rows.forEach(function (row, i) {
        var y = pad + rowH * i
        var bh = Math.max(3, Math.min(rowH - 4, 24))
        var by = y + (rowH - bh) / 2
        var v = barValue(row, i)
        var bw = Math.max(0, w * v / peak)
        ctx.save(); ctx.beginPath(); ctx.rect(pad, y, labelW + 2, rowH); ctx.clip()
        text(ctx, String(row.label), pad, y + rowH / 2, Color.popups.text)
        ctx.restore()
        /* One colour for every bar — the length already says the value —
         * square at the baseline, rounded at the data end. */
        ctx.fillStyle = root.css(root.tone(0))
        if (bw > 0) { endRect(ctx, x, by, Math.max(4, bw), bh, 4); ctx.fill() }
        ctx.strokeStyle = root.css(root.alpha(Color.popups.text, 0.14)); ctx.lineWidth = 1
        ctx.beginPath(); ctx.moveTo(x + 0.5, by - 1); ctx.lineTo(x + 0.5, by + bh + 1); ctx.stroke()
        text(ctx, root.fmt(Number(row.value)), width - pad, y + rowH / 2, Color.popups.text, "right")
      })
      var hv = root.hover
      if (hv) {
        var hi = Math.floor((hv.y - pad) / rowH)
        if (hi >= 0 && hi < rows.length) {
          var hrow = rows[hi]
          var share = peak > 0 ? Math.round(100 * (Number(hrow.value) || 0) / peak) : 0
          ctx.fillStyle = root.css(root.alpha(Color.accent, 0.08))
          ctx.fillRect(pad, pad + rowH * hi, width - pad * 2, rowH)
          tip(ctx, hv.x, pad + rowH * hi + rowH / 2, [
            { text: String(hrow.label) + "  " + root.fmt(Number(hrow.value)), color: Color.accent },
            { text: share + "% of the largest" }
          ])
        }
      }
    }

    /* A bar: square at x, rounded at x + w. */
    function endRect(ctx, x, y, w, h, r) {
      r = Math.min(r, h / 2, w)
      ctx.beginPath()
      ctx.moveTo(x, y)
      ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r)
      ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r)
      ctx.lineTo(x, y + h)
      ctx.closePath()
    }

    function roundRect(ctx, x, y, w, h, r) {
      r = Math.min(r, h / 2, w / 2)
      ctx.beginPath()
      ctx.moveTo(x + r, y)
      ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r)
      ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r)
      ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r)
      ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r)
      ctx.closePath()
    }

    /* A donut: sectors clockwise from the top, a legend to the right.
     * The first draw sweeps the ring in; later changes ease the shares. */
    function paintPie(ctx) {
      var rows = root.shown.bars
      if (!rows.length) return
      var values = rows.map(function (row, i) { return Math.max(0, barValue(row, i)) })
      var total = values.reduce(function (a, b) { return a + b }, 0)
      var r = Math.min(height / 2 - pad, width / 4)
      var cx = pad + r, cy = height / 2
      var ring = Math.max(6, r * 0.42)
      ctx.lineWidth = ring
      var sweep = root.first ? root.t : 1
      var a = -Math.PI / 2
      var gap = values.filter(function (v) { return v > 0 }).length > 1 ? 2 / (r - ring / 2) : 0
      values.forEach(function (v, i) {
        var frac = total > 0 ? v / total : 0
        var span = Math.PI * 2 * frac * sweep
        if (span <= 0) return
        /* A 2px gap of surface on each side of a sector, as an angle. */
        var a0 = a + Math.min(gap / 2, span / 4), a1 = a + span - Math.min(gap / 2, span / 4)
        ctx.beginPath(); ctx.arc(cx, cy, r - ring / 2, a0, a1)
        ctx.strokeStyle = root.css(root.tone(i)); ctx.lineWidth = ring; ctx.stroke()
        a += span
      })
      if (total <= 0) {
        ctx.beginPath(); ctx.arc(cx, cy, r - ring / 2, 0, Math.PI * 2)
        ctx.strokeStyle = root.css(root.alpha(Color.accent, 0.15)); ctx.stroke()
      }
      var lx = cx + r + 12
      var lineH = Math.min(18, (height - pad * 2) / Math.max(1, rows.length))
      var ly = height / 2 - lineH * (rows.length - 1) / 2
      rows.forEach(function (row, i) {
        var pct = total > 0 ? Math.round(100 * Math.max(0, Number(row.value) || 0) / rows.reduce(function (s, q) { return s + Math.max(0, Number(q.value) || 0) }, 0)) : 0
        ctx.beginPath(); ctx.arc(lx + 3, ly + lineH * i, 3.5, 0, Math.PI * 2)
        ctx.fillStyle = root.css(root.tone(i)); ctx.fill()
        ctx.save(); ctx.beginPath(); ctx.rect(lx + 10, 0, width - lx - 10 - pad, height); ctx.clip()
        text(ctx, String(row.label) + "  " + pct + "%", lx + 12, ly + lineH * i, Color.popups.text)
        ctx.restore()
      })
      /* Last, so it sits over the legend. */
      var hv = root.hover
      if (hv && total > 0) {
        var dx = hv.x - cx, dy = hv.y - cy
        var dist = Math.sqrt(dx * dx + dy * dy)
        if (dist <= r && dist >= r - ring) {
          var turn = (Math.atan2(dy, dx) + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2)
          var acc = 0
          for (var hi = 0; hi < values.length; hi++) {
            var span = Math.PI * 2 * (values[hi] / total)
            if (turn >= acc && turn < acc + span) {
              var mid = acc + span / 2 - Math.PI / 2
              ctx.beginPath(); ctx.arc(cx, cy, r - ring / 2, acc - Math.PI / 2, acc + span - Math.PI / 2)
              ctx.strokeStyle = root.css(root.alpha(Color.popups.text, 0.35)); ctx.lineWidth = ring + 4; ctx.stroke()
              ctx.beginPath(); ctx.arc(cx, cy, r - ring / 2, acc - Math.PI / 2, acc + span - Math.PI / 2)
              ctx.strokeStyle = root.css(root.tone(hi)); ctx.lineWidth = ring; ctx.stroke()
              tip(ctx, cx + Math.cos(mid) * r, cy + Math.sin(mid) * r, [
                { text: String(rows[hi].label) + "  " + root.fmt(Number(rows[hi].value)), color: root.tone(hi) },
                { text: Math.round(100 * values[hi] / total) + "%" }
              ])
              break
            }
            acc += span
          }
        }
      }
    }

    /* Where each point of a scatter lands, for painting and picking. */
    property var placed: []

    function pick(mx, my) {
      var best = null, bestD = 144 /* px², a 12px reach */
      for (var i = 0; i < placed.length; i++) {
        var p = placed[i]
        var d = (p.px - mx) * (p.px - mx) + (p.py - my) * (p.py - my)
        if (d < bestD) { bestD = d; best = p }
      }
      return best
    }

    /* A box of lines beside a point, kept inside the chart. Each line
     * is { text, color? }; a coloured dot precedes a line with a colour. */
    function tip(ctx, px, py, lines) {
      ctx.font = captionPx + "px " + family
      var lineH = captionPx + 6
      var tw = 0
      lines.forEach(function (l) { tw = Math.max(tw, ctx.measureText(l.text).width + (l.color ? 12 : 0)) })
      tw += 12
      var th = lineH * lines.length + 6
      var bx = px + 12 + tw > width - 2 ? px - 12 - tw : px + 12
      bx = Math.max(2, Math.min(width - tw - 2, bx))
      var by = Math.max(2, Math.min(height - th - 2, py - th / 2))
      ctx.fillStyle = root.css(Color.popups.background)
      roundRect(ctx, bx, by, tw, th, 4); ctx.fill()
      ctx.strokeStyle = root.css(root.alpha(Color.accent, 0.6)); ctx.lineWidth = 1
      roundRect(ctx, bx + 0.5, by + 0.5, tw - 1, th - 1, 4); ctx.stroke()
      lines.forEach(function (l, i) {
        var ly = by + 3 + lineH * i + lineH / 2
        var lx = bx + 6
        if (l.color) {
          ctx.beginPath(); ctx.arc(lx + 3, ly, 3, 0, Math.PI * 2)
          ctx.fillStyle = root.css(l.color); ctx.fill()
          lx += 12
        }
        text(ctx, l.text, lx, ly, Color.popups.text)
      })
    }

    function ring(ctx, px, py) {
      ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2)
      ctx.strokeStyle = root.css(Color.accent); ctx.lineWidth = 2; ctx.stroke()
    }

    /* The sample index nearest the pointer, given the plot's extent and
     * the series length. */
    function indexAt(mx, x, w, n) {
      if (n <= 1) return n - 1
      var step = w / (windowSamples - 1)
      var i = Math.round(n - 1 - (x + w - mx) / step)
      return Math.max(0, Math.min(n - 1, i))
    }

    /* Hover for a series chart: a guide at the sample and every
     * series' value there. `lists` are aligned to their own ends. */
    function hoverTime(ctx, names, lists, band, x, y, w, h, stacked) {
      var hv = root.hover
      if (!hv || hv.x < x || hv.x > x + w || hv.y < y || hv.y > y + h) return
      var n = 0
      lists.forEach(function (l) { n = Math.max(n, l.length) })
      if (!n) return
      var i = indexAt(hv.x, x, w, n)
      var gx = xOf(i, n, x, w)
      ctx.strokeStyle = root.css(root.alpha(Color.accent, 0.5)); ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(gx, y); ctx.lineTo(gx, y + h); ctx.stroke()
      var lines = []
      var sum = 0
      names.forEach(function (name, si) {
        var l = lists[si]
        var v = l[l.length - n + i]
        if (v === undefined || !isFinite(v)) return
        lines.push({ text: name + "  " + root.fmt(v), color: root.tone(si) })
        if (stacked) sum += Math.max(0, v)
        else ring(ctx, gx, yOf(v, band, y, h))
      })
      if (stacked) { lines.push({ text: "total  " + root.fmt(sum) }); ring(ctx, gx, yOf(sum, band, y, h)) }
      lines.push({ text: (n - 1 - i) === 0 ? "now" : (n - 1 - i) + " samples ago" })
      tip(ctx, gx, hv.y, lines)
    }

    /* Points on two axes, framed to the data unless fixed. */
    function paintScatter(ctx) {
      var pts = root.shown.points
      var x = pad + 2, y = pad + captionRow, w = width - pad * 2 - 2, h = height - pad * 2 - captionRow
      var xs = pts.map(function (p) { return p.x }), ys = pts.map(function (p) { return p.y })
      var bx = root.axis(xs.filter(isFinite)), by = root.axis(ys.filter(isFinite))
      var landed = []
      frame(ctx, x, y, w, h, by)
      text(ctx, root.fmt(bx.lo), x + 2, y + h - captionPx * 0.7 - 12, root.alpha(Color.popups.text, 0.6))
      text(ctx, root.fmt(bx.hi), x + w - 2, y + h - captionPx * 0.7, root.alpha(Color.popups.text, 0.85), "right")
      pts.forEach(function (p) {
        if (!isFinite(p.x) || !isFinite(p.y)) return
        var px = x + Math.max(0, Math.min(1, (p.x - bx.lo) / ((bx.hi - bx.lo) || 1))) * w
        var py = yOf(p.y, by, y, h)
        landed.push({ px: px, py: py, x: p.x, y: p.y, label: p.label })
        ctx.beginPath(); ctx.arc(px, py, 6, 0, Math.PI * 2)
        ctx.fillStyle = root.css(root.alpha(surface, 0.9)); ctx.fill()
        ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2)
        ctx.fillStyle = root.css(root.alpha(Color.accent, 0.85 * (root.first ? root.t : 1))); ctx.fill()
      })
      placed = landed
      if (root.hover) {
        var hp = pick(root.hover.x, root.hover.y)
        if (hp) {
          ring(ctx, hp.px, hp.py)
          tip(ctx, hp.px, hp.py, [
            { text: (hp.label ? hp.label + "  " : "") + root.fmt(hp.y), color: Color.accent },
            { text: "x  " + root.compact(hp.x) }
          ])
        }
      }
    }
  }
}
