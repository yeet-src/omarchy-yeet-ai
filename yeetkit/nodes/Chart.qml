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
// value as an arc). Of bars: `bars` (horizontal, ranked) or `pie` (a
// donut with a legend). Of points: `scatter`.
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
    running: root.visible && root.live && root.kind !== "heat" && root.kind !== "gauge"
    onTriggered: {
      root.pulse = (root.pulse + 0.025) % 1
      canvas.requestPaint()
    }
  }

  // ---- colour ---------------------------------------------------------

  /* Series i: the accent, then hues turned from it by a golden-ish step
   * so neighbours differ. A monochrome accent has no hue to turn, so
   * the steps are in lightness. */
  function tone(i) {
    var a = Color.accent
    if (i === 0) return a
    if (a.hslSaturation < 0.12) {
      var l = a.hslLightness + (i % 2 === 1 ? -1 : 1) * 0.16 * Math.ceil(i / 2)
      return Qt.hsla(a.hslHue, a.hslSaturation, Math.max(0.25, Math.min(0.9, l)), 1)
    }
    return Qt.hsla((a.hslHue + i * 0.11) % 1, Math.min(1, a.hslSaturation * 0.95), a.hslLightness, 1)
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

  // ---- painting -------------------------------------------------------

  Canvas {
    id: canvas
    anchors.fill: parent
    renderStrategy: Canvas.Cooperative

    readonly property int pad: 4
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
      else if (root.shown.bars) { if (k === "pie") paintPie(ctx); else paintBars(ctx) }
      else if (k === "gauge") paintGauge(ctx)
      else if (k === "heat") paintHeat(ctx)
      else if (k === "split" || k === "sparks") paintSplit(ctx)
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
      text(ctx, root.fmt(band.hi), x + 2, y + captionPx * 0.7, root.alpha(Color.popups.text, 0.85))
      text(ctx, root.fmt(band.lo), x + 2, y + h - captionPx * 0.7, root.alpha(Color.popups.text, 0.85))
    }

    /* x for sample i of n, sliding: the newest sample starts a step to
     * the right of the edge and eases in. */
    function xOf(i, n, x, w) {
      if (n <= 1) return x + w
      var step = w / Math.max(1, Math.min(n - 1, 119))
      return x + w - (n - 1 - i) * step + (root.first ? 0 : (1 - root.t) * step)
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
      ctx.arc(px, py, 3, 0, Math.PI * 2)
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
      var x = pad, y = pad, w = width - pad * 2, h = height - pad * 2
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
          ctx.fillStyle = root.css(root.alpha(root.tone(si), 0.55))
          ctx.fill()
          ctx.beginPath(); path(ctx, top, band, x, y, w, h)
          ctx.strokeStyle = root.css(root.tone(si)); ctx.stroke()
          below = top
        })
      } else {
        lists.forEach(function (l, si) {
          var color = root.tone(si)
          if (root.kind === "area" || (names.length === 1 && root.kind !== "line")) {
            var g = ctx.createLinearGradient(0, y, 0, y + h)
            g.addColorStop(0, root.css(root.alpha(color, 0.55)))
            g.addColorStop(1, root.css(root.alpha(color, 0.02)))
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
        }), x, y + captionPx * 0.7, w - 2)
      }
    }

    /* One strip per series, each framed on its own band. */
    function paintSplit(ctx) {
      var names = root.names()
      if (!names.length) return
      var x = pad, w = width - pad * 2
      var strip = (height - pad * 2) / names.length
      names.forEach(function (name, si) {
        var l = root.series(name)
        var y = pad + strip * si + 2, h = strip - 4
        var band = root.axis(l)
        var color = root.tone(si)
        ctx.save()
        ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip()
        var g = ctx.createLinearGradient(0, y, 0, y + h)
        g.addColorStop(0, root.css(root.alpha(color, 0.5)))
        g.addColorStop(1, root.css(root.alpha(color, 0.02)))
        ctx.beginPath(); path(ctx, l, band, x, y, w, h)
        ctx.lineTo(xOf(l.length - 1, l.length, x, w), y + h); ctx.lineTo(xOf(0, l.length, x, w), y + h); ctx.closePath()
        ctx.fillStyle = g; ctx.fill()
        ctx.lineWidth = 1.5; ctx.lineJoin = "round"
        ctx.beginPath(); path(ctx, l, band, x, y, w, h)
        ctx.strokeStyle = root.css(color); ctx.stroke()
        head(ctx, l, band, x, y, w, h, color)
        ctx.restore()
        text(ctx, name, x + 2, y + captionPx * 0.7, Color.popups.text)
        text(ctx, root.fmt(root.last(l)), x + w - 2, y + captionPx * 0.7, color, "right")
      })
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
    }

    /* The latest value as an arc, 240 degrees from lo to hi. */
    function paintGauge(ctx) {
      var names = root.names()
      var l = names.length ? root.series(names[0]) : []
      var cur = root.last(l), was = root.last(names.length ? root.prevSeries(names[0]) : [])
      var v = isFinite(cur) ? (isFinite(was) ? root.lerp(was, cur, root.t) : cur) : null
      var band = root.axis(l)
      var cx = width / 2, cy = height * 0.62
      var r = Math.min(width / 2, height * 0.8) - 8
      var start = Math.PI * (1 - 1 / 6) * 1 + Math.PI / 2 - Math.PI * (1 - 1 / 6)
      var a0 = Math.PI * 0.75, a1 = Math.PI * 2.25
      ctx.lineWidth = Math.max(6, r * 0.18)
      ctx.lineCap = "round"
      ctx.beginPath(); ctx.arc(cx, cy, r, a0, a1)
      ctx.strokeStyle = root.css(root.alpha(Color.accent, 0.15)); ctx.stroke()
      if (v !== null) {
        var ratio = Math.max(0, Math.min(1, (v - band.lo) / ((band.hi - band.lo) || 1)))
        ctx.beginPath(); ctx.arc(cx, cy, r, a0, a0 + (a1 - a0) * ratio)
        ctx.strokeStyle = root.css(ratio > 0.85 ? Color.urgent : Color.accent); ctx.stroke()
      }
      text(ctx, root.fmt(v), cx, cy - 2, Color.popups.text, "center", Style.font.title)
      text(ctx, root.fmt(band.lo), cx - r * 0.72, cy + r * 0.72, Color.popups.text, "center")
      text(ctx, root.fmt(band.hi), cx + r * 0.72, cy + r * 0.72, Color.popups.text, "center")
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
        var bh = Math.max(3, Math.min(rowH - 4, 16))
        var by = y + (rowH - bh) / 2
        var v = barValue(row, i)
        var bw = Math.max(0, w * v / peak)
        ctx.save(); ctx.beginPath(); ctx.rect(pad, y, labelW + 2, rowH); ctx.clip()
        text(ctx, String(row.label), pad, y + rowH / 2, Color.popups.text)
        ctx.restore()
        ctx.fillStyle = root.css(root.alpha(Color.accent, 0.12))
        roundRect(ctx, x, by, w, bh, bh / 2); ctx.fill()
        var g = ctx.createLinearGradient(x, 0, x + w, 0)
        g.addColorStop(0, root.css(root.tone(0)))
        g.addColorStop(1, root.css(root.tone(1)))
        ctx.fillStyle = g
        if (bw > 0) { roundRect(ctx, x, by, Math.max(bh, bw), bh, bh / 2); ctx.fill() }
        text(ctx, root.fmt(Number(row.value)), width - pad, y + rowH / 2, Color.popups.text, "right")
      })
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
      values.forEach(function (v, i) {
        var frac = total > 0 ? v / total : 0
        var span = Math.PI * 2 * frac * sweep
        if (span <= 0) return
        ctx.beginPath(); ctx.arc(cx, cy, r - ring / 2, a, a + span)
        ctx.strokeStyle = root.css(root.tone(i)); ctx.stroke()
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
    }

    /* Points on two axes, framed to the data unless fixed. */
    function paintScatter(ctx) {
      var pts = root.shown.points
      var x = pad + 2, y = pad, w = width - pad * 2 - 2, h = height - pad * 2
      var xs = pts.map(function (p) { return p.x }), ys = pts.map(function (p) { return p.y })
      var bx = root.axis(xs.filter(isFinite)), by = root.axis(ys.filter(isFinite))
      frame(ctx, x, y, w, h, by)
      text(ctx, root.fmt(bx.lo), x + 2, y + h - captionPx * 0.7 - 12, root.alpha(Color.popups.text, 0.6))
      text(ctx, root.fmt(bx.hi), x + w - 2, y + h - captionPx * 0.7, root.alpha(Color.popups.text, 0.85), "right")
      pts.forEach(function (p) {
        if (!isFinite(p.x) || !isFinite(p.y)) return
        var px = x + Math.max(0, Math.min(1, (p.x - bx.lo) / ((bx.hi - bx.lo) || 1))) * w
        var py = yOf(p.y, by, y, h)
        ctx.beginPath(); ctx.arc(px, py, 3.5, 0, Math.PI * 2)
        ctx.fillStyle = root.css(root.alpha(Color.accent, 0.75 * (root.first ? root.t : 1))); ctx.fill()
      })
    }
  }
}
