/**
 * Giao diện CodeMirror ăn theo theme sáng/tối của app: mọi màu đọc từ biến CSS (`--bg`, `--fg`… và `--hl-*` định nghĩa
 * trong styles.css cho cả hai theme) → đổi theme không cần dựng lại editor.
 */
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

const MONO = '"Cascadia Mono", "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", "Ubuntu Mono", monospace';

export const edTheme = EditorView.theme({
  "&": { height: "100%", color: "var(--fg)", backgroundColor: "var(--bg)", fontSize: "var(--ed-font, 13px)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: MONO, lineHeight: "1.5" },
  ".cm-content": { caretColor: "var(--fg)", padding: "4px 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--fg)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "var(--hl-selection) !important",
  },
  ".cm-activeLine": { backgroundColor: "var(--hl-active-line)" },
  ".cm-selectionMatch": { backgroundColor: "var(--hl-match)" },
  ".cm-searchMatch": { backgroundColor: "var(--hl-search)", outline: "1px solid var(--warn)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--hl-search-sel)" },
  "&.cm-focused .cm-matchingBracket": { backgroundColor: "var(--hl-match)", outline: "1px solid var(--muted)" },
  "&.cm-focused .cm-nonmatchingBracket": { color: "var(--danger)" },
  ".cm-gutters": { backgroundColor: "var(--bg-1)", color: "var(--muted)", borderRight: "1px solid var(--line)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--hl-active-line)", color: "var(--fg)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--bg-3)", border: "1px solid var(--line)", color: "var(--muted)", padding: "0 4px" },
  ".cm-tooltip": { backgroundColor: "var(--bg-2)", border: "1px solid var(--line)", color: "var(--fg)", borderRadius: "6px" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--sel)", color: "var(--fg)" },
  // Khung tìm / thay / đi tới dòng: dùng kiểu nút + ô nhập của app.
  ".cm-panels": { backgroundColor: "var(--bg-2)", color: "var(--fg)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--line)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--line)" },
  ".cm-panel.cm-search, .cm-panel.cm-goto-line": { padding: "6px 8px", fontSize: "12.5px" },
  ".cm-dialog-close": { color: "var(--muted)", fontSize: "16px", background: "none", border: "none" },
  ".cm-panel input[type=text], .cm-textfield": {
    backgroundColor: "var(--bg)", color: "var(--fg)", border: "1px solid var(--line)", borderRadius: "6px", padding: "3px 6px", fontSize: "12.5px",
  },
  ".cm-button": { backgroundImage: "none", backgroundColor: "var(--bg-3)", color: "var(--fg)", border: "1px solid var(--line)", borderRadius: "6px", padding: "2px 8px" },
  ".cm-panel.cm-search label": { color: "var(--muted)", fontSize: "12px" },
  ".cm-panel button[name=close]": { color: "var(--muted)", fontSize: "16px" },
  ".cm-lintRange-error": { backgroundImage: "none", textDecoration: "underline wavy var(--danger)" },
  ".cm-diagnostic-error": { borderLeft: "3px solid var(--danger)" },
});

const hl = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], color: "var(--hl-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp, t.inserted], color: "var(--hl-string)" },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit], color: "var(--hl-number)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment, t.meta], color: "var(--hl-comment)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: "var(--hl-function)" },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.variableName)], color: "var(--hl-type)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--hl-property)" },
  { tag: [t.tagName, t.angleBracket], color: "var(--hl-tag)" },
  { tag: [t.attributeValue], color: "var(--hl-string)" },
  { tag: [t.variableName, t.labelName], color: "var(--fg)" },
  { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: "var(--hl-def)" },
  { tag: [t.heading], color: "var(--hl-keyword)", fontWeight: "bold" },
  { tag: [t.link, t.url], color: "var(--hl-function)", textDecoration: "underline" },
  { tag: [t.emphasis], fontStyle: "italic" },
  { tag: [t.strong], fontWeight: "bold" },
  { tag: [t.deleted, t.invalid], color: "var(--danger)" },
  { tag: [t.punctuation, t.separator, t.bracket], color: "var(--hl-punct)" },
  { tag: [t.processingInstruction, t.documentMeta], color: "var(--hl-comment)" },
]);

export const edHighlight = syntaxHighlighting(hl);
