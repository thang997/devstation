import { useSyncExternalStore } from "react";

/** Ngôn ngữ giao diện. Mặc định tiếng Anh. */
export type Lang = "en" | "vi";

const KEY = "devstation.lang";

function read(): Lang {
  try {
    return globalThis.localStorage?.getItem(KEY) === "vi" ? "vi" : "en";
  } catch {
    return "en";
  }
}

let lang: Lang = read();
const subs = new Set<() => void>();

export function setLang(l: Lang) {
  lang = l;
  try {
    globalThis.localStorage?.setItem(KEY, l);
  } catch {
    /* hết chỗ — vẫn đổi trong phiên */
  }
  subs.forEach((f) => f());
}

export function toggleLang() {
  setLang(lang === "en" ? "vi" : "en");
}

export function getLang(): Lang {
  return lang;
}

export function useLang(): Lang {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => lang);
}

/** Chọn giá trị theo ngôn ngữ hiện tại. Dùng: `t("Save", "Lưu")` (hoặc JSX). KHÔNG phản ứng — đọc lúc gọi. */
export function t<T>(en: T, vi: T): T {
  return lang === "vi" ? vi : en;
}

/** Hook: trả về hàm `t` + tự re-render khi đổi ngôn ngữ. Dùng trong component: `const tr = useT();` rồi `tr("Save","Lưu")`. */
export function useT(): <T>(en: T, vi: T) => T {
  const l = useLang();
  return (en, vi) => (l === "vi" ? vi : en);
}
