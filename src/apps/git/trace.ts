import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useWorkbench } from "../../store/workbench";
import { t } from "../../store/lang";
import { repoName } from "./repos";

/**
 * Log thời gian của app Git (lệnh Ctrl+G "Git: bật/tắt log thời gian", nhớ localStorage).
 * - Rust phát `git-trace` cho MỖI tiến trình git (lệnh, ms, thành công) → ghi `[git ⏱ repo] 123ms git status …`.
 * - UI ghi từng bước nạp repo (`traceStep`) và tổng (`traceDone`) → biết phần nào chậm: git hay vẽ giao diện.
 * Tắt thì không phát event, `traceStep` không làm gì.
 */
const KEY = "devstation.git.trace";
let on = localStorage.getItem(KEY) === "1";
let listening = false;

const log = (s: string) => useWorkbench.getState().log(s);

function sync() {
  if (!isTauri()) return;
  void invoke("git_set_trace", { on }).catch(() => {});
  if (on && !listening) {
    listening = true;
    void listen<{ cwd: string; args: string; ms: number; ok: boolean }>("git-trace", (ev) => {
      if (!on) return;
      const { cwd, args, ms, ok } = ev.payload;
      const short = args.length > 140 ? `${args.slice(0, 140)}…` : args;
      log(`[git ⏱ ${repoName(cwd)}] ${String(ms).padStart(5)}ms ${ok ? " " : "✗"} git ${short}`);
    });
  }
}
sync();

export const traceOn = () => on;

export function toggleTrace() {
  on = !on;
  localStorage.setItem(KEY, on ? "1" : "0");
  sync();
  const s = useWorkbench.getState();
  s.log(on ? t("git.traceOn") : t("git.traceOff"));
  if (on && !s.panelOpen) s.togglePanel();
}

/** Đo một bước phía UI (gọi lệnh + đặt state). Trả về promise gốc. */
export function traceStep<T>(path: string, label: string, p: Promise<T>): Promise<T> {
  if (!on) return p;
  const t0 = performance.now();
  const done = (ok: boolean) => log(`[git ⏱ ${repoName(path)}] ${String(Math.round(performance.now() - t0)).padStart(5)}ms ${ok ? " " : "✗"} ▸ ${label}`);
  p.then(() => done(true), () => done(false));
  return p;
}

/** Ghi tổng thời gian một lượt nạp; `paint` = chờ thêm 2 khung hình để tính cả thời gian React vẽ xong. */
export function traceDone(path: string, label: string, t0: number) {
  if (!on) return;
  const ms = Math.round(performance.now() - t0);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    log(`[git ⏱ ${repoName(path)}] ══ ${t("git.traceTotal", { label, data: ms, paint: Math.round(performance.now() - t0) })}`);
  }));
}
