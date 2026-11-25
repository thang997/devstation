import { useSyncExternalStore } from "react";
import { t } from "../../store/lang";
import type { Auth, Header } from "./api";

/** Một request đã lưu trong collection (bản gốc; mở ra tab là bản làm việc). */
export interface SavedReq {
  method: string;
  url: string;
  headers: Header[];
  body: string;
  insecure: boolean;
  /** Xác thực (tuỳ chọn — request/import cũ không có). */
  auth?: Auth;
  /** Script chạy TRƯỚC khi gửi (pre-request — tuỳ chọn). */
  preScript?: string;
  /** Script chạy SAU response (tuỳ chọn). */
  script?: string;
}

export interface ReqNode {
  kind: "req";
  id: string;
  name: string;
  req: SavedReq;
}
export interface FolderNode {
  kind: "folder";
  id: string;
  name: string;
  open: boolean;
  children: TreeNode[];
  /** Thư mục PROD: request bên trong (kể cả thư mục con) mở ra tab viền đỏ, gửi lệnh ghi phải xác nhận. */
  prod?: boolean;
}
export type TreeNode = ReqNode | FolderNode;

const KEY = "devstation.http.collections";

function load(): TreeNode[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

let tree: TreeNode[] = load();
const subs = new Set<() => void>();

function commit(next: TreeNode[]) {
  tree = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(tree));
  } catch {
    /* hết chỗ — vẫn giữ trong phiên */
  }
  subs.forEach((f) => f());
}

const uid = (p: string) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/* ── Thao tác cây (bất biến) ── */

/** Chép lại nhánh có con đổi, giữ nguyên object các nhánh không đổi (để dòng memo ở UI không vẽ lại). */
function mapChildren(nodes: TreeNode[], fn: (children: TreeNode[]) => TreeNode[]): TreeNode[] {
  let changed = false;
  const out = nodes.map((n) => {
    if (n.kind !== "folder") return n;
    const c = fn(n.children);
    if (c === n.children) return n;
    changed = true;
    return { ...n, children: c };
  });
  return changed ? out : nodes;
}

function insert(nodes: TreeNode[], parentId: string | null, node: TreeNode): TreeNode[] {
  if (parentId === null) return [...nodes, node];
  const i = nodes.findIndex((n) => n.kind === "folder" && n.id === parentId);
  if (i >= 0) {
    const f = nodes[i] as FolderNode;
    const copy = [...nodes];
    copy[i] = { ...f, open: true, children: [...f.children, node] };
    return copy;
  }
  return mapChildren(nodes, (c) => insert(c, parentId, node));
}

function removeIn(nodes: TreeNode[], id: string): TreeNode[] {
  const i = nodes.findIndex((n) => n.id === id);
  if (i >= 0) return nodes.filter((n) => n.id !== id);
  return mapChildren(nodes, (c) => removeIn(c, id));
}

function updateIn(nodes: TreeNode[], id: string, fn: (n: TreeNode) => TreeNode): TreeNode[] {
  const i = nodes.findIndex((n) => n.id === id);
  if (i >= 0) {
    const copy = [...nodes];
    copy[i] = fn(nodes[i]);
    return copy;
  }
  return mapChildren(nodes, (c) => updateIn(c, id, fn));
}

function findNode(nodes: TreeNode[], id: string): TreeNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.kind === "folder") { const r = findNode(n.children, id); if (r) return r; }
  }
  return null;
}
function insertBefore(nodes: TreeNode[], targetId: string, node: TreeNode): TreeNode[] {
  const idx = nodes.findIndex((n) => n.id === targetId);
  if (idx >= 0) { const copy = [...nodes]; copy.splice(idx, 0, node); return copy; }
  return mapChildren(nodes, (c) => insertBefore(c, targetId, node));
}

/** Kéo-thả: chuyển node `dragId` tới trước `targetId` (into=true → thả vào trong folder targetId; targetId=null → về gốc, cuối). */
export function moveNode(dragId: string, targetId: string | null, into: boolean) {
  if (dragId === targetId) return;
  const node = findNode(tree, dragId);
  if (!node) return;
  // Không thả folder vào chính nó hoặc con của nó (mất cây).
  if (node.kind === "folder" && targetId && (targetId === dragId || findNode(node.children, targetId))) return;
  let next = removeIn(tree, dragId);
  if (into && targetId) next = insert(next, targetId, node);
  else if (targetId) next = insertBefore(next, targetId, node);
  else next = [...next, node];
  commit(next);
}

function childrenOf(nodes: TreeNode[], parentId: string | null): TreeNode[] {
  if (parentId === null) return nodes;
  for (const n of nodes) {
    if (n.kind === "folder") {
      if (n.id === parentId) return n.children;
      const r = childrenOf(n.children, parentId);
      if (r.length || hasFolder(n.children, parentId)) return r;
    }
  }
  return [];
}
function hasFolder(nodes: TreeNode[], id: string): boolean {
  return nodes.some((n) => n.kind === "folder" && (n.id === id || hasFolder(n.children, id)));
}

/* ── API công khai ── */

export function useTree(): TreeNode[] {
  return useSyncExternalStore(
    (cb) => { subs.add(cb); return () => { subs.delete(cb); }; },
    () => tree,
  );
}

export function addFolder(parentId: string | null, name = t("http.newFolderName")): string {
  const node: FolderNode = { kind: "folder", id: uid("f"), name, open: true, children: [] };
  commit(insert(tree, parentId, node));
  return node.id;
}

export function addRequest(parentId: string | null, name: string, req: SavedReq): string {
  const node: ReqNode = { kind: "req", id: uid("r"), name, req };
  commit(insert(tree, parentId, node));
  return node.id;
}

export function removeNode(id: string) {
  commit(removeIn(tree, id));
}

/** Ghi đè nội dung một request đã lưu (khi sửa rồi lưu lại). */
export function updateRequest(id: string, req: SavedReq) {
  commit(updateIn(tree, id, (n) => (n.kind === "req" ? { ...n, req } : n)));
}

/** Danh sách phẳng mọi folder để chọn nơi lưu (label thụt lề theo độ sâu). */
export function flattenFolders(nodes: TreeNode[], depth = 0, out: { id: string; label: string }[] = []) {
  for (const n of nodes) {
    if (n.kind === "folder") {
      out.push({ id: n.id, label: `${"  ".repeat(depth)}${n.name}` });
      flattenFolders(n.children, depth + 1, out);
    }
  }
  return out;
}

export function renameNode(id: string, name: string) {
  commit(updateIn(tree, id, (n) => ({ ...n, name })));
}

export function setFolderProd(id: string, prod: boolean) {
  commit(updateIn(tree, id, (n) => (n.kind === "folder" ? { ...n, prod } : n)));
}

/** Node `id` có nằm trong (hoặc chính là) thư mục PROD không. */
export function isUnderProd(id: string, nodes: TreeNode[] = tree, inherited = false): boolean | null {
  for (const n of nodes) {
    const here = inherited || (n.kind === "folder" && !!n.prod);
    if (n.id === id) return here;
    if (n.kind === "folder") { const r = isUnderProd(id, n.children, here); if (r !== null) return r; }
  }
  return null;
}

export function toggleFolder(id: string) {
  commit(updateIn(tree, id, (n) => (n.kind === "folder" ? { ...n, open: !n.open } : n)));
}

/** Tìm (hoặc tạo) thư mục con cùng tên dưới `parentId` — dùng khi import giữ cấu trúc thư mục. */
export function ensureFolder(parentId: string | null, name: string): string {
  const found = childrenOf(tree, parentId).find((n) => n.kind === "folder" && n.name === name);
  return found ? found.id : addFolder(parentId, name);
}
