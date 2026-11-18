import { isTauri } from "@tauri-apps/api/core";
import type { AppId } from "../apps/types";
import { useWorkbench } from "../store/workbench";
import { t, type TKey } from "../store/lang";

/**
 * Mỗi app một CỬA SỔ Windows riêng (kiểu "New Window" của VS Code) → chuyển qua lại bằng Alt+Tab.
 *
 * - Cửa sổ đầu tiên (label "main") mở lên là màn hình chính; chọn app ở đó thì CHÍNH cửa sổ này thành app đó.
 * - Đang ở trong một app mà mở app khác (Ctrl+G / Ctrl+1..9) → app đó đã có cửa sổ thì đưa lên trước,
 *   chưa có thì mở cửa sổ mới `index.html?app=<id>` (label `app-<id>`).
 * - Sổ đăng ký cửa sổ→app nằm ở localStorage (dùng chung mọi cửa sổ, cùng origin); luôn kiểm tra lại
 *   cửa sổ còn tồn tại trước khi dùng (sổ có thể còn mục cũ nếu app bị tắt ngang).
 */

const REG_KEY = "devstation.windowApps"; // { [label]: AppId }

/** App mà cửa sổ này được mở cho (?app=<id>), null = cửa sổ màn hình chính. */
export const windowAppParam = (() => {
  try { return new URLSearchParams(location.search).get("app") as AppId | null; } catch { return null; }
})();

let label = "main";
let labelReady: Promise<string> = Promise.resolve(label);
if (isTauri()) {
  labelReady = import("@tauri-apps/api/webviewWindow")
    .then((m) => { label = m.getCurrentWebviewWindow().label; return label; })
    .catch(() => label);
}
/** Cửa sổ chính (chạy việc nền một lần: tunnel autostart, kiểm tra cập nhật). */
export const isMainWindow = async () => (await labelReady) === "main";

function readReg(): Record<string, AppId> {
  try { return JSON.parse(localStorage.getItem(REG_KEY) || "{}"); } catch { return {}; }
}
function writeReg(r: Record<string, AppId>) {
  try { localStorage.setItem(REG_KEY, JSON.stringify(r)); } catch { /* bỏ qua */ }
}

/** Ghi nhận cửa sổ này đang chứa app nào (+ đặt tiêu đề cửa sổ). */
export async function registerWindowApp(id: AppId | null) {
  if (!isTauri()) return;
  const l = await labelReady;
  const reg = readReg();
  if (id) reg[l] = id; else delete reg[l];
  writeReg(reg);
  try {
    const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    await getCurrentWebviewWindow().setTitle(id ? `DevStation — ${t(`apps.${id}.title` as TKey)}` : "DevStation");
  } catch { /* bỏ qua */ }
}

/** Đưa một cửa sổ lên trước (bỏ thu nhỏ, hiện, focus). */
async function focusWindow(w: { unminimize(): Promise<void>; show(): Promise<void>; setFocus(): Promise<void> }) {
  await w.unminimize().catch(() => {});
  await w.show().catch(() => {});
  await w.setFocus().catch(() => {});
}

/* ── Hỏi "cửa sổ nào đang chứa app X?" qua event Tauri (phát tới mọi cửa sổ) ──
 * Mỗi cửa sổ nghe `ds-app-query`; cửa sổ nào đang có app đó (đang xem hoặc còn giữ trong `mounted`)
 * thì trả `ds-app-here` kèm nhãn của mình. Không ai trả lời trong ~400ms → coi như chưa mở. */
interface AppQuery { id: AppId; nonce: string; from: string }
interface AppHere { nonce: string; label: string; active: boolean }
if (isTauri()) {
  void import("@tauri-apps/api/event").then(({ listen, emit }) =>
    listen<AppQuery>("ds-app-query", async (ev) => {
      const me = await labelReady;
      if (ev.payload.from === me) return;
      const s = useWorkbench.getState();
      if (s.activeApp === ev.payload.id || s.mounted.includes(ev.payload.id)) {
        await emit("ds-app-here", { nonce: ev.payload.nonce, label: me, active: s.activeApp === ev.payload.id } satisfies AppHere);
      }
    }),
  ).catch(() => {});
}

async function askOwner(id: AppId, me: string): Promise<string | null> {
  const { listen, emit } = await import("@tauri-apps/api/event");
  const nonce = Math.random().toString(36).slice(2);
  const found: AppHere[] = [];
  const un = await listen<AppHere>("ds-app-here", (ev) => { if (ev.payload.nonce === nonce) found.push(ev.payload); });
  try {
    await emit("ds-app-query", { id, nonce, from: me } satisfies AppQuery);
    for (let t = 0; t < 8 && !found.some((f) => f.active); t++) await new Promise((r) => setTimeout(r, 50));
  } finally {
    un();
  }
  // Ưu tiên cửa sổ đang HIỂN THỊ app đó; nếu chỉ còn giữ ở nền thì cửa sổ đó cũng tự chuyển sang app (xem ds-app-show).
  const hit = found.find((f) => f.active) ?? found[0];
  if (hit && !hit.active) await emit("ds-app-show", { id, label: hit.label });
  return hit?.label ?? null;
}
if (isTauri()) {
  void import("@tauri-apps/api/event").then(({ listen }) =>
    listen<{ id: AppId; label: string }>("ds-app-show", async (ev) => {
      if (ev.payload.label === (await labelReady)) useWorkbench.getState().openApp(ev.payload.id);
    }),
  ).catch(() => {});
}

/**
 * Mở một app: cửa sổ hiện tại chưa có app (màn hình chính) → dùng luôn cửa sổ này;
 * ngược lại → app đã có cửa sổ thì đưa lên trước, chưa có thì mở cửa sổ mới.
 */
export async function launchApp(id: AppId) {
  const s = useWorkbench.getState();
  s.setLauncher(false);
  if (!isTauri() || (!s.activeApp && !s.mounted.length) || s.activeApp === id) {
    s.openApp(id);
    return;
  }
  // App đã chạy ngay trong cửa sổ này (vd. đang ở màn hình chính nhưng app vẫn giữ trạng thái) → chỉ chuyển sang.
  if (s.mounted.includes(id)) { s.openApp(id); return; }
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const me = await labelReady;
  // 1) Hỏi trực tiếp các cửa sổ đang chạy (sự thật hiện tại, không phụ thuộc sổ localStorage có thể lệch).
  const owner = await askOwner(id, me);
  if (owner) {
    const w = await WebviewWindow.getByLabel(owner);
    if (w) { await focusWindow(w); return; }
  }
  // 1b) Dự phòng: sổ đăng ký trong localStorage.
  for (const [l, app] of Object.entries(readReg())) {
    if (app !== id || l === me) continue;
    const w = await WebviewWindow.getByLabel(l);
    if (w) { await focusWindow(w); return; }
  }
  // 2) Chưa có → mở cửa sổ mới cho app.
  const l = `app-${id}`;
  const existing = await WebviewWindow.getByLabel(l);
  if (existing) { await focusWindow(existing); return; }
  const w = new WebviewWindow(l, {
    url: `index.html?app=${id}`,
    title: `DevStation — ${t(`apps.${id}.title` as TKey)}`,
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    center: true,
    theme: (document.documentElement.dataset.theme === "light" ? "light" : "dark"),
    backgroundColor: document.documentElement.dataset.theme === "light" ? "#f4f5f7" : "#0d1117",
    dragDropEnabled: false,
  });
  w.once("tauri://error", (e) => {
    useWorkbench.getState().log(`✗ ${t("shell.cannotOpenWindow")}: ${String(e.payload)}`);
  });
}

/** Cửa sổ app: tắt app = đóng cửa sổ; trước khi đóng gỡ khỏi sổ đăng ký. */
export async function closeThisWindow() {
  await registerWindowApp(null);
  if (!isTauri()) return;
  const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  await getCurrentWebviewWindow().close().catch(() => {});
}

/** Gỡ cửa sổ này khỏi sổ đăng ký khi bị đóng (nút X của Windows). */
export function unregisterOnClose() {
  if (!isTauri()) return;
  const drop = () => { const reg = readReg(); delete reg[label]; writeReg(reg); };
  window.addEventListener("beforeunload", drop);
  void import("@tauri-apps/api/webviewWindow").then((m) => m.getCurrentWebviewWindow().onCloseRequested(() => drop())).catch(() => {});
}
