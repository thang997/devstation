import type { ComponentType } from "react";

/** Một tab trong vùng làm việc. Mỗi app tự định nghĩa `payload` của mình. */
export interface Tab {
  id: string;
  appId: AppId;
  title: string;
  /** Dữ liệu riêng của app: đường dẫn repo, id request, id host... */
  payload: Record<string, unknown>;
  /** Tô viền cảnh báo (vd. host prod). */
  danger?: boolean;
}

export type AppId = "git" | "http" | "ssh" | "tools";

/** Lệnh hiện trong command palette (Ctrl+K). */
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
 * Code thật của app chỉ được tải qua `load()` khi người dùng mở app lần đầu.
 */
export interface AppManifest {
  id: AppId;
  title: string;
  icon: string;
  /** Dynamic import → Vite tách mỗi app thành một chunk riêng. */
  load: () => Promise<{ default: AppModule }>;
}

/**
 * Phần "nặng" của mini app (export default từ `src/apps/<id>/index.tsx`).
 * Shell chỉ biết đến interface này, không import trực tiếp nội dung bên trong app.
 */
export interface AppModule {
  /** Nội dung cột sidebar của app. */
  Sidebar: ComponentType;
  /** Nội dung một tab thuộc app này. */
  TabView: ComponentType<{ tab: Tab }>;
  /** Lệnh đóng góp vào Ctrl+K (chỉ hiện khi app đã được tải). */
  commands?: () => Command[];
}
