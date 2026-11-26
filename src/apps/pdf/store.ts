import { useSyncExternalStore } from "react";
import { useWorkbench } from "../../store/workbench";
import { t } from "../../store/lang";
import { pdfApi } from "./api";

/** Nội dung file của từng tab (byte gốc — pdf.js nhận BẢN SAO vì nó chuyển buffer sang worker). */
export interface PdfDoc {
  /** Byte của file. File CÓ đường dẫn: chỉ giữ tới khi pdf.js nhận (chuyển hẳn sang worker, không chép) — sau đó
   *  undefined, cần lại thì đọc từ đĩa (`docBytes`). File kéo-thả: giữ suốt (không có nơi đọc lại). */
  bytes?: Uint8Array;
  name: string;
  /** Đường dẫn trên đĩa (file kéo-thả không có). */
  path?: string;
}
const docs = new Map<string, PdfDoc>();
export const getDoc = (tabId: string) => docs.get(tabId);

/** Byte của tài liệu: còn trong RAM thì dùng, không thì đọc lại từ đĩa. */
export async function docBytes(d: PdfDoc): Promise<Uint8Array> {
  if (d.bytes) return d.bytes;
  if (!d.path) throw new Error("no data");
  return new Uint8Array(await pdfApi.read(d.path));
}

/** Kiểm chữ ký: file có đường dẫn → Rust đọc thẳng từ đĩa; kéo-thả → gửi byte. */
export const verifyDoc = (d: PdfDoc) => (d.path ? pdfApi.verifyPath(d.path) : pdfApi.verify(d.bytes ?? new Uint8Array()));
/** Giải phóng byte của tab đã đóng. */
export function pruneDocs(openIds: Set<string>) {
  for (const id of [...docs.keys()]) if (!openIds.has(id)) docs.delete(id);
}

const baseName = (p: string) => p.slice(Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/")) + 1);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/* ── File gần đây (chỉ file có đường dẫn) ── */
export interface Recent { path: string; name: string; ts: number }
const RECENT_KEY = "devstation.pdf.recent";
const readRecent = (): Recent[] => {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]"); } catch { return []; }
};
let recent = readRecent();
const recentSubs = new Set<() => void>();
const emitRecent = () => recentSubs.forEach((f) => f());
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => { if (e.key === RECENT_KEY) { recent = readRecent(); emitRecent(); } });
}
function setRecent(list: Recent[]) {
  recent = list.slice(0, 20);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(recent)); } catch { /* bỏ qua */ }
  emitRecent();
}
export const useRecent = () =>
  useSyncExternalStore((cb) => { recentSubs.add(cb); return () => { recentSubs.delete(cb); }; }, () => recent);
export const removeRecent = (path: string) => setRecent(recent.filter((r) => r.path !== path));
export const clearRecent = () => setRecent([]);

/** Mở một file đã có byte (đọc từ đĩa, kéo-thả, hoặc "bản lúc ký"). */
export function openPdfBytes(bytes: Uint8Array, name: string, path?: string) {
  const wb = useWorkbench.getState();
  const id = path ? `pdf:${path.toLowerCase()}` : `pdf:mem:${uid()}`;
  // Tab cùng file đã mở → đóng rồi mở lại để nạp nội dung mới (file có thể đã đổi trên đĩa).
  if (wb.apps.pdf.tabs.some((x) => x.id === id)) wb.closeTab(id);
  docs.set(id, { bytes, name, path });
  if (path) setRecent([{ path, name, ts: Date.now() }, ...recent.filter((r) => r.path.toLowerCase() !== path.toLowerCase())]);
  wb.openTab({ id, appId: "pdf", title: name, payload: { path: path ?? "", name } });
}

export async function openPdfPath(path: string) {
  try {
    const buf = await pdfApi.read(path);
    openPdfBytes(new Uint8Array(buf), baseName(path), path);
  } catch (e) {
    useWorkbench.getState().log(`✗ ${t("pdf.openFailed", { name: path })}: ${String(e)}`);
    throw e;
  }
}

export async function openPdfDialog() {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ multiple: true, filters: [{ name: "PDF", extensions: ["pdf"] }] });
  const list = Array.isArray(picked) ? picked : picked ? [picked] : [];
  for (const p of list) await openPdfPath(p).catch(() => {});
}

/** File kéo-thả (WebView không cho biết đường dẫn → giữ byte trong RAM). */
export async function openDroppedFiles(files: FileList | File[]) {
  for (const f of Array.from(files)) {
    if (!/\.pdf$/i.test(f.name) && f.type !== "application/pdf") continue;
    openPdfBytes(new Uint8Array(await f.arrayBuffer()), f.name);
  }
}

/** Lấy các file được mở từ Explorer (hàng đợi phía Rust). */
export async function takePending() {
  const list = await pdfApi.takePending().catch(() => [] as string[]);
  for (const p of list) await openPdfPath(p).catch(() => {});
}

/** Đặt DevStation làm app mở PDF: đăng ký + hộp thoại Windows, rồi báo kết quả ra Output. */
export async function setDefaultPdfApp(file?: string) {
  const log = useWorkbench.getState().log;
  try {
    const st = await pdfApi.registerDefault(file);
    if (st.isDefault) log(`✓ ${t("pdf.defaultDone")}`);
    else log(`⚠ ${t("pdf.defaultNotChosen")}`);
    if (st.dev) log(`⚠ ${t("pdf.defaultDev")}`);
    return st;
  } catch (e) {
    log(`✗ ${String(e)}`);
    return null;
  }
}

/* ── Danh sách Trust thay đổi → mọi tab kiểm lại chữ ký ── */
let trustVer = 0;
const trustSubs = new Set<() => void>();
export const bumpTrust = () => { trustVer++; trustSubs.forEach((f) => f()); };
export const useTrustVersion = () =>
  useSyncExternalStore((cb) => { trustSubs.add(cb); return () => { trustSubs.delete(cb); }; }, () => trustVer);

/** Chứng thư DER base64 → PEM (để lưu .cer). */
export function derToPem(b64: string) {
  return `-----BEGIN CERTIFICATE-----\n${b64.match(/.{1,64}/g)?.join("\n") ?? b64}\n-----END CERTIFICATE-----\n`;
}

export const fmtTime = (sec: number | null | undefined) => (sec ? new Date(sec * 1000).toLocaleString() : "—");
