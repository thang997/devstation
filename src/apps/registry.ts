import { createElement } from "react";
import type { AppId, AppManifest, AppModule } from "./types";
import { Container, FileCode2, FileText, GitBranch, Languages, Send, SquareTerminal, Wrench, Zap, type LucideIcon } from "lucide-react";
import { DbIcon } from "../shell/icons";

/** Icon app trong launcher / status bar: SVG lucide, mỗi app một màu (`.app-ic` cỡ theo chỗ dùng). */
const ic = (C: LucideIcon, color: string) => createElement(C, { className: "app-ic", color });

/**
 * Tên/mô tả hiển thị lấy từ src/locales/<lang>.json (khoá apps.<id>.title / .description);
 * `title`/`description` ở đây là bản tiếng Anh dùng cho tìm kiếm và chỗ không có hook.
 * Thứ tự ở đây = thứ tự MẶC ĐỊNH trong launcher; người dùng kéo-thả để sắp lại (`orderedApps`), phím tắt Ctrl+1..9 theo thứ tự đó.
 * Thêm app mới: tạo `src/apps/<id>/index.tsx` (export default AppModule) rồi khai báo ở đây.
 * KHÔNG import tĩnh app ở bất kỳ đâu khác, nếu không Vite sẽ gộp nó vào bundle chính.
 */
export const APPS: AppManifest[] = [
  {
    id: "git", title: "Git", icon: "", iconNode: ic(GitBranch, "#f0883e"),
    description: "Status, diff, commit, pull/push across repos",
    keywords: "repo branch commit",
    load: () => import("./git"),
  },
  {
    id: "http", title: "HTTP Client", icon: "", iconNode: ic(Send, "#3fb950"),
    description: "Send requests, collections, environment",
    keywords: "api rest postman curl request",
    load: () => import("./http"),
  },
  {
    id: "ssh", title: "SSH", icon: "", iconNode: ic(SquareTerminal, "#58a6ff"),
    description: "Terminal, tunnel, host folders",
    keywords: "terminal server host sftp",
    load: () => import("./ssh"),
  },
  {
    id: "tools", title: "Tools", icon: "", iconNode: ic(Wrench, "#a371f7"),
    description: "Base64, JSON, JWT and other small tools",
    keywords: "tien ich toolkit base64 json jwt",
    load: () => import("./tools"),
  },
  {
    id: "db", title: "Database", icon: "", iconNode: createElement("span", { className: "app-ic app-ic-db" }, createElement(DbIcon, { size: 24 })),
    description: "Connect PostgreSQL, MySQL, SQLite — run SQL, browse tables",
    keywords: "sql postgres mysql mariadb sqlite query co so du lieu",
    load: () => import("./db"),
  },
  {
    id: "redis", title: "Redis", icon: "", iconNode: ic(Zap, "#f85149"),
    description: "Browse keys, view values, delete keys",
    keywords: "cache redis key value nosql kv",
    load: () => import("./redis"),
  },
  {
    id: "registry", title: "Registry", icon: "", iconNode: ic(Container, "#39c5cf"),
    description: "Browse Harbor, download images (.tar)",
    keywords: "docker harbor image registry container tag pull",
    load: () => import("./registry/index"), // "./registry" sẽ trỏ nhầm vào chính file registry.ts
  },
  {
    id: "translate", title: "Web Translate", icon: "", iconNode: ic(Languages, "#d29922"),
    description: "Open any web page translated to your language in real time",
    keywords: "dich trang web translate google deepl tieng viet browser",
    load: () => import("./translate"),
  },
  {
    id: "pdf", title: "PDF", icon: "", iconNode: ic(FileText, "#ff7b72"),
    description: "View PDF files, check digital signatures, trust certificates",
    keywords: "pdf acrobat reader ky so chu ky chung thu signature certificate xem tai lieu",
    load: () => import("./pdf"),
  },
  {
    id: "editor", title: "Editor", icon: "", iconNode: ic(FileCode2, "#3fb950"),
    description: "Text editor: syntax colors, format JSON/XML/JS, Base64/URL/JWT decode, keeps unsaved tabs",
    keywords: "editor notepad notepad++ soan thao text txt json xml js format lam dep base64 decode van ban",
    load: () => import("./editor"),
  },
];

export const appById = (id: AppId) => APPS.find((a) => a.id === id)!;

/** Phím tắt vào app, vd. "Ctrl+1". */
export const appShortcut = (id: AppId) => {
  const i = orderedApps().findIndex((a) => a.id === id);
  return i >= 0 && i < 9 ? `Ctrl+${i + 1}` : "";
};

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

/** Module đã tải xong (hoặc undefined nếu chưa) — dùng cho launcher. */
export const loadedApp = (id: AppId) => ready.get(id);

/* ── Thứ tự app do người dùng sắp (kéo-thả trong launcher) ──
 * Lưu localStorage; thứ tự này quyết định cả phím tắt Ctrl+1..9. App mới chưa có trong danh sách lưu
 * thì nối vào cuối theo thứ tự khai báo ở APPS. Đồng bộ giữa các cửa sổ qua sự kiện `storage`. */
const ORDER_KEY = "devstation.appOrder";
const readOrder = (): AppManifest[] => {
  let ids: string[] = [];
  try { ids = JSON.parse(localStorage.getItem(ORDER_KEY) ?? "[]"); } catch { /* bỏ qua */ }
  const known = ids.map((id) => APPS.find((a) => a.id === id)).filter((a): a is AppManifest => !!a);
  return [...known, ...APPS.filter((a) => !known.includes(a))];
};
let order = readOrder();
const orderSubs = new Set<() => void>();
const emitOrder = () => orderSubs.forEach((f) => f());
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => { if (e.key === ORDER_KEY) { order = readOrder(); emitOrder(); } });
}
/** Danh sách app theo thứ tự người dùng. */
export const orderedApps = () => order;
export const subscribeAppOrder = (cb: () => void) => { orderSubs.add(cb); return () => { orderSubs.delete(cb); }; };
export function setAppOrder(ids: AppId[]) {
  localStorage.setItem(ORDER_KEY, JSON.stringify(ids));
  order = readOrder();
  emitOrder();
}
/** Chuyển app `id` tới trước app `beforeId` (null = cuối danh sách). */
export function moveApp(id: AppId, beforeId: AppId | null) {
  const ids = order.map((a) => a.id).filter((x) => x !== id);
  const i = beforeId ? ids.indexOf(beforeId) : -1;
  ids.splice(i < 0 ? ids.length : i, 0, id);
  setAppOrder(ids);
}
export const resetAppOrder = () => setAppOrder([]);
