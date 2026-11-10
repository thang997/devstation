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
  run: () => void;
}

/**
 * Hợp đồng chung của một app con. Shell chỉ biết đến interface này,
 * không import trực tiếp nội dung bên trong app.
 */
export interface AppModule {
  id: AppId;
  title: string;
  icon: string;
  /** Nội dung cột sidebar khi app được chọn trên activity bar. */
  Sidebar: ComponentType;
  /** Nội dung một tab thuộc app này. */
  TabView: ComponentType<{ tab: Tab }>;
  /** Lệnh đóng góp vào Ctrl+K. */
  commands?: () => Command[];
}
