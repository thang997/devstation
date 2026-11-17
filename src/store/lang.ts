import { createElement, Fragment, useSyncExternalStore, type ReactNode } from "react";
import en from "../locales/en.json";

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

/** Đổi ngôn ngữ: nạp file JSON của ngôn ngữ đó (nếu chưa) rồi mới áp dụng → không nháy chữ. */
export function setLang(l: Lang) {
  void loadLang(l).then(() => applyLang(l));
}

function applyLang(l: Lang) {
  lang = l;
  try {
    globalThis.localStorage?.setItem(KEY, l);
  } catch {
    /* hết chỗ — vẫn đổi trong phiên */
  }
  subs.forEach((f) => f());
}

// Mỗi app một cửa sổ: đổi ngôn ngữ ở cửa sổ khác (localStorage dùng chung) → cửa sổ này đổi theo.
globalThis.addEventListener?.("storage", (e: StorageEvent) => {
  if (e.key !== KEY) return;
  const l: Lang = e.newValue === "vi" ? "vi" : "en";
  if (l !== lang) void loadLang(l).then(() => { lang = l; subs.forEach((f) => f()); });
});

export function toggleLang() {
  setLang(lang === "en" ? "vi" : "en");
}

export function getLang(): Lang {
  return lang;
}

export function useLang(): Lang {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => lang);
}

/* ── Chuỗi giao diện: mỗi ngôn ngữ một file JSON ở src/locales/<lang>.json ──────────
   Khoá dạng "<nhóm>.<tên>" (nhóm = app: db/git/ssh/http/redis/tools, hoặc shell/common).
   Biến chèn viết {tên} trong JSON, truyền qua params: tr("db.dropTable", { name }).
   en.json là gốc: kiểu TKey sinh từ nó → gõ sai/thiếu khoá là lỗi lúc build.
   Thêm ngôn ngữ mới: tạo <lang>.json cùng cấu trúc + thêm vào Lang/DICTS. */

type Dict = typeof en;
type Leaf<T> = { [K in keyof T & string]: T[K] extends string ? K : `${K}.${Leaf<T[K]>}` }[keyof T & string];
/** Mọi khoá hợp lệ (lấy từ en.json). */
export type TKey = Leaf<Dict>;
export type TParams = Record<string, string | number | null | undefined>;

/** en.json nằm sẵn trong bundle (gốc + dự phòng); ngôn ngữ khác tải lười khi cần (giảm ~35 KB lúc khởi động). */
const DICTS: Partial<Record<Lang, unknown>> = { en };
const LOADERS: Record<Lang, () => Promise<unknown>> = {
  en: async () => en,
  vi: () => import("../locales/vi.json").then((m) => m.default),
};

/** Nạp file ngôn ngữ (gọi một lần ở main.tsx trước khi render với ngôn ngữ đã lưu). */
export async function loadLang(l: Lang = lang): Promise<void> {
  if (DICTS[l]) return;
  try { DICTS[l] = await LOADERS[l](); } catch { /* lỗi nạp → dùng tiếng Anh */ }
}

function lookup(dict: unknown, key: string): string | undefined {
  let o: unknown = dict;
  for (const part of key.split(".")) {
    if (o == null || typeof o !== "object") return undefined;
    o = (o as Record<string, unknown>)[part];
  }
  return typeof o === "string" ? o : undefined;
}

function translate(l: Lang, key: TKey, params?: TParams): string {
  // Thiếu bản dịch → lùi về tiếng Anh → cuối cùng hiện chính khoá (dễ thấy để bổ sung).
  const s = lookup(DICTS[l], key) ?? lookup(DICTS.en, key) ?? key;
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k] ?? "") : m));
}

/** Chuỗi có phần tử React bên trong (chữ đậm, nút…): JSON giữ chỗ {tên}, ở đây thay bằng node.
 *  Dùng: rich(tr("git.deleteLocalBranch"), { name: <b>{b.name}</b> }) — tr KHÔNG truyền params để giữ nguyên {tên}. */
export function rich(text: string, nodes: Record<string, ReactNode>): ReactNode {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(/\{(\w+)\}/g)) {
    if (!(m[1] in nodes)) continue;
    out.push(text.slice(last, m.index));
    out.push(createElement(Fragment, { key: i++ }, nodes[m[1]]));
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return createElement(Fragment, null, ...out);
}

/** Lấy chuỗi theo một ngôn ngữ cụ thể (vd. gom cả en + vi vào chỉ mục tìm kiếm). */
export function tIn(l: Lang, key: TKey, params?: TParams): string {
  return translate(l, key, params);
}

/** Lấy chuỗi theo ngôn ngữ hiện tại. KHÔNG phản ứng (đọc lúc gọi) — dùng ngoài component. */
export function t(key: TKey, params?: TParams): string {
  return translate(lang, key, params);
}

/** Hook: trả về hàm dịch + tự re-render khi đổi ngôn ngữ. `const tr = useT();` rồi `tr("db.save")`. */
export function useT(): (key: TKey, params?: TParams) => string {
  const l = useLang();
  return (key, params) => translate(l, key, params);
}
