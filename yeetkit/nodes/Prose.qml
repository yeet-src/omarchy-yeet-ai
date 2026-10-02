import QtQuick
import qs.Commons

// <prose size>  a paragraph the reader can select and copy, with a
// little markup: **bold**, *italic* and __underline__, and a newline is
// a line break. Angle brackets are escaped, so nothing in the string
// becomes markup of its own — and the compiler escapes them in a page's
// string literals anyway, which is why the markup is not tags.
//
// An Item around the TextEdit: the client sets `text` from the child
// string, and a rich-text edit would fold the string's newlines while
// parsing it, before anything here could turn them into breaks.
Item {
  id: root
  property var client: null
  property int nodeId: 0
  property Item slot: null
  signal ev(string type, var payload)
  /** What a patch may set here; see Yeetkit.setAttr. */
  readonly property var attrs: ["size"]

  property string text: ""
  property string size: "bodySmall"

  readonly property bool inRow: parent ? parent.axis === "x" : false
  anchors.left: parent && !inRow ? parent.left : undefined
  anchors.right: parent && !inRow ? parent.right : undefined
  implicitWidth: body.implicitWidth
  implicitHeight: body.implicitHeight
  height: implicitHeight

  function rich(raw) {
    var safe = String(raw).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    safe = safe.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    safe = safe.replace(/__(.+?)__/g, "<u>$1</u>")
    safe = safe.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, "$1<i>$2</i>")
    return safe.replace(/\r?\n/g, "<br>")
  }

  TextEdit {
    id: body
    width: root.width
    readOnly: true
    selectByMouse: true
    textFormat: TextEdit.RichText
    wrapMode: TextEdit.WordWrap
    color: Color.popups.text
    selectionColor: Color.accent
    selectedTextColor: Color.popups.background
    font.family: Style.font.family
    font.pixelSize: Style.font[root.size] || Style.font.bodySmall
    renderType: Text.QtRendering
    font.hintingPreference: Font.PreferNoHinting
    text: root.rich(root.text)
    /* A panel's key catcher takes keys first; while a selection is
     * being made here it has to stand aside. */
    onActiveFocusChanged: if (root.client) root.client.inputFocus = activeFocus
  }
}
