import type { ComponentType, ReactNode } from "react";

/** Một tab bên trong app (repo, request, phiên SSH, tool...). Mỗi app tự định nghĩa `payload`. */
export interface Tab {
  id: string;
  appId: AppId;
  title: string;
  /** Dữ liệu riêng của app: đường dẫn repo, id request, id host... */
  payload: Record<string, unknown>;
  /** Tô viền cảnh báo (vd. host prod). */
  danger?: boolean;
}

export type AppId = "git" | "http" | "ssh" | "tools" | "db" | "redis";

/** Một dòng trong launcher (Ctrl+K). */
export interface Command {
  id: string;
  title: string;
  /** Nhóm hiển thị, thường là tên app. */
  group: string;
  /** Phím tắt hiển thị bên cạnh (chỉ để xem). */
  hint?: string;
  run: () => void;
}

/**
 * Phần "nhẹ" của một mini app: shell luôn biết, nằm trong bundle chính.
 * Code thật của app chỉ được tải qua `load()` khi người dùng vào app lần đầu.
 */
export interface AppManifest {
  id: AppId;
  title: string;
  /** Icon dạng text/emoji (dùng trong tooltip, nhãn menu). */
  icon: string;
  /** Icon dạng React (SVG…) ưu tiên khi RENDER trực quan (launcher, status bar). Fallback `icon`. */
  iconNode?: ReactNode;
  /** Tiêu đề tiếng Việt (nếu khác `title`). */
  titleVi?: string;
  /** Mô tả ngắn hiện trong launcher (tiếng Anh — mặc định). */
  description: string;
  /** Mô tả tiếng Việt. */
  descriptionVi?: string;
  /** Từ khoá thêm cho ô tìm kiếm (không dấu, tiếng Anh...). */
  keywords?: string;
  /** Dynamic import → Vite tách mỗi app thành một chunk riêng. */
  load: () => Promise<{ default: AppModule }>;
}

/**
 * Phần "nặng" của mini app (export default từ `src/apps/<id>/index.tsx`).
 * App chiếm toàn bộ vùng làm việc và tự quyết bố cục; có thể dùng `TabbedLayout` cho nhanh.
 */
export interface AppModule {
  View: ComponentType;
  /** Lệnh đóng góp vào launcher (chỉ hiện khi app đã được tải). */
  commands?: () => Command[];
}
