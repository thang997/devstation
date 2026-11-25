import { Swap } from "../../shell/Swap";
import { renderLog } from "../../shell/renderDebug";
import { copyText } from "../../shell/clipboard";
import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Braces, Check, ChevronDown, ChevronRight, Copy, CornerRightDown, Download, FileInput, Folder, FolderInput, FolderOpen, FolderPlus, KeyRound, Minimize2, PackageOpen, Pencil, Plus, Save, Send, ShieldAlert, Sparkles, Trash2, TriangleAlert, X, Zap } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { AppModule, Tab } from "../types";
import { useWorkbench } from "../../store/workbench";
import { t, useT } from "../../store/lang";
import { TabbedLayout } from "../../shell/TabbedLayout";
import { ContextMenu, type CtxItem } from "../../shell/ContextMenu";
import { Modal } from "../../shell/Modal";
import { confirmDialog } from "../../shell/confirm";
import { listNav, rowKey } from "../../shell/listNav";
import { Picker } from "../../shell/Picker";
import { Loading, Spinner } from "../../shell/Loading";
import { sendHttp, readFile, readDir, errText, NO_AUTH, type Auth, type Header, type HttpResp } from "./api";
import { looksLikeCurl, parseCurl, parseCurlFile, type ParsedCurl } from "./curl";
import { looksLikePostman, parsePostman, type PmNode } from "./postman";
import { getVars, removeVar, runPreScript, runScript, setVar, substitute, useVars } from "./vars";
import {
  addFolder, addRequest, ensureFolder, flattenFolders, isUnderProd, moveNode, removeNode, renameNode, setFolderProd, toggleFolder, updateRequest, useTree,
  type ReqNode, type SavedReq, type TreeNode,
} from "./collections";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
const BODYLESS = new Set(["GET", "HEAD"]);

let untitled = 0;
export function newRequest(init?: { method?: string; url?: string; name?: string }) {
  useWorkbench.getState().openTab({
    id: `http:new-${++untitled}`,
    appId: "http",
    title: init?.name ?? t("http.newRequest"),
    payload: { method: init?.method ?? "GET", url: init?.url ?? "" },
  });
}

/** Mở một request đã lưu trong collection thành tab làm việc (mang theo đủ headers/body + id đã lưu). */
function openSavedRequest(id: string, name: string, r: SavedReq) {
  useWorkbench.getState().openTab({
    id: `http:saved-${++untitled}`,
    appId: "http",
    title: name,
    danger: isUnderProd(id) === true,
    payload: { method: r.method, url: r.url, headers: r.headers, body: r.body, insecure: r.insecure, savedId: id, auth: r.auth, preScript: r.preScript, script: r.script },
  });
}

/* ── Trạng thái một request (lưu localStorage theo tab để không mất khi đóng app) ── */

interface ReqState {
  method: string;
  url: string;
  headers: Header[];
  body: string;
  insecure: boolean;
  auth: Auth;
  preScript: string;
  script: string;
}

const reqKey = (id: string) => `devstation.http.req.${id}`;

function loadReq(tab: Tab): ReqState {
  try {
    const s = localStorage.getItem(reqKey(tab.id));
    if (s) return withDefaults(JSON.parse(s));
  } catch {
    /* ignore */
  }
  const p = tab.payload;
  return withDefaults({
    method: String(p.method ?? "GET"),
    url: String(p.url ?? ""),
    headers: Array.isArray(p.headers) ? (p.headers as Header[]) : [],
    body: typeof p.body === "string" ? p.body : "",
    insecure: Boolean(p.insecure),
    auth: (p.auth as Auth) ?? undefined,
    preScript: typeof p.preScript === "string" ? p.preScript : "",
    script: typeof p.script === "string" ? p.script : "",
  });
}

/** Bù các trường mới cho request cũ (lưu trước khi có auth/script). */
function withDefaults(r: Partial<ReqState>): ReqState {
  return {
    method: r.method ?? "GET",
    url: r.url ?? "",
    headers: r.headers ?? [],
    body: r.body ?? "",
    insecure: Boolean(r.insecure),
    auth: r.auth ?? { ...NO_AUTH },
    preScript: r.preScript ?? "",
    script: r.script ?? "",
  };
}

/** Chuỗi so sánh của một request (đã bù mặc định, cố định thứ tự trường) — dùng cho dấu "chưa lưu". */
function reqSnapshot(r: Partial<ReqState>): string {
  const d = withDefaults(r);
  return JSON.stringify([d.method, d.url, d.headers, d.body, d.insecure, d.auth, d.preScript, d.script]);
}

/** Bản đã lưu trong collection (đọc thẳng cây hiện tại, không theo dõi); không còn node → null. */
function savedReqSnapshot(id: string): string | null {
  const find = (nodes: TreeNode[]): TreeNode | undefined => {
    for (const n of nodes) {
      if (n.id === id) return n;
      if (n.kind === "folder") { const f = find(n.children); if (f) return f; }
    }
    return undefined;
  };
  try {
    const raw = JSON.parse(localStorage.getItem("devstation.http.collections") || "[]");
    const n = Array.isArray(raw) ? find(raw as TreeNode[]) : undefined;
    return n && n.kind === "req" ? reqSnapshot(n.req as Partial<ReqState>) : null;
  } catch {
    return null;
  }
}

/* ── Chuyển lệnh curl đã tách thành request lưu được + tên gợi ý ── */

function toSaved(p: ParsedCurl): SavedReq {
  return { method: p.method, url: p.url, headers: p.headers, body: p.body ?? "", insecure: p.insecure, auth: { ...NO_AUTH }, preScript: "", script: "" };
}

/** Tên ngắn cho request: "GET /đường/dẫn" lấy từ URL. */
function reqName(p: ParsedCurl): string {
  let path = p.url;
  try {
    const u = new URL(/:\/\//.test(p.url) ? p.url : `https://${p.url}`);
    path = u.pathname + u.search || "/";
  } catch {
    /* URL lạ — giữ nguyên */
  }
  return `${p.method} ${path}`;
}

const baseName = (p: string) => p.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || p;

/* ── Query params ↔ URL ── */

function parseQuery(url: string): { base: string; params: { k: string; v: string }[] } {
  const qi = url.indexOf("?");
  if (qi < 0) return { base: url, params: [] };
  const base = url.slice(0, qi);
  const params = url
    .slice(qi + 1)
    .split("&")
    .filter(Boolean)
    .map((p) => {
      const eq = p.indexOf("=");
      const dec = (s: string) => { try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch { return s; } };
      return eq < 0 ? { k: dec(p), v: "" } : { k: dec(p.slice(0, eq)), v: dec(p.slice(eq + 1)) };
    });
  return { base, params };
}

function buildUrl(base: string, params: { k: string; v: string; on?: boolean }[]): string {
  const q = params
    .filter((p) => (p.on ?? true) && p.k)
    .map((p) => `${encodeURIComponent(p.k)}=${encodeURIComponent(p.v)}`)
    .join("&");
  return q ? `${base}?${q}` : base;
}

/* ── Copy as curl ── */

const sq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

function toCurl(r: ReqState): string {
  const parts = [`curl -X ${r.method}`, sq(r.url)];
  for (const h of r.headers) if (h.on && h.name.trim()) parts.push(`-H ${sq(`${h.name}: ${h.value}`)}`);
  const ah = authHeader(r.auth, getVars());
  if (ah) parts.push(`-H ${sq(`${ah.name}: ${ah.value}`)}`);
  if (r.body && !BODYLESS.has(r.method)) parts.push(`--data ${sq(r.body)}`);
  if (r.insecure) parts.push("-k");
  return parts.join(" \\\n  ");
}

/* ── Sidebar: collections (folder + request, import file/thư mục) ── */

/** Thêm các request từ 1 file curl vào `parent`. Nhiều lệnh → bọc trong 1 folder theo tên file. */
/** Import một file collection Postman → thư mục mới mang tên collection; biến collection thêm vào 🔑 (không ghi đè biến đã có). */
function importPostmanText(text: string): string {
  const pm = parsePostman(text);
  const root = addFolder(null, pm.name);
  const walk = (nodes: PmNode[], parent: string) => {
    for (const n of nodes) {
      if (n.kind === "folder") walk(n.children, addFolder(parent, n.name));
      else addRequest(parent, n.name, n.req);
    }
  };
  walk(pm.nodes, root);
  const cur = getVars();
  let added = 0;
  for (const [k, v] of Object.entries(pm.vars)) if (!(k in cur)) { setVar(k, v); added++; }
  return t("http.importedPostman", { n: pm.total, name: pm.name })
    + (added ? t("http.importedPostmanVars", { n: added }) : "")
    + (pm.unsupportedBodies ? " " + t("http.importedPostmanMultipart", { n: pm.unsupportedBodies }) : "");
}

function importReqsInto(parent: string | null, reqs: ParsedCurl[], folderName: string) {
  if (reqs.length === 1) return void addRequest(parent, reqName(reqs[0]), toSaved(reqs[0]));
  const fid = addFolder(parent, folderName);
  for (const r of reqs) addRequest(fid, reqName(r), toSaved(r));
}

function Sidebar() {
  renderLog("Sidebar");
  const tr = useT();
  const tree = useTree();
  const [msg, setMsg] = useState("");
  const [menu, setMenu] = useState<{ node: TreeNode; parent: string | null; x: number; y: number } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  /** Đang kéo file từ ngoài vào sidebar (hiện vùng thả). */
  const [fileOver, setFileOver] = useState(false);

  const importPostmanFile = async () => {
    setMsg("");
    try {
      const f = await openDialog({ multiple: false, title: tr("http.choosePostmanFile"), filters: [{ name: "Postman collection", extensions: ["json"] }] });
      if (typeof f !== "string") return;
      setMsg(importPostmanText(await readFile(f)));
    } catch (e) {
      setMsg(errText(e));
    }
  };

  /** Kéo thả file vào sidebar: collection Postman (.json) hoặc file lệnh curl. */
  const importDropped = async (files: File[]) => {
    const notes: string[] = [];
    for (const file of files) {
      try {
        const text = await file.text();
        if (looksLikePostman(text)) { notes.push(importPostmanText(text)); continue; }
        const reqs = parseCurlFile(text);
        if (reqs.length) {
          importReqsInto(null, reqs, file.name);
          notes.push(tr("http.importedRequestsFrom", { reqsLength: reqs.length, p: file.name }));
        } else notes.push(tr("http.notCollectionOrCurl", { name: file.name }));
      } catch (e) {
        notes.push(`${file.name}: ${errText(e)}`);
      }
    }
    setMsg(notes.join("\n"));
  };
  const isFileDrag = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes("Files");

  /** Hành động của cây — ref ổn định để các dòng (memo) không vẽ lại khi Sidebar đổi state. */
  const treeApi = useRef<TreeApi>(null!);
  treeApi.current = {
    setEditing, setDragId, setSel, dragId,
    onMenu: (node, parent, e) => { e.preventDefault(); setMenu({ node, parent, x: e.clientX, y: e.clientY }); },
  };

  const importFile = async () => {
    setMsg("");
    try {
      const f = await openDialog({ multiple: false, title: tr("http.chooseAFileWithCurlCommands") });
      if (typeof f !== "string") return;
      const reqs = parseCurlFile(await readFile(f));
      if (!reqs.length) return setMsg(tr("http.noCurlCommandsFoundInThe"));
      importReqsInto(null, reqs, baseName(f));
      setMsg(tr("http.importedRequestsFrom", { reqsLength: reqs.length, p: baseName(f) }));
    } catch (e) {
      setMsg(errText(e));
    }
  };

  const importFolder = async () => {
    setMsg("");
    try {
      const dir = await openDialog({ directory: true, title: tr("http.chooseAFolderOfCommandFiles") });
      if (typeof dir !== "string") return;
      const files = await readDir(dir);
      let count = 0;
      const rootId = addFolder(null, baseName(dir));
      for (const file of files) {
        const reqs = parseCurlFile(file.content);
        if (!reqs.length) continue;
        const segs = file.name.split("/");
        const fileName = segs.pop() || file.name;
        let parent = rootId;
        for (const seg of segs) parent = ensureFolder(parent, seg); // dựng lại cây thư mục
        importReqsInto(parent, reqs, fileName);
        count += reqs.length;
      }
      setMsg(count ? tr("http.importedRequestsFrom2", { count, p: baseName(dir) }) : tr("http.noCurlCommandsFoundInThe2"));
    } catch (e) {
      setMsg(errText(e));
    }
  };

  return (
    <div
      className={`side-list fill${fileOver ? " file-drop" : ""}`}
      onDragOver={(e) => { if (isFileDrag(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; setFileOver(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFileOver(false); }}
      onDrop={(e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        setFileOver(false);
        void importDropped(Array.from(e.dataTransfer.files));
      }}
    >
      {fileOver && <div className="file-drop-hint"><Download /> {tr("http.dropToImport")}</div>}
      <div className="side-head">
        <span>COLLECTIONS</span>
        <span className="side-actions">
          <button className="icon-btn" title={tr("http.newRequest")} onClick={() => newRequest()}><Plus /></button>
          <button className="icon-btn" title={tr("http.newFolder")} onClick={() => setEditing(addFolder(null))}><FolderPlus /></button>
          <button className="icon-btn" title={tr("http.importPostman")} onClick={() => void importPostmanFile()}><PackageOpen /></button>
          <button className="icon-btn" title={tr("http.importCurlCommandFile")} onClick={() => void importFile()}><FileInput /></button>
          <button className="icon-btn" title={tr("http.importAWholeFolderOfCommands")} onClick={() => void importFolder()}><FolderInput /></button>
          <VarsButton />
        </span>
      </div>
      {msg && (
        <div className="muted small pad http-msg" style={{ whiteSpace: "pre-line", display: "flex", gap: 6, alignItems: "flex-start" }}>
          <span className="grow" style={{ flex: 1, minWidth: 0 }}>{msg}</span>
          <button className="icon-btn" title={tr("http.dismiss")} onClick={() => setMsg("")}><X /></button>
        </div>
      )}
      {tree.length === 0 && <div className="muted small pad">{tr("http.nothingYetCreateAFolderOr")}</div>}
      <div
        className="tree"
        onKeyDown={(e) => { listNav(e, { row: ".tree-row" }); }}
        onDragOver={(e) => { if (dragId) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; } }}
        onDrop={(e) => { if (dragId) { e.preventDefault(); moveNode(dragId, null, false); setDragId(null); } }}
      >
        {tree.map((n) => <TreeRow key={n.id} node={n} depth={0} parent={null} editing={editing} sel={sel} dragId={dragId} api={treeApi} />)}
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={nodeMenu(menu.node, setEditing)}
        />
      )}
    </div>
  );
}

function nodeMenu(node: TreeNode, setEditing: (id: string) => void): CtxItem[] {
  const items: CtxItem[] = [{ id: "rename", icon: <Pencil />, label: t("http.rename"), action: () => setEditing(node.id) }];
  if (node.kind === "folder") {
    items.push(
      { id: "newReqHere", icon: <Plus />, label: t("http.newRequestHere"), action: () => setEditing(addRequestHere(node.id)) },
      { id: "newFolderHere", icon: <FolderPlus />, label: t("http.subfolder"), action: () => setEditing(addFolder(node.id)) },
      { id: "prod", icon: <ShieldAlert />, label: t(node.prod ? "http.unmarkProd" : "http.markProd"), action: () => setFolderProd(node.id, !node.prod) },
    );
  } else {
    items.push({ id: "open", icon: <Send />, label: t("http.openRequest"), action: () => openSavedRequest(node.id, node.name, node.req) });
  }
  items.push({ id: "s", sep: true }, {
    id: "del", icon: <Trash2 />, label: t("http.delete"), danger: true,
    action: () => confirmRemove(node),
  });
  return items;
}

/** Xoá folder/request (hỏi trước) — dùng chung cho menu chuột phải và phím Delete. */
function confirmRemove(node: TreeNode) {
  void confirmDialog({ message: t(node.kind === "folder" ? "http.deleteFolderNamed" : "http.deleteNodeNamed", { name: node.name }) }).then((ok) => ok && removeNode(node.id));
}

/** Tạo một request rỗng trong folder và trả id để đổi tên ngay. */
function addRequestHere(folderId: string): string {
  return addRequest(folderId, "GET /", { method: "GET", url: "", headers: [], body: "", insecure: false });
}

/** Nút biến môi trường: tự theo dõi store biến → sửa biến không vẽ lại cả cây collection. */
function VarsButton() {
  const tr = useT();
  const vars = useVars();
  const [open, setOpen] = useState(false);
  const n = Object.keys(vars).length;
  return (
    <>
      <button className="icon-btn" title={`${tr("http.environmentVariables")}${n ? ` (${n})` : ""}`} onClick={() => setOpen(true)}><KeyRound /></button>
      {open && <VarsModal onClose={() => setOpen(false)} />}
    </>
  );
}

interface TreeApi {
  setEditing: (id: string | null) => void;
  setDragId: (id: string | null) => void;
  setSel: (id: string | null) => void;
  /** Node đang kéo (đọc trong handler, không cần vẽ lại dòng). */
  dragId: string | null;
  onMenu: (node: TreeNode, parent: string | null, e: React.MouseEvent) => void;
}

/** Thuộc tính kéo-thả của một dòng: thả lên folder = vào trong; thả lên request = chèn trước nó. */
function dndProps(node: TreeNode, into: boolean, isEditing: boolean, api: { current: TreeApi }) {
  return {
    draggable: !isEditing,
    onDragStart: (e: React.DragEvent) => { e.stopPropagation(); api.current.setDragId(node.id); e.dataTransfer.effectAllowed = "move"; },
    onDragEnd: () => api.current.setDragId(null),
    onDragOver: (e: React.DragEvent) => { const d = api.current.dragId; if (d) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (d !== node.id) e.currentTarget.classList.add(into ? "drop-into" : "drop-before"); } },
    onDragLeave: (e: React.DragEvent) => e.currentTarget.classList.remove("drop-into", "drop-before"),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault(); e.stopPropagation();
      e.currentTarget.classList.remove("drop-into", "drop-before");
      const d = api.current.dragId;
      if (d) { moveNode(d, node.id, into); api.current.setDragId(null); }
    },
  };
}

function TreeName({ node, isEditing, api }: { node: TreeNode; isEditing: boolean; api: { current: TreeApi } }) {
  return isEditing ? (
    <input
      autoFocus
      className="tree-rename"
      defaultValue={node.name}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={(e) => { renameNode(node.id, e.target.value.trim() || node.name); api.current.setEditing(null); }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") api.current.setEditing(null);
      }}
      onClick={(e) => e.stopPropagation()}
    />
  ) : (
    <span className="grow ellipsis">{node.name}</span>
  );
}

/** Dòng folder (memo): nhận id đang sửa/chọn/kéo để truyền xuống con; dòng request chỉ nhận cờ boolean. */
const TreeRow = memo(function TreeRow({
  node, depth, parent, editing, sel, dragId, api,
}: {
  node: TreeNode;
  depth: number;
  parent: string | null;
  editing: string | null;
  sel: string | null;
  dragId: string | null;
  api: { current: TreeApi };
}) {
  renderLog("TreeRow");
  if (node.kind === "req") {
    return <ReqRow node={node} depth={depth} parent={parent} isEditing={editing === node.id} isSel={sel === node.id} isDragging={dragId === node.id} api={api} />;
  }
  const isEditing = editing === node.id;
  return (
    <>
      <div
        className={`tree-row ${dragId === node.id ? "dragging" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        tabIndex={0}
        {...dndProps(node, true, isEditing, api)}
        onClick={() => toggleFolder(node.id)}
        onKeyDown={(e) => {
          if (isEditing) return;
          rowKey(e, {
            F2: () => api.current.setEditing(node.id),
            Enter: () => toggleFolder(node.id),
            " ": () => toggleFolder(node.id),
            ArrowLeft: () => { if (node.open) toggleFolder(node.id); },
            ArrowRight: () => { if (!node.open) toggleFolder(node.id); },
            Delete: () => confirmRemove(node),
          });
        }}
        onContextMenu={(e) => api.current.onMenu(node, parent, e)}
      >
        <span className="tree-caret">{node.open ? <ChevronDown /> : <ChevronRight />}</span>
        <span className="tree-icon">{node.open ? <FolderOpen /> : <Folder />}</span>
        <TreeName node={node} isEditing={isEditing} api={api} />
        {node.prod && <span className="prod-tag">PROD</span>}
      </div>
      {node.open &&
        node.children.map((c) => (
          <TreeRow key={c.id} node={c} depth={depth + 1} parent={node.id} editing={editing} sel={sel} dragId={dragId} api={api} />
        ))}
    </>
  );
});

/** Dòng request (memo, props nguyên thuỷ): đổi chọn / kéo chỉ vẽ lại dòng liên quan. */
const ReqRow = memo(function ReqRow({ node, depth, parent, isEditing, isSel, isDragging, api }: {
  node: ReqNode;
  depth: number;
  parent: string | null;
  isEditing: boolean;
  isSel: boolean;
  isDragging: boolean;
  api: { current: TreeApi };
}) {
  renderLog("ReqRow");
  return (
    <div
      className={`tree-row req ${isSel ? "sel" : ""} ${isDragging ? "dragging" : ""}`}
      style={{ paddingLeft: 8 + depth * 14 }}
      tabIndex={0}
      {...dndProps(node, false, isEditing, api)}
      onClick={() => !isEditing && api.current.setSel(node.id)}
      onDoubleClick={() => !isEditing && openSavedRequest(node.id, node.name, node.req)}
      onKeyDown={(e) => {
        if (isEditing) return;
        rowKey(e, {
          F2: () => api.current.setEditing(node.id),
          Enter: () => { api.current.setSel(node.id); openSavedRequest(node.id, node.name, node.req); },
          Delete: () => confirmRemove(node),
        });
      }}
      onContextMenu={(e) => { api.current.setSel(node.id); api.current.onMenu(node, parent, e); }}
      title={node.req.url}
    >
      <span className={`method m-${node.req.method}`}>{node.req.method}</span>
      <TreeName node={node} isEditing={isEditing} api={api} />
    </div>
  );
});

/* ── Trình soạn header (danh sách name/value bật-tắt) ── */

function KVEditor({ rows, onChange, addLabel }: { rows: Header[]; onChange: (r: Header[]) => void; addLabel: string }) {
  const tr = useT();
  const set = (i: number, patch: Partial<Header>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="kv">
      {rows.map((r, i) => (
        <div className="kv-row" key={i}>
          <input type="checkbox" checked={r.on} title={tr("http.onOff")} onChange={(e) => set(i, { on: e.target.checked })} />
          <input className="kv-k" value={r.name} placeholder={tr("http.name")} onChange={(e) => set(i, { name: e.target.value })} />
          <input className="kv-v" value={r.value} placeholder={tr("http.value")} onChange={(e) => set(i, { value: e.target.value })} />
          <button className="icon-btn danger" title={tr("http.delete")} onClick={() => onChange(rows.filter((_, j) => j !== i))}><X /></button>
        </div>
      ))}
      <button className="kv-add" onClick={() => onChange([...rows, { name: "", value: "", on: true }])}><Plus /> {addLabel}</button>
    </div>
  );
}

/** Dropdown tự vẽ (hover đẹp như bên Git) thay cho <select> native. */
function SelectPicker({
  value, options, onPick, title, filter, className = "picker-field",
}: {
  value: string;
  options: { id: string; label: string; className?: string }[];
  onPick: (id: string) => void;
  title?: string;
  filter?: string;
  /** Class bọc để chỉnh bề rộng (mặc định full-width trong form). */
  className?: string;
}) {
  const current = options.find((o) => o.id === value);
  return (
    <div className={className}>
      <Picker
        title={title}
        filterPlaceholder={filter ?? t("http.filter")}
        label={<span className={`ellipsis ${current?.className ?? ""}`}>{current?.label ?? t("http.choose")}</span>}
        items={options.map((o) => ({ id: o.id, label: o.label, selected: o.id === value, className: o.className }))}
        onPick={onPick}
      />
    </div>
  );
}

/* ── Tab Auth: Bearer / Basic / API key, hỗ trợ {{biến}} ── */

function AuthEditor({ auth, onChange }: { auth: Auth; onChange: (a: Auth) => void }) {
  const tr = useT();
  const AUTH_TYPES = [
    { id: "none", label: tr("http.none") },
    { id: "bearer", label: "Bearer Token" },
    { id: "basic", label: "Basic Auth" },
    { id: "apikey", label: "API Key (header)" },
  ];
  const set = (p: Partial<Auth>) => onChange({ ...auth, ...p });
  return (
    <div className="form auth-editor">
      <div className="field">
        <span className="field-cap">{tr("http.authType")}</span>
        <SelectPicker value={auth.type} options={AUTH_TYPES} onPick={(id) => set({ type: id as Auth["type"] })} title={tr("http.authType")} />
      </div>
      {auth.type === "bearer" && (
        <label>Token<input value={auth.token} placeholder={tr("http.tokenOr")} onChange={(e) => set({ token: e.target.value })} /></label>
      )}
      {auth.type === "basic" && (
        <div className="form-row">
          <label className="grow">{tr("http.username")}<input value={auth.username} onChange={(e) => set({ username: e.target.value })} /></label>
          <label className="grow">{tr("http.password")}<input type="password" value={auth.password} onChange={(e) => set({ password: e.target.value })} /></label>
        </div>
      )}
      {auth.type === "apikey" && (
        <div className="form-row">
          <label className="grow">{tr("http.headerName")}<input value={auth.key} placeholder="X-API-Key" onChange={(e) => set({ key: e.target.value })} /></label>
          <label className="grow">{tr("http.value")}<input value={auth.value} placeholder="{{apiKey}}" onChange={(e) => set({ value: e.target.value })} /></label>
        </div>
      )}
      {auth.type !== "none" && (
        <div className="muted small">{tr("http.theAuthHeaderIsInsertedWhen")} <span className="mono">{"{{name}}"}</span> {tr("http.variablesVarsButtonInSidebar")}</div>
      )}
    </div>
  );
}

/* ── Modal biến môi trường ── */

function VarsModal({ onClose }: { onClose: () => void }) {
  const tr = useT();
  const vars = useVars();
  const rows = Object.entries(vars);
  const [k, setK] = useState("");
  const [v, setV] = useState("");
  const add = () => { if (k.trim()) { setVar(k.trim(), v); setK(""); setV(""); } };
  return (
    <Modal title={<><KeyRound /> {tr("http.environmentVariables2")}</>} width={520} onClose={onClose}>
      <div className="form save-form">
        <div className="muted small">{tr("http.use")} <span className="mono">{"{{name}}"}</span> {tr("http.inUrlHeaderBodyAuthScripts")} <span className="mono">setVar</span>.</div>
        {rows.length === 0 && <div className="muted small">{tr("http.noVariablesYet")}</div>}
        {rows.map(([name, val]) => (
          <div className="var-row" key={name}>
            <span className="mono var-k ellipsis" title={name}>{name}</span>
            <input value={val} onChange={(e) => setVar(name, e.target.value)} />
            <button className="icon-btn danger" title={tr("http.delete")} onClick={() => void confirmDialog({ message: tr("http.deleteVarConfirm", { name }) }).then((ok) => ok && removeVar(name))}><Trash2 /></button>
          </div>
        ))}
        <div className="var-row">
          <input placeholder={tr("http.variableName")} value={k} onChange={(e) => setK(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
          <input placeholder={tr("http.value2")} value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
          <button className="primary" disabled={!k.trim()} onClick={add}><Plus />{tr("http.add")}</button>
        </div>
      </div>
    </Modal>
  );
}

/* ── Tab params: đồng bộ với query của URL ── */

function ParamsEditor({ url, onUrl }: { url: string; onUrl: (u: string) => void }) {
  const tr = useT();
  const { base, params } = parseQuery(url);
  const [rows, setRows] = useState<{ k: string; v: string; on: boolean }[]>(() => params.map((p) => ({ ...p, on: true })));
  const lastBuilt = useRef(url);

  // URL đổi từ bên ngoài (gõ tay / dán curl) → nạp lại bảng.
  useEffect(() => {
    if (url !== lastBuilt.current) {
      setRows(parseQuery(url).params.map((p) => ({ ...p, on: true })));
      lastBuilt.current = url;
    }
  }, [url]);

  const apply = (next: { k: string; v: string; on: boolean }[]) => {
    setRows(next);
    const built = buildUrl(base, next);
    lastBuilt.current = built;
    onUrl(built);
  };
  const set = (i: number, patch: Partial<{ k: string; v: string; on: boolean }>) =>
    apply(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div className="kv">
      {rows.map((r, i) => (
        <div className="kv-row" key={i}>
          <input type="checkbox" checked={r.on} title={tr("http.onOff")} onChange={(e) => set(i, { on: e.target.checked })} />
          <input className="kv-k" value={r.k} placeholder={tr("http.param")} onChange={(e) => set(i, { k: e.target.value })} />
          <input className="kv-v" value={r.v} placeholder={tr("http.value")} onChange={(e) => set(i, { v: e.target.value })} />
          <button className="icon-btn danger" title={tr("http.delete")} onClick={() => apply(rows.filter((_, j) => j !== i))}><X /></button>
        </div>
      ))}
      <button className="kv-add" onClick={() => apply([...rows, { k: "", v: "", on: true }])}><Plus /> {tr("http.addParam")}</button>
    </div>
  );
}

const REQ_TABS = ["Params", "Headers", "Auth", "Body", "Script"] as const;
const RES_TABS = ["Body", "Headers"] as const;

/** Header suy ra từ cấu hình Auth (đã thay {{biến}}); null nếu kiểu None/thiếu dữ liệu. */
function authHeader(auth: Auth, vars: Record<string, string>): { name: string; value: string } | null {
  const b64 = (s: string) => { try { return btoa(String.fromCharCode(...new TextEncoder().encode(s))); } catch { return ""; } };
  const s = (t: string) => substitute(t, vars);
  if (auth.type === "bearer" && auth.token.trim()) return { name: "Authorization", value: `Bearer ${s(auth.token)}` };
  if (auth.type === "basic") return { name: "Authorization", value: `Basic ${b64(`${s(auth.username)}:${s(auth.password)}`)}` };
  if (auth.type === "apikey" && auth.key.trim()) return { name: s(auth.key), value: s(auth.value) };
  return null;
}

function fmtSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function TabView({ tab }: { tab: Tab }) {
  renderLog("HttpTab");
  const tr = useT();
  const log = useWorkbench((s) => s.log);
  const [req, setReq] = useState<ReqState>(() => loadReq(tab));
  const [reqTab, setReqTab] = useState<(typeof REQ_TABS)[number]>("Params");
  const [resTab, setResTab] = useState<(typeof RES_TABS)[number]>("Body");
  const [resp, setResp] = useState<HttpResp | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  // Đã lưu vào collection chưa (id của node); null = chưa lưu.
  const [savedId, setSavedId] = useState<string | null>(() => (typeof tab.payload.savedId === "string" ? tab.payload.savedId : null));
  /** Hộp lưu đang mở: tên gợi ý ban đầu; null = đóng. (Cây collection chỉ theo dõi trong hộp — đổi cây không vẽ lại tab.) */
  const [saveInit, setSaveInit] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [scriptMsg, setScriptMsg] = useState<{ ok: boolean; message: string } | null>(null);

  const patch = (p: Partial<ReqState>) => setReq((r) => ({ ...r, ...p }));

  // Lưu lại request theo tab.
  useEffect(() => {
    localStorage.setItem(reqKey(tab.id), JSON.stringify(req));
  }, [tab.id, req]);

  const applyCurl = (text: string) => {
    const p = parseCurl(text);
    if (!p) return setError(tr("http.couldnTParseAUrlFrom"));
    setReq((r) => ({
      ...r,
      method: p.method,
      url: p.url,
      headers: p.headers.length ? p.headers : r.headers,
      body: p.body ?? "",
      insecure: p.insecure,
    }));
    setReqTab(p.headers.length ? "Headers" : p.body ? "Body" : "Params");
    setError("");
    log(`curl → ${p.method} ${p.url}`);
  };

  const send = async () => {
    const url = req.url.trim();
    if (!url) return setError(tr("http.enterAUrl"));
    // Dán nguyên lệnh curl vào ô URL rồi bấm Send → tách trước.
    if (looksLikeCurl(url)) return applyCurl(url);
    if (savedId && isUnderProd(savedId) && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const ok = await confirmDialog({ message: tr("http.confirmSendProd", { method: req.method, url }), confirmLabel: tr("http.sendToProd") });
      if (!ok) return;
    }
    setSending(true);
    setError("");
    setScriptMsg(null);
    try {
      // Pre-request script: chạy TRƯỚC khi thay biến (vd. tính timestamp/chữ ký → setVar).
      if (req.preScript.trim()) {
        const pre = runPreScript(req.preScript, {
          method: req.method,
          url,
          body: req.body,
          headers: Object.fromEntries(req.headers.filter((h) => h.on && h.name.trim()).map((h) => [h.name, h.value])),
        });
        setScriptMsg(pre);
        log(`[pre-script] ${pre.message}`);
        if (!pre.ok) { setSending(false); return; } // pre-script lỗi → không gửi
      }
      // Thay {{biến}} trong URL / header / body và chèn header xác thực.
      const vars = getVars();
      const sub = (s: string) => substitute(s, vars);
      const hdrs = req.headers.filter((h) => h.on && h.name.trim()).map((h) => ({ name: sub(h.name), value: sub(h.value) }));
      const ah = authHeader(req.auth, vars);
      if (ah) {
        const i = hdrs.findIndex((h) => h.name.toLowerCase() === ah.name.toLowerCase());
        if (i >= 0) hdrs[i] = ah;
        else hdrs.push(ah);
      }
      const r = await sendHttp({
        method: req.method,
        url: sub(url),
        headers: hdrs,
        body: BODYLESS.has(req.method) ? null : sub(req.body) || null,
        insecure: req.insecure,
      });
      setResp(r);
      setResTab("Body");
      log(`${req.method} ${url} → ${r.status} ${r.statusText} (${r.timeMs}ms, ${fmtSize(r.bodyBytes)})`);
      // Script sau response (vd. lưu token vào biến).
      if (req.script.trim()) {
        const out = runScript(req.script, r);
        setScriptMsg(out);
        log(`[script] ${out.message}`);
      }
    } catch (e) {
      setResp(null);
      setError(errText(e));
      log(`${req.method} ${url} ✗ ${errText(e)}`);
    } finally {
      setSending(false);
    }
  };

  const copyCurl = () => {
    void copyText(toCurl(req));
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  // Body có phải JSON hợp lệ (để bật nút Format/Minify).
  const bodyIsJson = useMemo(() => {
    const t = req.body.trim();
    if (!t || (t[0] !== "{" && t[0] !== "[")) return false;
    try { JSON.parse(t); return true; } catch { return false; }
  }, [req.body]);

  const formatBody = (min: boolean) => {
    try {
      patch({ body: JSON.stringify(JSON.parse(req.body), null, min ? 0 : 2) });
      setError("");
    } catch {
      setError(tr("http.bodyIsNotValidJsonTo"));
    }
  };

  const flashSaved = () => { setSavedFlash(true); setTimeout(() => setSavedFlash(false), 1200); };
  const asSaved = (): SavedReq => ({ method: req.method, url: req.url, headers: req.headers, body: req.body, insecure: req.insecure, auth: req.auth, preScript: req.preScript, script: req.script });

  // Dấu "chưa lưu": so request hiện tại với bản đã lưu trong collection. Bản gốc (chuỗi JSON) chỉ đọc một lần
  // khi mở/sau khi lưu (không theo dõi cây → đổi cây không vẽ lại tab); so sánh chạy ở lượt render hoãn.
  const [baseline, setBaseline] = useState<string | null>(() => (savedId ? savedReqSnapshot(savedId) : null));
  const dReq = useDeferredValue(req);
  const dirty = useMemo(() => (baseline === null ? true : reqSnapshot(dReq) !== baseline), [dReq, baseline]);

  // Bấm Lưu: đã lưu rồi thì ghi đè tại chỗ; chưa thì mở hộp chọn folder + tên.
  const onSave = () => {
    if (savedId) {
      updateRequest(savedId, asSaved());
      setBaseline(reqSnapshot(req));
      flashSaved();
      log(t("http.logUpdatedSavedRequest"));
    } else {
      const u = req.url.trim();
      const path = (() => { try { return new URL(/:\/\//.test(u) ? u : `https://${u}`).pathname; } catch { return u; } })();
      setSaveInit(`${req.method} ${path || "/"}`);
    }
  };
  const confirmSave = (saveName: string, saveFolder: string) => {
    const name = saveName.trim() || `${req.method} ${req.url}`;
    const id = addRequest(saveFolder || null, name, asSaved());
    setSavedId(id);
    setBaseline(reqSnapshot(req));
    setSaveInit(null);
    flashSaved();
    log(t("http.logSavedRequest", { name }));
  };

  // Ctrl+S = Lưu (chỉ tab đang hiện của app HTTP; hộp lưu đang mở thì bỏ qua).
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  const saveOpen = saveInit !== null;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.code !== "KeyS") return;
      const wb = useWorkbench.getState();
      if (wb.activeApp !== "http" || wb.apps.http?.activeTabId !== tab.id || saveOpen) return;
      e.preventDefault();
      saveRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tab.id, saveOpen]);

  const urlIsCurl = looksLikeCurl(req.url);

  const headerCount = req.headers.filter((h) => h.on && h.name.trim()).length;
  const paramCount = parseQuery(req.url).params.length;

  return (
    <div className="view http">
      <div className="toolbar">
        <SelectPicker
          className="method-picker"
          value={req.method}
          options={METHODS.map((m) => ({ id: m, label: m, className: `m-${m}` }))}
          onPick={(id) => patch({ method: id })}
          title={tr("http.method")}
        />
        <input
          className="grow url"
          value={req.url}
          placeholder={tr("http.httpsApiOrPasteAWhole")}
          onChange={(e) => patch({ url: e.target.value })}
          onPaste={(e) => {
            const text = e.clipboardData.getData("text");
            if (looksLikeCurl(text)) { e.preventDefault(); applyCurl(text); }
          }}
          onKeyDown={(e) => e.key === "Enter" && void send()}
        />
        {urlIsCurl && <button onClick={() => applyCurl(req.url)} title={tr("http.parseCurlCommandIntoARequest")}><CornerRightDown /> {tr("http.parseCurl")}</button>}
        <button className="primary" disabled={sending} onClick={() => void send()}><Swap on={sending} a={<><Spinner /> {tr("http.sending")}</>} b={<><Send /> Send</>} /></button>
        <button
          onClick={onSave}
          title={`${savedId ? tr("http.overwriteTheSavedRequest") : tr("http.saveThisRequestIntoAFolder")}${dirty ? ` • ${tr("http.unsavedChanges")}` : ""} (Ctrl+S)`}
        >
          {savedFlash ? <Check /> : <Save />} {savedFlash ? tr("http.saved") : savedId ? tr("http.save") : tr("http.save2")}
          {savedId && <span className="unsaved-dot" style={{ visibility: !savedFlash && dirty ? "visible" : "hidden" }}>•</span>}
        </button>
        <button onClick={copyCurl} title={tr("http.copyThisRequestAsACurl")}><Swap on={copied} a={<><Check /> {tr("http.copied")}</>} b={<><Copy /> Copy curl</>} /></button>
      </div>

      {saveInit !== null && <SaveModal initialName={saveInit} onSave={confirmSave} onClose={() => setSaveInit(null)} />}

      {error && <div className="error-box pre"><TriangleAlert /> {error}</div>}

      <div className="pane">
        <div className="subtabs">
          {REQ_TABS.map((t) => (
            <button key={t} className={t === reqTab ? "on" : ""} onClick={() => setReqTab(t)}>
              {t}
              {t === "Headers" && headerCount > 0 ? ` (${headerCount})` : ""}
              {t === "Params" && paramCount > 0 ? ` (${paramCount})` : ""}
              {t === "Auth" && req.auth.type !== "none" ? " •" : ""}
              {t === "Script" && (req.preScript.trim() || req.script.trim()) ? " •" : ""}
            </button>
          ))}
          <span className="grow" />
          <label className="insecure" title={tr("http.skipTlsCertificateCheckDevSelf")}>
            <input type="checkbox" checked={req.insecure} onChange={(e) => patch({ insecure: e.target.checked })} /> {tr("http.skipTls")}
          </label>
        </div>
        <div className="req-body">
          {reqTab === "Params" && <ParamsEditor url={req.url} onUrl={(u) => patch({ url: u })} />}
          {reqTab === "Headers" && <KVEditor rows={req.headers} onChange={(h) => patch({ headers: h })} addLabel={tr("http.addHeader")} />}
          {reqTab === "Auth" && <AuthEditor auth={req.auth} onChange={(a) => patch({ auth: a })} />}
          {reqTab === "Script" && (
            <div className="script-editor">
              <div className="script-section">
                <div className="script-title">{tr("http.preRequest")}</div>
                <div className="muted small script-help">
                  {tr("http.runsBeforeSendingComputeSetvarUsed")} <span className="mono">req</span>, <span className="mono">vars</span>, <span className="mono">setVar</span>, <span className="mono">getVar</span>.
                </div>
                <textarea
                  className="req-raw mono script-pre"
                  value={req.preScript}
                  placeholder={tr("http.eGTimestampSignatureSetvarTs")}
                  onChange={(e) => patch({ preScript: e.target.value })}
                />
              </div>
              <div className="script-section">
                <div className="script-title">{tr("http.afterResponse")}</div>
                <div className="muted small script-help">
                  {tr("http.runsAfterTheResponseAvailable")} <span className="mono">json</span>, <span className="mono">resp</span>
                  {" "}(status/headers/body), <span className="mono">setVar(name, value)</span>, <span className="mono">getVar(name)</span>.
                </div>
                <textarea
                  className="req-raw mono script-post"
                  value={req.script}
                  placeholder={tr("http.saveTokenFromResponseIntoSetvar")}
                  onChange={(e) => patch({ script: e.target.value })}
                />
              </div>
              {scriptMsg && <div className={`script-msg ${scriptMsg.ok ? "" : "danger-text"}`}>{scriptMsg.ok ? <Check /> : <TriangleAlert />} {scriptMsg.message}</div>}
            </div>
          )}
          {reqTab === "Body" && (
            BODYLESS.has(req.method) ? (
              <div className="empty">{tr("http.sendsNoRequestBody", { method: req.method })}</div>
            ) : (
              <>
                <div className="body-toolbar">
                  <span className="muted small grow">{req.body.trim() ? tr("http.chars", { bodyLength: req.body.length }) : tr("http.requestBody")}</span>
                  <button className="link" disabled={!bodyIsJson} title={tr("http.formatJsonForReadability")} onClick={() => formatBody(false)}><Sparkles /> Format JSON</button>
                  <button className="link" disabled={!bodyIsJson} title={tr("http.collapseJsonToOneLine")} onClick={() => formatBody(true)}><Minimize2 />Minify</button>
                </div>
                <textarea
                  className="req-raw mono"
                  value={req.body}
                  placeholder={tr("http.requestBodyJsonFormExample")}
                  onChange={(e) => patch({ body: e.target.value })}
                />
              </>
            )
          )}
        </div>
      </div>

      <ResponsePane resp={resp} sending={sending} resTab={resTab} setResTab={setResTab} />
    </div>
  );
}

/** Hộp lưu request vào collection: tự theo dõi cây (chỉ khi mở) + giữ state tên/thư mục riêng. */
function SaveModal({ initialName, onSave, onClose }: { initialName: string; onSave: (name: string, folder: string) => void; onClose: () => void }) {
  const tr = useT();
  const tree = useTree();
  const folders = useMemo(() => flattenFolders(tree), [tree]);
  const [saveName, setSaveName] = useState(initialName);
  const [saveFolder, setSaveFolder] = useState("");
  return (
    <Modal title={<><Save /> {tr("http.saveRequestToCollection")}</>} width={560} onClose={onClose}>
      <div className="form save-form">
        <label>{tr("http.name")}
          <input autoFocus value={saveName} onChange={(e) => setSaveName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") onSave(saveName, saveFolder); if (e.key === "Escape") onClose(); }} />
        </label>
        <div className="field">
          <span className="field-cap">{tr("http.folder")}</span>
          <SelectPicker
            value={saveFolder}
            options={[{ id: "", label: tr("http.collectionsRoot") }, ...folders.map((f) => ({ id: f.id, label: f.label }))]}
            onPick={setSaveFolder}
            title={tr("http.chooseFolder")}
            filter={tr("http.filterFolders")}
          />
        </div>
        <div className="muted small">{tr("http.tipCreateAFolderInThe")}</div>
        <div className="toolbar">
          <span className="grow" />
          <button onClick={onClose}><X />{tr("http.cancel")}</button>
          <button className="primary" disabled={!saveName.trim()} onClick={() => onSave(saveName, saveFolder)}><Save />{tr("http.save")}</button>
        </div>
      </div>
    </Modal>
  );
}

/** Khung response (memo): gõ URL/body/header ở trên không vẽ lại body response lớn + bảng header. */
const ResponsePane = memo(function ResponsePane({ resp, sending, resTab, setResTab }: {
  resp: HttpResp | null;
  sending: boolean;
  resTab: (typeof RES_TABS)[number];
  setResTab: (t: (typeof RES_TABS)[number]) => void;
}) {
  renderLog("ResponsePane");
  const tr = useT();
  const [pretty, setPretty] = useState(true);
  const isJson = useMemo(() => {
    const contentType = resp?.headers.find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
    return /json/i.test(contentType) || /^\s*[[{]/.test(resp?.body ?? "");
  }, [resp]);
  const shownBody = useMemo(() => {
    if (!resp) return "";
    if (pretty && isJson) {
      try {
        return JSON.stringify(JSON.parse(resp.body), null, 2);
      } catch {
        return resp.body;
      }
    }
    return resp.body;
  }, [resp, pretty, isJson]);
  return (
      <div className="pane">
        <div className="subtabs">
          {RES_TABS.map((t) => (
            <button key={t} className={t === resTab ? "on" : ""} onClick={() => setResTab(t)}>{t}</button>
          ))}
          {isJson && resTab === "Body" && (
            <button className={pretty ? "on" : ""} onClick={() => setPretty((v) => !v)} title={tr("http.toggleJsonFormatting")}><Braces />{pretty ? "Pretty" : "Raw"}</button>
          )}
          <span className="grow" />
          {resp && resTab === "Body" && shownBody && (
            <button className="icon-btn" title={tr("http.copyResponse")} aria-label={tr("http.copyResponse")} onClick={() => void copyText(shownBody)}><Copy /></button>
          )}
          {resp ? (
            <span className="res-meta">
              <span className={`res-status st-${Math.floor(resp.status / 100)}`}>{resp.status} {resp.statusText}</span>
              <span className="muted small">{resp.timeMs} ms · {fmtSize(resp.bodyBytes)}</span>
            </span>
          ) : (
            <span className="muted small">{sending ? tr("http.sending") : tr("http.notSent")}</span>
          )}
        </div>
        {!resp ? (
          sending ? <Loading label={tr("http.waitingForResponse")} /> : <div className="empty">{tr("http.clickSendToSendTheRequest")}</div>
        ) : resTab === "Body" ? (
          <>
            {resp.truncated && <div className="muted small pad">{tr("http.responseTooLargeShowingFirst", { p: fmtSize(8 * 1024 * 1024) })}</div>}
            <pre className="res-raw mono">{shownBody || tr("http.emptyBody")}</pre>
          </>
        ) : (
          <div className="res-headers mono">
            {resp.headers.map(([k, v], i) => (
              <div key={i} className="res-h"><span className="res-hk">{k}</span><span className="res-hv">{v}</span></div>
            ))}
            {!resp.headers.length && <div className="muted small pad">{t("http.noHeaders")}</div>}
          </div>
        )}
      </div>
  );
});

/** Gốc app HTTP: bố cục tab + phím tắt Ctrl+N mở request mới (khi đang ở app này). */
function HttpRoot() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === "KeyN") {
        if (useWorkbench.getState().activeApp === "http") { e.preventDefault(); newRequest(); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return <TabbedLayout appId="http" Sidebar={Sidebar} TabView={TabView} empty={<HttpEmpty />} />;
}

const httpApp: AppModule = {
  View: HttpRoot,
  commands: () => [{ id: "http.new", group: "HTTP", title: t("http.newRequest"), hint: "Ctrl+N", run: () => newRequest() }],
};

function HttpEmpty() {
  const tr = useT();
  return (
    <div className="welcome">
      <h1><Zap /> HTTP Client</h1>
      <p className="muted">{tr("http.sendRealRequestsViaRustNo")}</p>
      <div className="toolbar">
        <button className="primary" onClick={() => newRequest()}><Plus /> {tr("http.newRequest")}</button>
      </div>
    </div>
  );
}

export default httpApp;
