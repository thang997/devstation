/**
 * Phím tắt của Editor — MỘT nguồn cho cả keymap CodeMirror (`cm`) lẫn bảng "Phím tắt" (F1).
 * `action` = id hành động do EditorTab xử lý; mục không có `action` là phím có sẵn của CodeMirror (chỉ để hiển thị).
 * Tránh phím toàn cục của DevStation: Ctrl+G (launcher), Ctrl+B, Ctrl+Tab, Ctrl+1..9, Ctrl+`, Ctrl+W, Ctrl+Shift+W.
 */
import type { TKey } from "../../store/lang";

export type ActionId =
  | "new" | "open" | "save" | "saveAs" | "reload"
  | "format" | "minify" | "b64decode" | "b64encode" | "urlDecode" | "urlEncode" | "jwtDecode"
  | "upper" | "lower" | "sortAsc" | "sortDesc" | "unique" | "trimTrailing" | "joinLines" | "removeEmpty"
  | "validate" | "gotoLine" | "replace" | "duplicateLine" | "wrap" | "zoomIn" | "zoomOut" | "zoomReset" | "shortcuts";

export interface Shortcut {
  /** Phím hiển thị (Windows). */
  keys: string;
  /** Khoá CodeMirror ("Mod-Shift-f"); không có = phím có sẵn của CodeMirror hoặc chỉ có trong menu. */
  cm?: string;
  action?: ActionId;
  label: TKey;
}
export interface ShortcutGroup { title: TKey; items: Shortcut[] }

export const SHORTCUTS: ShortcutGroup[] = [
  {
    title: "editor.kgFile",
    items: [
      { keys: "Ctrl+N", cm: "Mod-n", action: "new", label: "editor.aNew" },
      { keys: "Ctrl+O", cm: "Mod-o", action: "open", label: "editor.aOpen" },
      { keys: "Ctrl+S", cm: "Mod-s", action: "save", label: "editor.aSave" },
      { keys: "Ctrl+Shift+S", cm: "Mod-Shift-s", action: "saveAs", label: "editor.aSaveAs" },
      { keys: "Ctrl+W", label: "editor.aClose" },
    ],
  },
  {
    title: "editor.kgEdit",
    items: [
      { keys: "Ctrl+Z", label: "editor.aUndo" },
      { keys: "Ctrl+Y / Ctrl+Shift+Z", label: "editor.aRedo" },
      { keys: "Ctrl+D", cm: "Mod-d", action: "duplicateLine", label: "editor.aDuplicateLine" },
      { keys: "Ctrl+Shift+K", label: "editor.aDeleteLine" },
      { keys: "Alt+↑ / Alt+↓", label: "editor.aMoveLine" },
      { keys: "Shift+Alt+↑ / ↓", label: "editor.aCopyLine" },
      { keys: "Ctrl+/", label: "editor.aComment" },
      { keys: "Tab / Shift+Tab", label: "editor.aIndent" },
      { keys: "Ctrl+Alt+↑ / ↓", label: "editor.aCursorAboveBelow" },
      { keys: "Alt+Click", label: "editor.aAddCursor" },
      { keys: "Ctrl+Shift+L", label: "editor.aSelectAllMatches" },
      { keys: "Ctrl+A", label: "editor.aSelectAll" },
    ],
  },
  {
    title: "editor.kgSearch",
    items: [
      { keys: "Ctrl+F", label: "editor.aFind" },
      { keys: "Ctrl+H", cm: "Mod-h", action: "replace", label: "editor.aReplace" },
      { keys: "F3 / Shift+F3", label: "editor.aFindNext" },
      { keys: "Ctrl+L", cm: "Mod-l", action: "gotoLine", label: "editor.aGotoLine" },
    ],
  },
  {
    title: "editor.kgTransform",
    items: [
      { keys: "Ctrl+Shift+F", cm: "Mod-Shift-f", action: "format", label: "editor.aFormat" },
      { keys: "Ctrl+Shift+M", cm: "Mod-Shift-m", action: "minify", label: "editor.aMinify" },
      { keys: "Ctrl+Alt+V", cm: "Mod-Alt-v", action: "validate", label: "editor.aValidate" },
      { keys: "Ctrl+Alt+B", cm: "Mod-Alt-b", action: "b64decode", label: "editor.aB64Decode" },
      { keys: "Ctrl+Alt+Shift+B", cm: "Mod-Alt-Shift-b", action: "b64encode", label: "editor.aB64Encode" },
      { keys: "Ctrl+Alt+U", cm: "Mod-Alt-u", action: "urlDecode", label: "editor.aUrlDecode" },
      { keys: "Ctrl+Alt+Shift+U", cm: "Mod-Alt-Shift-u", action: "urlEncode", label: "editor.aUrlEncode" },
      { keys: "Ctrl+Alt+J", cm: "Mod-Alt-j", action: "jwtDecode", label: "editor.aJwtDecode" },
      { keys: "Ctrl+U", cm: "Mod-u", action: "lower", label: "editor.aLower" },
      { keys: "Ctrl+Shift+U", cm: "Mod-Shift-u", action: "upper", label: "editor.aUpper" },
      { keys: "—", action: "sortAsc", label: "editor.aSortAsc" },
      { keys: "—", action: "sortDesc", label: "editor.aSortDesc" },
      { keys: "—", action: "unique", label: "editor.aUnique" },
      { keys: "—", action: "trimTrailing", label: "editor.aTrimTrailing" },
      { keys: "—", action: "removeEmpty", label: "editor.aRemoveEmpty" },
      { keys: "—", action: "joinLines", label: "editor.aJoinLines" },
    ],
  },
  {
    title: "editor.kgView",
    items: [
      { keys: "Alt+Z", cm: "Alt-z", action: "wrap", label: "editor.aWrap" },
      { keys: "Ctrl+= / Ctrl+-", cm: "Mod-=", action: "zoomIn", label: "editor.aZoom" },
      { keys: "Ctrl+0", cm: "Mod-0", action: "zoomReset", label: "editor.aZoomReset" },
      { keys: "Ctrl+Shift+[ / ]", label: "editor.aFold" },
      { keys: "F1", cm: "F1", action: "shortcuts", label: "editor.aShortcuts" },
    ],
  },
];

/** Phím CodeMirror phụ (không hiện riêng trong bảng — đã gộp vào dòng khác). */
export const EXTRA_KEYS: { cm: string; action: ActionId }[] = [{ cm: "Mod--", action: "zoomOut" }];

/** Phím hiển thị của một hành động (cho menu chuột phải / tooltip). */
export function keysOf(action: ActionId): string {
  for (const g of SHORTCUTS) for (const s of g.items) if (s.action === action && s.keys !== "—") return s.keys;
  return "";
}
