/**
 * Kho tài liệu của Editor + GIỮ PHIÊN kiểu Notepad++:
 * - Mỗi tab một `EdDoc` (siêu dữ liệu). Nội dung đang soạn nằm trong CodeMirror của tab; tab đăng ký `getText`.
 * - Danh sách tab (thứ tự, đường dẫn, ngôn ngữ, encoding…) lưu localStorage `devstation.editor.session`.
 * - Tab CHƯA LƯU (tab mới hoặc đã sửa) ghi bản nháp ra đĩa (`editor_draft_put`, trễ 800ms sau lần gõ cuối) →
 *   tắt app / cửa sổ không hỏi gì, mở lại là còn nguyên. Tab sạch có đường dẫn: mở lại đọc từ đĩa.
 * - Đóng tab (người dùng) mà chưa lưu → hỏi Lưu / Không lưu / Huỷ (`closeGuard`).
 */
import { useSyncExternalStore } from "react";
import { useWorkbench, setCloseGuard } from "../../store/workbench";
import { t } from "../../store/lang";
import { editorApi, type ReadFile } from "./api";
import { detectLang, sniffLang, type LangId } from "./langs";

export interface EdDoc {
  id: string;
  /** Đường dẫn trên đĩa; tab mới / kéo-thả không có. */
  path?: string;
  name: string;
  lang: LangId;
  /** Người dùng tự chọn ngôn ngữ → không tự đoán lại khi dán / lưu. */
  langManual?: boolean;
  encoding: string;
  bom: boolean;
  eol: "\r\n" | "\n";
  dirty: boolean;
  /** Có byte không giải mã được khi mở → hỏi trước khi lưu đè. */
  lossy?: boolean;
  /** Số thứ tự của tab mới chưa đặt tên ("new 1"…). */
  untitled?: number;
}

const SESSION_KEY = "devstation.editor.session";
const RECENT_KEY = "devstation.editor.recent";
const docs = new Map<string, EdDoc>();
/** Nội dung ban đầu cho tab sắp mở (EditorTab lấy một lần khi tạo CodeMirror). */
const initial = new Map<string, string>();
/** Tab đang hiển thị đăng ký hàm lấy nội dung hiện tại. */
const getters = new Map<string, () => string>();
const subs = new Set<() => void>();
let version = 0;
const emit = () => { version++; subs.forEach((f) => f()); };

export const getDoc = (id: string) => docs.get(id);
/** Nội dung để dựng CodeMirror của tab. KHÔNG xoá khi lấy: StrictMode (dev) / tab dựng lại sẽ tạo editor lần nữa —
 *  trước đây lấy xong xoá → lần dựng sau ra tab RỖNG (mất nội dung phiên trước). Xoá khi tab đóng (`onTabsChanged`). */
export const takeInitial = (id: string) => initial.get(id) ?? "";
/** Editor của tab bị huỷ (StrictMode / dựng lại) → cất nội dung đang soạn để lần dựng sau tiếp tục đúng chỗ. */
export const keepText = (id: string, text: string) => { if (docs.has(id)) initial.set(id, text); };
export const registerGetter = (id: string, fn: (() => string) | null) => { if (fn) getters.set(id, fn); else getters.delete(id); };
const textOf = (id: string) => getters.get(id)?.() ?? initial.get(id) ?? "";
/** Re-render component dùng siêu dữ liệu doc (status bar, tiêu đề). */
export const useDocsVersion = () => useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => version);

const uid = () => `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const baseName = (p: string) => p.slice(Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/")) + 1);
const log = (s: string) => useWorkbench.getState().log(s);

/* ── Tiêu đề tab: "● tên" khi chưa lưu ── */
function syncTitle(d: EdDoc) {
  useWorkbench.getState().updateTab(d.id, { title: `${d.dirty ? "● " : ""}${d.name}`, payload: { path: d.path ?? "" } });
}

export function patchDoc(id: string, p: Partial<EdDoc>) {
  const d = docs.get(id);
  if (!d) return;
  const before = d.dirty;
  Object.assign(d, p);
  if ("dirty" in p || "name" in p || "path" in p) syncTitle(d);
  if (before !== d.dirty || "lang" in p || "encoding" in p || "eol" in p || "path" in p || "name" in p) saveSession();
  emit();
}

/* ── Mở / tạo ── */

function addTab(d: EdDoc, text: string) {
  docs.set(d.id, d);
  initial.set(d.id, text);
  useWorkbench.getState().openTab({ id: d.id, appId: "editor", title: `${d.dirty ? "● " : ""}${d.name}`, payload: { path: d.path ?? "" } });
  saveSession();
  emit();
}

function nextUntitled(): number {
  const used = new Set([...docs.values()].map((d) => d.untitled).filter(Boolean));
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

/** Tab mới trống (Ctrl+N) hoặc với nội dung (dán từ app khác). */
export function newDoc(text = "", lang?: LangId) {
  const n = nextUntitled();
  const d: EdDoc = { id: uid(), name: `new ${n}`, untitled: n, lang: lang ?? sniffLang(text), langManual: !!lang, encoding: "utf-8", bom: false, eol: "\r\n", dirty: !!text };
  addTab(d, text);
  if (text) scheduleDraft(d.id);
  return d.id;
}

/** Nhân bản tab (menu "Duplicate" của thanh tab): tab mới chưa đặt tên, cùng nội dung + ngôn ngữ. */
export function duplicateDoc(baseId: string) {
  const d = docs.get(baseId);
  if (d) newDoc(textOf(baseId), d.lang);
}

const findByPath = (path: string) => [...docs.values()].find((d) => d.path?.toLowerCase() === path.toLowerCase());

export async function openPath(path: string) {
  const open = findByPath(path);
  if (open) { useWorkbench.getState().focusTab(open.id); return open.id; }
  let f: ReadFile;
  try {
    f = await editorApi.read(path);
  } catch (e) {
    log(`✗ ${t("editor.openFailed", { name: path })}: ${String(e)}`);
    return null;
  }
  const name = baseName(path);
  const d: EdDoc = { id: uid(), path, name, lang: detectLang(name, f.text), encoding: f.encoding, bom: f.bom, eol: f.eol, dirty: false, lossy: f.lossy };
  addTab(d, f.text);
  addRecent(path);
  if (f.lossy) log(`⚠ ${t("editor.lossyWarn", { name })}`);
  return d.id;
}

export async function openDialog() {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ multiple: true, title: t("editor.aOpen") });
  const list = Array.isArray(picked) ? picked : picked ? [picked] : [];
  for (const p of list) await openPath(p);
}

/** File kéo-thả từ Explorer (WebView không cho đường dẫn) → tab mới mang tên file, Lưu sẽ hỏi chỗ lưu. */
export async function openDropped(files: FileList | File[]) {
  for (const f of Array.from(files)) {
    if (f.size > 50 * 1024 * 1024) { log(`✗ ${t("editor.tooLarge", { name: f.name })}`); continue; }
    const text = await f.text();
    const d: EdDoc = { id: uid(), name: f.name, lang: detectLang(f.name, text), encoding: "utf-8", bom: false, eol: text.includes("\r\n") ? "\r\n" : "\n", dirty: true };
    addTab(d, text);
    scheduleDraft(d.id);
  }
}

/* ── Lưu ── */

/** Nội dung để ghi: đổi xuống dòng theo `eol` của file. */
const forDisk = (text: string, eol: string) => (eol === "\r\n" ? text.replace(/\r?\n/g, "\r\n") : text.replace(/\r\n/g, "\n"));

export async function save(id: string, as = false): Promise<boolean> {
  const d = docs.get(id);
  if (!d) return false;
  let path = d.path;
  if (!path || as) {
    const { save: saveDialog } = await import("@tauri-apps/plugin-dialog");
    const p = await saveDialog({ title: t("editor.aSaveAs"), defaultPath: d.path ?? (d.untitled ? `${d.name}.txt` : d.name) });
    if (!p) return false;
    path = p;
  }
  try {
    await editorApi.write(path, forDisk(textOf(id), d.eol), d.encoding, d.bom);
  } catch (e) {
    log(`✗ ${t("editor.saveFailed", { name: path })}: ${String(e)}`);
    return false;
  }
  const name = baseName(path);
  const wasPathless = !d.path;
  patchDoc(id, { path, name, dirty: false, untitled: undefined, lossy: false, ...(wasPathless && !d.langManual ? { lang: detectLang(name, textOf(id)) } : {}) });
  void editorApi.draftDel(id).catch(() => {});
  addRecent(path);
  return true;
}

/** Đọc lại file từ đĩa (bỏ thay đổi). */
export async function reload(id: string): Promise<string | null> {
  const d = docs.get(id);
  if (!d?.path) return null;
  try {
    const f = await editorApi.read(d.path);
    patchDoc(id, { encoding: f.encoding, bom: f.bom, eol: f.eol, dirty: false, lossy: f.lossy });
    void editorApi.draftDel(id).catch(() => {});
    return f.text;
  } catch (e) {
    log(`✗ ${String(e)}`);
    return null;
  }
}

/* ── Bản nháp (tab chưa lưu) ── */

const draftTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Gọi khi nội dung đổi: đánh dấu chưa lưu + ghi bản nháp sau 800ms. */
export function scheduleDraft(id: string) {
  const d = docs.get(id);
  if (!d) return;
  if (!d.dirty) patchDoc(id, { dirty: true });
  clearTimeout(draftTimers.get(id));
  draftTimers.set(id, setTimeout(() => {
    draftTimers.delete(id);
    const cur = docs.get(id);
    if (cur?.dirty) void editorApi.draftPut(id, textOf(id)).catch(() => {});
  }, 800));
}

/** Ghi ngay mọi bản nháp đang chờ (trước khi tắt cửa sổ). */
export function flushDrafts() {
  for (const [id, tm] of draftTimers) {
    clearTimeout(tm);
    if (docs.get(id)?.dirty) void editorApi.draftPut(id, textOf(id)).catch(() => {});
  }
  draftTimers.clear();
}

/* ── Phiên ── */

interface SessionEntry { id: string; path?: string; name: string; lang: LangId; langManual?: boolean; encoding: string; bom: boolean; eol: "\r\n" | "\n"; dirty: boolean; untitled?: number }

function saveSession() {
  // Chưa khôi phục xong phiên trước → KHÔNG ghi (ghi lúc này = danh sách rỗng/thiếu → mất tab của phiên trước).
  if (!restoreDone) return;
  const tabs = useWorkbench.getState().apps.editor?.tabs ?? [];
  const list: SessionEntry[] = tabs.map((tb) => docs.get(tb.id)).filter((d): d is EdDoc => !!d)
    .map(({ id, path, name, lang, langManual, encoding, bom, eol, dirty, untitled }) => ({ id, path, name, lang, langManual, encoding, bom, eol, dirty, untitled }));
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(list)); } catch { /* đầy → bỏ qua */ }
}

let restored = false;
/** Đã mở lại xong phiên trước → từ giờ mới được ghi phiên. */
let restoreDone = false;
/** Mở lại các tab của phiên trước (gọi một lần khi app Editor nạp). */
export async function restoreSession() {
  if (restored) return;
  restored = true;
  let list: SessionEntry[] = [];
  try { list = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "[]"); } catch { /* hỏng → phiên trống */ }
  const keep: string[] = [];
  for (const e of list) {
    if (e.dirty || !e.path) {
      const text = await editorApi.draftGet(e.id).catch(() => null);
      if (text == null && !e.path) continue; // tab mới mà mất bản nháp → bỏ
      if (text != null) {
        keep.push(e.id);
        addTab({ ...e, dirty: true }, text);
        continue;
      }
    }
    // Tab sạch (hoặc nháp mất nhưng còn file) → đọc lại từ đĩa.
    try {
      const f = await editorApi.read(e.path!);
      addTab({ ...e, encoding: f.encoding, bom: f.bom, eol: f.eol, dirty: false, lossy: f.lossy }, f.text);
    } catch {
      log(`⚠ ${t("editor.missingOnRestore", { name: e.path ?? e.name })}`);
    }
  }
  restoreDone = true;
  // Dọn bản nháp mồ côi (Rust chỉ xoá file cũ hơn 1 ngày — lỡ phiên lỗi vẫn còn nháp để cứu).
  void editorApi.draftGc([...keep, ...useWorkbench.getState().apps.editor.tabs.map((x) => x.id)]).catch(() => {});
  saveSession();
}

/** Thứ tự tab đổi / tab đóng → ghi lại phiên. */
export function onTabsChanged(openIds: Set<string>) {
  for (const id of [...docs.keys()]) {
    if (!openIds.has(id)) {
      docs.delete(id);
      initial.delete(id);
      getters.delete(id);
      clearTimeout(draftTimers.get(id));
      draftTimers.delete(id);
      void editorApi.draftDel(id).catch(() => {});
    }
  }
  saveSession();
  emit();
}

/* ── Đóng tab chưa lưu: Lưu / Không lưu / Huỷ ── */

export type SaveAnswer = "save" | "discard" | "cancel";
interface AskReq { name: string; resolve: (a: SaveAnswer) => void }
let ask: AskReq | null = null;
const askSubs = new Set<() => void>();
export const useSaveAsk = () => useSyncExternalStore((cb) => { askSubs.add(cb); return () => { askSubs.delete(cb); }; }, () => ask);
export function answerSave(a: SaveAnswer) { const r = ask; ask = null; askSubs.forEach((f) => f()); r?.resolve(a); }
function askSave(name: string): Promise<SaveAnswer> {
  return new Promise((resolve) => { ask?.resolve("cancel"); ask = { name, resolve }; askSubs.forEach((f) => f()); });
}

setCloseGuard("editor", async (ids) => {
  const ok: string[] = [];
  for (const id of ids) {
    const d = docs.get(id);
    if (!d?.dirty) { ok.push(id); continue; }
    useWorkbench.getState().focusTab(id);
    const a = await askSave(d.name);
    if (a === "cancel") break; // huỷ → dừng cả loạt (Close all)
    if (a === "save" && !(await save(id))) break;
    ok.push(id);
  }
  return ok;
});

/* ── File gần đây ── */
export interface Recent { path: string; ts: number }
const readRecent = (): Recent[] => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]"); } catch { return []; } };
let recent = readRecent();
const recentSubs = new Set<() => void>();
function addRecent(path: string) {
  recent = [{ path, ts: Date.now() }, ...recent.filter((r) => r.path.toLowerCase() !== path.toLowerCase())].slice(0, 20);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(recent)); } catch { /* bỏ qua */ }
  recentSubs.forEach((f) => f());
}
export const useRecent = () => useSyncExternalStore((cb) => { recentSubs.add(cb); return () => { recentSubs.delete(cb); }; }, () => recent);
export function removeRecent(path: string) {
  recent = recent.filter((r) => r.path !== path);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(recent)); } catch { /* bỏ qua */ }
  recentSubs.forEach((f) => f());
}
