import QtQuick
import "Protocol.js" as Protocol

/* The shell half of a yeetkit app: a mirror of the tree the isolate
 * holds, built out of QML items instead of DOM nodes. The isolate
 * itself is the plugin's Isolate singleton; this talks to it through
 * a transport with a socket's shape.
 *
 * It knows nothing about the application. It keeps a map of id ->
 * record, applies the patches that arrive, sends events back up, and
 * hands the entry files the *regions* they display — the `<bar>` and
 * `<panel>` elements, wherever they sit in the tree. Everything else
 * is a node inside one of those.
 *
 * Where the browser client creates DOM elements by tag, this one
 * creates a QML component per tag from `nodes/`. A node component is
 * an ordinary Item with three conventions: a `slot` Item that its
 * children are reparented into (null for a leaf), plain properties
 * named as the JSX attributes are, and an `ev(type, payload)` signal
 * for what the user did. Text nodes have no item of their own: their
 * parent's `text` property is the join of its text children, which is
 * how `<button>Save {n()}</button>` patches one segment.
 */
Item {
  id: client
  /* Nodes are born as children of this item and read their defaults
   * here before an entry file reparents them, so it has to be visible
   * — `visible` on a child of an invisible item reads false — while
   * showing nothing: zero size and clipped. */
  visible: true
  clip: true
  width: 0
  height: 0

  /** The host bar, for the chrome a bar node borrows from it. */
  property var bar: null
  property string path: "/"
  property string title: ""

  /** connecting | connected | live | reconnecting. (Not `state`: an Item has one, for States.) */
  property string phase: "connecting"
  readonly property bool live: phase === "live"

  /** Region name -> its Item, as the tree stands now. */
  property var regions: ({})
  /** Set by an input node while it holds focus, so a panel's key catcher stands aside. */
  property bool inputFocus: false

  /** A transport component to use instead of the stdio one — tests swap this in. */
  property Component transportComponent: null

  signal regionChanged(string name, Item item)
  signal regionEvent(string name, string type, var payload)
  /** Every patch applied, in order — for tests and tooling. */
  signal applied(var patch)

  readonly property var regionTags: ["bar", "panel"]

  // ---- what a patch may ask of the shell ----------------------------------

  /* The plugin's own folder: one above yeetkit/. Files a node shows
   * come from here and nowhere else. */
  readonly property url pluginRoot: Qt.resolvedUrl("../")

  /* Frames are not authenticated. Anything in the isolate that can
   * write to its tty — the app, a library, code the app evaluates —
   * can produce a patch, so a patch never gets to make the shell act
   * outside this process: no network, no file off the plugin folder.
   * A `src` is therefore a data: image or a relative path under the
   * plugin; everything else becomes an empty source, with a warning
   * in the shell's log. Percent-escapes and `..` segments are refused
   * before resolving rather than normalised, so what the file system
   * sees is what was checked. */
  function assetUrl(src) {
    var text = src === undefined || src === null ? "" : String(src)
    if (text === "") return ""
    if (/^data:image\/[a-z0-9.+-]+[;,]/i.test(text)) return text
    var reason = null
    if (/^[a-z][a-z0-9+.-]*:/i.test(text)) reason = "a URL with a scheme"
    else if (text.charAt(0) === "/" || text.charAt(0) === "\\" || text.indexOf("\\") >= 0) reason = "an absolute path"
    else if (text.indexOf("%") >= 0 || /(^|\/)\.\.(\/|$)/.test(text)) reason = "a path that leaves the plugin folder"
    if (reason === null) {
      var resolved = String(Qt.resolvedUrl("../" + text))
      if (resolved.indexOf(String(pluginRoot)) === 0) return resolved
      reason = "a path that leaves the plugin folder"
    }
    console.warn("yeetkit: src " + JSON.stringify(text.slice(0, 80)) + " refused: " + reason + "; only data: images and files under the plugin folder are shown")
    return ""
  }

  // ---- the wire --------------------------------------------------------

  property var lane: null
  property var framer: null
  property int helloTries: 0

  Component.onCompleted: connect()

  function connect() {
    if (lane) return
    framer = Protocol.framer(
      function (patch) { apply(patch) },
      function (error, body) { console.warn("yeetkit: bad frame: " + error + " " + body) }
    )
    var component = transportComponent || Qt.createComponent(Qt.resolvedUrl("StdioTransport.qml"))
    if (component.status === Component.Error) {
      console.warn("yeetkit: transport failed to load: " + component.errorString())
      return
    }
    lane = component.createObject(client, {})
    if (!lane) {
      console.warn("yeetkit: transport failed: " + component.errorString())
      return
    }
    lane.message.connect(function (text) { framer(text) })
    lane.opened.connect(hello)
    lane.closed.connect(dropped)
    if (lane.live) hello()
  }

  /* `hello` is what sends the tree. The isolate cannot see a peer
   * arrive, and over a PTY a line written before its key listener is
   * up can be lost — so hello repeats until the mount answers it. */
  function hello() {
    if (!lane || !lane.live) return
    phase = "connected"
    helloTries = 0
    up({ t: "hello", path: path })
    helloRetry.restart()
  }

  property Timer helloRetry: Timer {
    interval: 700
    repeat: true
    onTriggered: {
      if (client.phase === "live" || !client.lane || !client.lane.live || client.helloTries > 40) {
        stop()
        return
      }
      client.helloTries += 1
      client.up({ t: "hello", path: client.path })
    }
  }

  function dropped() {
    phase = "reconnecting"
    helloRetry.stop()
  }

  function up(message) {
    if (!lane) return false
    return lane.send(Protocol.encodeUplink(message))
  }

  /** A key the shell caught and the app may want: `{key, ctrl, alt, shift}`. */
  function key(spec) {
    up({
      t: "key",
      key: spec.key,
      code: spec.code || "",
      ctrl: !!spec.ctrl,
      alt: !!spec.alt,
      shift: !!spec.shift,
      meta: !!spec.meta
    })
  }

  // ---- the tree --------------------------------------------------------

  /* id -> record. A record is { id, tag, item, kids, parent, on,
   * defaults } for an element and { id, text, parent } for text. Plain
   * objects, mutated in place: nothing binds to them. */
  property var nodes: ({})
  property var components: ({})

  function fileFor(tag) {
    var name = String(tag).split("-").map(function (part) {
      return part.charAt(0).toUpperCase() + part.slice(1)
    }).join("")
    return "nodes/" + name + ".qml"
  }

  function componentFor(tag) {
    if (components[tag]) return components[tag]
    var component = Qt.createComponent(Qt.resolvedUrl(fileFor(tag)))
    if (component.status === Component.Error) {
      console.warn("yeetkit: no node for <" + tag + ">: " + component.errorString().trim())
      component = Qt.createComponent(Qt.resolvedUrl("nodes/Unknown.qml"))
    }
    components[tag] = component
    return component
  }

  function isRegion(tag) {
    return regionTags.indexOf(tag) >= 0
  }

  function build(spec, parentRec) {
    if (spec.text !== undefined) {
      var textRec = { id: spec.id, text: String(spec.text), parent: parentRec }
      nodes[spec.id] = textRec
      return textRec
    }

    var rec = { id: spec.id, tag: spec.tag, item: null, kids: [], parent: parentRec, on: {}, defaults: {} }
    nodes[spec.id] = rec

    var component = componentFor(spec.tag)
    /* The client is the QObject parent — that is what keeps the item
     * alive until `dispose` — and the slot it is shown in is only its
     * visual parent, set when it is placed. */
    var item = component.createObject(client, { client: client, nodeId: spec.id })
    if (!item) {
      console.warn("yeetkit: <" + spec.tag + "> failed: " + component.errorString().trim())
      item = componentFor("unknown").createObject(client, { client: client, nodeId: spec.id })
    }
    rec.item = item
    if (item.ev) {
      item.ev.connect(function (type, payload) { dispatch(rec, type, payload) })
    }

    var attrs = spec.attrs || {}
    for (var name in attrs) setAttr(rec, name, attrs[name])
    var on = spec.on || []
    for (var i = 0; i < on.length; i++) rec.on[on[i]] = true

    var kids = spec.kids || []
    for (var k = 0; k < kids.length; k++) {
      var kid = build(kids[k], rec)
      rec.kids.push(kid)
      place(rec, kid, null)
    }
    retext(rec)

    if (isRegion(spec.tag)) register(rec)
    return rec
  }

  /* Puts a child where its parent shows children. A region is owned
   * by an entry file and never placed here; a text node has no item
   * and only changes its parent's text. */
  function place(parentRec, kidRec, beforeRec) {
    if (kidRec.text !== undefined) {
      retext(parentRec)
      return
    }
    if (isRegion(kidRec.tag)) return

    var slot = parentRec.item ? parentRec.item.slot : null
    if (!slot) {
      /* A parent that holds no children — the root, or a text-only
       * node like <bar>. The item exists so its ids stay valid; it just
       * has nowhere to be seen. */
      kidRec.item.visible = false
      return
    }
    kidRec.item.parent = slot
    if (beforeRec && beforeRec.item && beforeRec.item.parent === slot) moveBefore(slot, kidRec.item, beforeRec.item)
  }

  /* QML children are ordered by arrival and there is no insertBefore:
   * to put `item` before `anchor`, everything from the anchor on is
   * re-appended after it. Linear in the tail — fine for a panel. */
  function moveBefore(slot, item, anchor) {
    var kids = slot.children
    var tail = []
    var found = false
    for (var i = 0; i < kids.length; i++) {
      var kid = kids[i]
      if (kid === item) continue
      if (kid === anchor) found = true
      if (found) tail.push(kid)
    }
    for (var t = 0; t < tail.length; t++) {
      tail[t].parent = null
      tail[t].parent = slot
    }
  }

  function retext(rec) {
    if (!rec || !rec.item || !("text" in rec.item)) return
    var joined = ""
    for (var i = 0; i < rec.kids.length; i++) {
      if (rec.kids[i].text !== undefined) joined += rec.kids[i].text
    }
    if (rec.item.text !== joined) rec.item.text = joined
  }

  function coerce(fallback, value) {
    switch (typeof fallback) {
      case "number":
        if (typeof value === "number") return value
        if (value === true) return 1
        if (value === false) return 0
        var n = Number(value)
        return isNaN(n) ? fallback : n
      case "boolean":
        if (typeof value === "boolean") return value
        if (typeof value === "number") return value !== 0
        return value !== "false" && value !== "0"
      case "string":
        return String(value)
      default:
        return value
    }
  }

  function setAttr(rec, name, value) {
    var item = rec.item
    if (!item || !(name in item)) return
    if (!(name in rec.defaults)) rec.defaults[name] = item[name]
    var next = value === null || value === undefined ? rec.defaults[name] : coerce(rec.defaults[name], value)
    try {
      item[name] = next
    } catch (error) {
      console.warn("yeetkit: <" + rec.tag + " " + name + "=" + JSON.stringify(value) + ">: " + error)
    }
  }

  function dispatch(rec, type, payload) {
    if (isRegion(rec.tag)) regionEvent(rec.tag, type, payload || {})
    if (rec.on[type]) up({ t: "event", id: rec.id, type: type, payload: payload || {} })
  }

  /* Not `destroy`: an unqualified call to a function by that name
   * resolves to the Item's own built-in destroy(), and takes the record
   * as a delay — which tears down the client itself. */
  function dispose(rec) {
    if (rec.kids) {
      for (var i = 0; i < rec.kids.length; i++) dispose(rec.kids[i])
    }
    if (rec.item) {
      if (isRegion(rec.tag)) unregister(rec)
      rec.item.parent = null
      rec.item.destroy()
      rec.item = null
    }
    delete nodes[rec.id]
  }

  function register(rec) {
    var next = {}
    for (var name in regions) next[name] = regions[name]
    next[rec.tag] = rec.item
    regions = next
    regionChanged(rec.tag, rec.item)
  }

  function unregister(rec) {
    if (regions[rec.tag] !== rec.item) return
    var next = {}
    for (var name in regions) if (name !== rec.tag) next[name] = regions[name]
    regions = next
    regionChanged(rec.tag, null)
  }

  function reset() {
    var root = nodes[0]
    if (root) dispose(root)
    nodes = {}
    regions = {}
  }

  // ---- applying patches ------------------------------------------------

  function apply(patch) {
    switch (patch.op) {
      case "batch":
        for (var i = 0; i < patch.patches.length; i++) apply(patch.patches[i])
        return

      case "mount": {
        reset()
        title = patch.title || ""
        var rootRec = { id: 0, tag: "#root", item: null, kids: [], parent: null, on: {}, defaults: {} }
        nodes[0] = rootRec
        var kids = patch.root.kids || []
        for (var k = 0; k < kids.length; k++) {
          var kid = build(kids[k], rootRec)
          rootRec.kids.push(kid)
          place(rootRec, kid, null)
        }
        phase = "live"
        break
      }

      case "insert": {
        var parentRec = nodes[patch.parent]
        if (!parentRec) return
        var beforeRec = patch.before === null || patch.before === undefined ? null : nodes[patch.before]
        var rec = build(patch.node, parentRec)
        var at = beforeRec ? parentRec.kids.indexOf(beforeRec) : -1
        if (at >= 0) parentRec.kids.splice(at, 0, rec)
        else parentRec.kids.push(rec)
        place(parentRec, rec, beforeRec)
        break
      }

      case "remove": {
        var gone = nodes[patch.id]
        if (!gone) return
        var owner = gone.parent
        if (owner) {
          var index = owner.kids.indexOf(gone)
          if (index >= 0) owner.kids.splice(index, 1)
        }
        dispose(gone)
        if (owner && gone.text !== undefined) retext(owner)
        break
      }

      case "text": {
        var textRec = nodes[patch.id]
        if (!textRec || textRec.text === undefined) return
        textRec.text = String(patch.value)
        retext(textRec.parent)
        break
      }

      case "attr": {
        var target = nodes[patch.id]
        if (target && target.item) setAttr(target, patch.name, patch.value)
        break
      }

      case "listen": {
        var listening = nodes[patch.id]
        if (listening && listening.on) listening.on[patch.type] = true
        break
      }

      case "unlisten": {
        var quiet = nodes[patch.id]
        if (quiet && quiet.on) delete quiet.on[patch.type]
        break
      }

      /* The isolate redirected. Nothing owns a URL bar here, but the
       * next `hello` should say where the app thinks it is. */
      case "nav":
        path = patch.href
        break

      /* Replies to island calls and streams. A plugin has no islands,
       * so nothing waits for these. */
      default:
        break
    }
    applied(patch)
  }
}
