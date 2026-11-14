import { useSyncExternalStore } from "react";

/** Thư mục gom nhiều kết nối DB (phẳng một cấp; kết nối trỏ vào folder bằng folderId). */
export interface DbFolder {
  id: string;
  name: string;
  open: boolean;
}

const KEY = "devstation.db.folders";

function load(): DbFolder[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

let folders: DbFolder[] = load();
const subs = new Set<() => void>();

function commit(next: DbFolder[]) {
  folders = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(folders));
  } catch {
    /* hết chỗ */
  }
  subs.forEach((f) => f());
}

const uid = () => `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export function useDbFolders(): DbFolder[] {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => folders);
}

export function addDbFolder(name = "Thư mục mới"): string {
  const f: DbFolder = { id: uid(), name, open: true };
  commit([...folders, f]);
  return f.id;
}
export function renameDbFolder(id: string, name: string) {
  commit(folders.map((f) => (f.id === id ? { ...f, name } : f)));
}
export function removeDbFolder(id: string) {
  commit(folders.filter((f) => f.id !== id));
}
export function toggleDbFolder(id: string) {
  commit(folders.map((f) => (f.id === id ? { ...f, open: !f.open } : f)));
}
