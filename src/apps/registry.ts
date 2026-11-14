import { createElement } from "react";
import type { AppId, AppManifest, AppModule } from "./types";
import { DbIcon } from "../shell/icons";

/**
 * Thứ tự ở đây = thứ tự trong launcher = phím tắt Ctrl+1..9.
 * Thêm app mới: tạo `src/apps/<id>/index.tsx` (export default AppModule) rồi khai báo ở đây.
 * KHÔNG import tĩnh app ở bất kỳ đâu khác, nếu không Vite sẽ gộp nó vào bundle chính.
 */
export const APPS: AppManifest[] = [
  {
    id: "git", title: "Git", icon: "🌿",
    description: "Status, diff, commit, pull/push across repos",
    descriptionVi: "Status, diff, commit, pull/push nhiều repo",
    keywords: "repo branch commit",
    load: () => import("./git"),
  },
  {
    id: "http", title: "HTTP Client", icon: "⚡",
    description: "Send requests, collections, environment",
    descriptionVi: "Gửi request, collections, environment",
    keywords: "api rest postman curl request",
    load: () => import("./http"),
  },
  {
    id: "ssh", title: "SSH", icon: "🖥",
    description: "Terminal, tunnel, host folders",
    descriptionVi: "Terminal, tunnel, nhóm host theo thư mục",
    keywords: "terminal server host sftp",
    load: () => import("./ssh"),
  },
  {
    id: "tools", title: "Tools", titleVi: "Tiện ích", icon: "🧰",
    description: "Base64, JSON, JWT and other small tools",
    descriptionVi: "Base64, JSON, JWT và các tool nhỏ khác",
    keywords: "tien ich toolkit base64 json jwt",
    load: () => import("./tools"),
  },
  {
    id: "db", title: "Database", icon: "🗄", iconNode: createElement(DbIcon, { size: 24 }),
    description: "Connect PostgreSQL, MySQL, SQLite — run SQL, browse tables",
    descriptionVi: "Kết nối PostgreSQL, MySQL, SQLite — chạy SQL, xem bảng",
    keywords: "sql postgres mysql mariadb sqlite query co so du lieu",
    load: () => import("./db"),
  },
  {
    id: "redis", title: "Redis", icon: "🔑",
    description: "Browse keys, view values, delete keys",
    descriptionVi: "Duyệt key, xem giá trị, xoá key",
    keywords: "cache redis key value nosql kv",
    load: () => import("./redis"),
  },
];

export const appById = (id: AppId) => APPS.find((a) => a.id === id)!;

/** Phím tắt vào app, vd. "Ctrl+1". */
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

/** Module đã tải xong (hoặc undefined nếu chưa) — dùng cho launcher. */
export const loadedApp = (id: AppId) => ready.get(id);
