import { useSyncExternalStore } from "react";
import { uid } from "./hosts";

/** Thư mục nhóm các host SSH (phẳng một cấp; host trỏ vào folder bằng folderId). */
export interface SavedFolder {
  id: string;
  name: string;
  open: boolean;
}

const KEY = "devstation.ssh.folders";

function load(): SavedFolder[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

let folders: SavedFolder[] = load();
const subs = new Set<() => void>();

function commit(next: SavedFolder[]) {
  folders = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(folders));
  } catch {
    /* hết chỗ */
  }
  subs.forEach((f) => f());
}

export function useFolders(): SavedFolder[] {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => folders);
}

export function addFolder(name = "Thư mục mới"): string {
  const f: SavedFolder = { id: uid("f"), name, open: true };
  commit([...folders, f]);
  return f.id;
}
export function renameFolder(id: string, name: string) {
  commit(folders.map((f) => (f.id === id ? { ...f, name } : f)));
}
export function removeFolder(id: string) {
  commit(folders.filter((f) => f.id !== id));
}
export function toggleFolder(id: string) {
  commit(folders.map((f) => (f.id === id ? { ...f, open: !f.open } : f)));
}
