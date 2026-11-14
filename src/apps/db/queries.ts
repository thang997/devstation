import { useSyncExternalStore } from "react";

/** Câu query đã lưu, gắn theo từng kết nối (giống "Queries" của Navicat). */
export interface SavedQuery {
  id: string;
  connId: string;
  name: string;
  sql: string;
  updatedAt: number;
}

const KEY = "devstation.db.queries";

function load(): SavedQuery[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

let queries: SavedQuery[] = load();
const subs = new Set<() => void>();

function commit(next: SavedQuery[]) {
  queries = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(queries));
  } catch {
    /* hết chỗ */
  }
  subs.forEach((f) => f());
}

const uid = () => `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** Toàn bộ query đã lưu (lọc theo connId ở phía component bằng useMemo). */
export function useSavedQueries(): SavedQuery[] {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => queries);
}

/** Lưu query. Trùng (connId, name) thì ghi đè nội dung. Trả về id. */
export function saveQuery(connId: string, name: string, sql: string): string {
  const existing = queries.find((q) => q.connId === connId && q.name === name);
  if (existing) {
    commit(queries.map((q) => (q.id === existing.id ? { ...q, sql, updatedAt: Date.now() } : q)));
    return existing.id;
  }
  const q: SavedQuery = { id: uid(), connId, name, sql, updatedAt: Date.now() };
  commit([...queries, q]);
  return q.id;
}

export function renameQuery(id: string, name: string) {
  commit(queries.map((q) => (q.id === id ? { ...q, name } : q)));
}

export function removeQuery(id: string) {
  commit(queries.filter((q) => q.id !== id));
}
