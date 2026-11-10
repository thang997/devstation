import type { AppId, AppManifest, AppModule } from "./types";

/**
 * Thứ tự ở đây = thứ tự icon trên activity bar = phím tắt Ctrl+1..9.
 * Thêm app mới: tạo `src/apps/<id>/index.tsx` (export default AppModule) rồi khai báo ở đây.
 * KHÔNG import tĩnh app ở bất kỳ đâu khác, nếu không Vite sẽ gộp nó vào bundle chính.
 */
export const APPS: AppManifest[] = [
  { id: "git", title: "Git", icon: "🌿", load: () => import("./git") },
  { id: "http", title: "HTTP Client", icon: "⚡", load: () => import("./http") },
  { id: "ssh", title: "SSH", icon: "🖥", load: () => import("./ssh") },
  { id: "tools", title: "Tiện ích", icon: "🧰", load: () => import("./tools") },
];

export const appById = (id: AppId) => APPS.find((a) => a.id === id)!;

/** Phím tắt chuyển app, vd. "Ctrl+1". */
export const appShortcut = (id: AppId) => `Ctrl+${APPS.findIndex((a) => a.id === id) + 1}`;

const pending = new Map<AppId, Promise<AppModule>>();
const ready = new Map<AppId, AppModule>();

/** Tải code của app (chỉ một lần). Trả về cùng một promise để dùng với `use()` của React. */
export function loadApp(id: AppId): Promise<AppModule> {
  let p = pending.get(id);
  if (!p) {
    p = appById(id)
      .load()
      .then((m) => {
        ready.set(id, m.default);
        return m.default;
      })
      .catch((e) => {
        pending.delete(id); // cho phép thử lại
        throw e;
      });
    pending.set(id, p);
  }
  return p;
}

/** Module đã tải xong (hoặc undefined nếu chưa) — dùng cho palette. */
export const loadedApp = (id: AppId) => ready.get(id);
