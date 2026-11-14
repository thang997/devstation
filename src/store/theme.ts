import { useSyncExternalStore } from "react";
import { isTauri } from "@tauri-apps/api/core";

export type Theme = "dark" | "light";

const KEY = "devstation.theme";

function read(): Theme {
  try {
    return globalThis.localStorage?.getItem(KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

let theme: Theme = read();
const subs = new Set<() => void>();

/** Áp theme vào DOM (biến CSS qua data-theme) và vào thanh tiêu đề gốc của cửa sổ. */
function apply(t: Theme) {
  document.documentElement.dataset.theme = t;
  document.documentElement.style.colorScheme = t;
  if (isTauri()) {
    // Cho thanh tiêu đề native (Windows) đổi theo; lỗi quyền thì bỏ qua, UI vẫn đổi.
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().setTheme(t))
      .catch(() => {});
  }
}

/** Gọi một lần lúc khởi động để áp theme đã lưu trước khi render. */
export function initTheme() {
  apply(theme);
}

export function setTheme(t: Theme) {
  theme = t;
  try {
    globalThis.localStorage?.setItem(KEY, t);
  } catch {
    /* hết chỗ / riêng tư — vẫn đổi trong phiên này */
  }
  apply(t);
  subs.forEach((f) => f());
}

export function toggleTheme() {
  setTheme(theme === "dark" ? "light" : "dark");
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (cb) => { subs.add(cb); return () => { subs.delete(cb); }; },
    () => theme,
  );
}
