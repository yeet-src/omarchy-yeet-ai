import QtQuick
import qs.Commons

// <prose size>  a paragraph the reader can select and copy, with a
// little markup: the child string may carry <b>, <i> and <u>. Escape
// nothing else: the client hands the string in as `text`, and only
// those three tags are honoured, so a stray angle bracket stays text.
TextEdit {
  id: root
  property var client: null
  property int nodeId: 0
  property Item slot: null
  signal ev(string type, var payload)

  property string size: "bodySmall"

  readonly property bool inRow: parent ? parent.axis === "x" : false
  anchors.left: parent && !inRow ? parent.left : undefined
  anchors.right: parent && !inRow ? parent.right : undefined

  readOnly: true
  selectByMouse: true
  textFormat: TextEdit.RichText
  wrapMode: TextEdit.WordWrap
  color: Color.popups.text
  selectionColor: Color.accent
  selectedTextColor: Color.popups.background
  font.family: Style.font.family
  font.pixelSize: Style.font[size] || Style.font.bodySmall
  renderType: Text.QtRendering
  font.hintingPreference: Font.PreferNoHinting

  /* The client sets `text` from the child string; it is escaped except
   * for the three tags, and written back as rich text. */
  property bool rewriting: false
  onTextChanged: {
    if (rewriting) return
    rewriting = true
    var raw = root.getText(0, root.length)
    var safe = raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    safe = safe.replace(/&lt;(\/?)(b|i|u)&gt;/g, "<$1$2>")
    root.text = "<span style=\"white-space: pre-wrap\">" + safe + "</span>"
    rewriting = false
  }
  /* A panel's key catcher takes keys first; while a selection is being
   * made here it has to stand aside. */
  onActiveFocusChanged: if (client) client.inputFocus = activeFocus
}
