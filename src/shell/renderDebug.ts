import { useWorkbench } from "../store/workbench";

/**
 * Log render để kiểm tra hiệu năng: bật bằng lệnh Ctrl+G "Bật/tắt log render" (nhớ localStorage).
 * Component gọi `renderLog("Tên")` ở đầu thân hàm; mỗi giây gộp số lần render theo tên ghi ra panel Output
 * (+ console) — vd. `[render] GridRow×12 · ResultGrid×1`. Tắt thì `renderLog` không làm gì (gần như 0 chi phí).
 * Không phải hook React → gọi ở đâu trong thân component cũng được (kể cả trước `return` sớm).
 */
const KEY = "devstation.debugRender";
let on = localStorage.getItem(KEY) === "1";
const counts = new Map<string, number>();
let timer: ReturnType<typeof setTimeout> | undefined;

function flush() {
  timer = undefined;
  if (!counts.size) return;
  const line = [...counts].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(" · ");
  counts.clear();
  console.debug("[render]", line);
  useWorkbench.getState().log(`[render] ${line}`);
}

export function renderLog(name: string): void {
  if (!on) return;
  counts.set(name, (counts.get(name) ?? 0) + 1);
  timer ??= setTimeout(flush, 1000);
}

export function renderLogOn(): boolean {
  return on;
}

export function toggleRenderLog(): boolean {
  on = !on;
  localStorage.setItem(KEY, on ? "1" : "0");
  if (!on) counts.clear();
  return on;
}
