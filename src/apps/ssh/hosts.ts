import { useSyncExternalStore } from "react";

/** Một host SSH đã lưu (localStorage; mật khẩu KHÔNG lưu — ssh.exe tự hỏi hoặc dùng key). */
export interface SavedHost {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  /** Đường dẫn private key (tuỳ chọn). */
  keyPath: string;
  /** Đánh dấu prod → viền đỏ, cảnh báo. */
  prod: boolean;
  /** Id thư mục chứa host ("" = ngoài thư mục). */
  folderId: string;
  /** Jump host: id một host đã lưu khác dùng làm máy trung gian (bastion). Rỗng = kết nối thẳng. */
  jumpHostId?: string;
}

/** Cấu hình jump host của một host (tra theo jumpHostId trong danh sách host đã lưu). */
export function jumpCfgFor(h: SavedHost | undefined, all: SavedHost[]): { host: string; port: number; user: string; keyPath: string } | undefined {
  if (!h?.jumpHostId || h.jumpHostId === h.id) return undefined;
  const j = all.find((x) => x.id === h.jumpHostId);
  return j && j.host.trim() ? { host: j.host.trim(), port: j.port || 22, user: j.user.trim(), keyPath: j.keyPath } : undefined;
}

const KEY = "devstation.ssh.hosts";

function load(): SavedHost[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

let hosts: SavedHost[] = load();
const subs = new Set<() => void>();

function commit(next: SavedHost[]) {
  hosts = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(hosts));
  } catch {
    /* hết chỗ */
  }
  subs.forEach((f) => f());
}

export const uid = (p: string) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// subscribe/getSnapshot cố định (tạo mới mỗi render → React huỷ đăng ký rồi đăng ký lại mỗi lần vẽ).
const subscribe = (cb: () => void) => { subs.add(cb); return () => { subs.delete(cb); }; };
const snapshot = () => hosts;

export function useHosts(): SavedHost[] {
  return useSyncExternalStore(subscribe, snapshot);
}

export function saveHost(h: SavedHost) {
  const i = hosts.findIndex((x) => x.id === h.id);
  commit(i >= 0 ? hosts.map((x) => (x.id === h.id ? h : x)) : [...hosts, h]);
}

export function removeHost(id: string) {
  commit(hosts.filter((x) => x.id !== id));
}

/** Ghi đè toàn bộ danh sách host (dùng khi kéo-thả sắp lại vị trí). */
export function setHosts(next: SavedHost[]) {
  commit(next);
}

export function getHost(id: string): SavedHost | undefined {
  return hosts.find((x) => x.id === id);
}
