import { useSyncExternalStore } from "react";
import { t } from "../../store/lang";
import { uid } from "./hosts";

/** Thư mục nhóm (phẳng một cấp; mục trỏ vào folder bằng `folderId`). Dùng cho cả host SSH và tunnel. */
export interface SavedFolder {
  id: string;
  name: string;
  open: boolean;
}

/** Một kho thư mục lưu localStorage theo `key` (host và tunnel có danh sách thư mục riêng). */
function folderStore(key: string) {
  const load = (): SavedFolder[] => {
    try {
      const v = JSON.parse(localStorage.getItem(key) || "[]");
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };
  let folders: SavedFolder[] = load();
  const subs = new Set<() => void>();
  const commit = (next: SavedFolder[]) => {
    folders = next;
    try {
      localStorage.setItem(key, JSON.stringify(folders));
    } catch {
      /* hết chỗ */
    }
    subs.forEach((f) => f());
  };
  return {
    use: (): SavedFolder[] => useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => folders),
    add: (name = t("ssh.newFolderName")): string => {
      const f: SavedFolder = { id: uid("f"), name, open: true };
      commit([...folders, f]);
      return f.id;
    },
    rename: (id: string, name: string) => commit(folders.map((f) => (f.id === id ? { ...f, name } : f))),
    remove: (id: string) => commit(folders.filter((f) => f.id !== id)),
    toggle: (id: string) => commit(folders.map((f) => (f.id === id ? { ...f, open: !f.open } : f))),
  };
}

/* Thư mục host SSH. */
const hostFolders = folderStore("devstation.ssh.folders");
export const useFolders = hostFolders.use;
export const addFolder = hostFolders.add;
export const renameFolder = hostFolders.rename;
export const removeFolder = hostFolders.remove;
export const toggleFolder = hostFolders.toggle;

/* Thư mục tunnel (danh sách riêng, không lẫn với thư mục host). */
export const tunnelFolders = folderStore("devstation.ssh.tunnelFolders");
