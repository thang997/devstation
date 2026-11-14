import { useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { AppModule, Tab } from "../types";
import { useWorkbench } from "../../store/workbench";
import { t, useT } from "../../store/lang";
import { TabbedLayout } from "../../shell/TabbedLayout";
import { ContextMenu, type CtxItem } from "../../shell/ContextMenu";
import { Modal } from "../../shell/Modal";
import { confirmDialog } from "../../shell/confirm";
import { Picker } from "../../shell/Picker";
import { sendHttp, readFile, readDir, errText, NO_AUTH, type Auth, type Header, type HttpResp } from "./api";
import { looksLikeCurl, parseCurl, parseCurlFile, type ParsedCurl } from "./curl";
import { getVars, removeVar, runPreScript, runScript, setVar, substitute, useVars } from "./vars";
import {
  addFolder, addRequest, ensureFolder, flattenFolders, moveNode, removeNode, renameNode, toggleFolder, updateRequest, useTree,
  type SavedReq, type TreeNode,
} from "./collections";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
const BODYLESS = new Set(["GET", "HEAD"]);

let untitled = 0;
export function newRequest(init?: { method?: string; url?: string; name?: string }) {
  useWorkbench.getState().openTab({
    id: `http:new-${++untitled}`,
    appId: "http",
    title: `⚡ ${init?.name ?? t("New request", "Request mới")}`,
    payload: { method: init?.method ?? "GET", url: init?.url ?? "" },
  });
}

/** Mở một request đã lưu trong collection thành tab làm việc (mang theo đủ headers/body + id đã lưu). */
function openSavedRequest(id: string, name: string, r: SavedReq) {
  useWorkbench.getState().openTab({
    id: `http:saved-${++untitled}`,
    appId: "http",
    title: `⚡ ${name}`,
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
function importReqsInto(parent: string | null, reqs: ParsedCurl[], folderName: string) {
  if (reqs.length === 1) return void addRequest(parent, reqName(reqs[0]), toSaved(reqs[0]));
  const fid = addFolder(parent, folderName);
  for (const r of reqs) addRequest(fid, reqName(r), toSaved(r));
}

function Sidebar() {
  const tr = useT();
  const tree = useTree();
  const [msg, setMsg] = useState("");
  const [menu, setMenu] = useState<{ node: TreeNode; parent: string | null; x: number; y: number } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [varsOpen, setVarsOpen] = useState(false);
  const vars = useVars();

  const importFile = async () => {
    setMsg("");
    try {
      const f = await openDialog({ multiple: false, title: tr("Choose a file with curl commands", "Chọn file chứa lệnh curl") });
      if (typeof f !== "string") return;
      const reqs = parseCurlFile(await readFile(f));
      if (!reqs.length) return setMsg(tr("No curl commands found in the file", "Không thấy lệnh curl nào trong file"));
      importReqsInto(null, reqs, baseName(f));
      setMsg(tr(`Imported ${reqs.length} requests from ${baseName(f)}`, `Đã import ${reqs.length} request từ ${baseName(f)}`));
    } catch (e) {
      setMsg(errText(e));
    }
  };

  const importFolder = async () => {
    setMsg("");
    try {
      const dir = await openDialog({ directory: true, title: tr("Choose a folder of command files", "Chọn thư mục chứa các file lệnh") });
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
      setMsg(count ? tr(`Imported ${count} requests from ${baseName(dir)}`, `Đã import ${count} request từ ${baseName(dir)}`) : tr("No curl commands found in the folder", "Không thấy lệnh curl nào trong thư mục"));
    } catch (e) {
      setMsg(errText(e));
    }
  };

  return (
    <div className="side-list">
      <div className="side-head">
        <span>COLLECTIONS</span>
        <span className="side-actions">
          <button className="icon-btn" title={tr("New request", "Request mới")} onClick={() => newRequest()}>＋</button>
          <button className="icon-btn" title={tr("New folder", "Thư mục mới")} onClick={() => setEditing(addFolder(null))}>🗂</button>
          <button className="icon-btn" title={tr("Import curl command file", "Import file lệnh curl")} onClick={() => void importFile()}>📄</button>
          <button className="icon-btn" title={tr("Import a whole folder of commands", "Import cả thư mục lệnh")} onClick={() => void importFolder()}>📁</button>
          <button className="icon-btn" title={`${tr("Environment variables", "Biến môi trường")}${Object.keys(vars).length ? ` (${Object.keys(vars).length})` : ""}`} onClick={() => setVarsOpen(true)}>🔑</button>
        </span>
      </div>
      {varsOpen && <VarsModal onClose={() => setVarsOpen(false)} />}
      {msg && <div className="muted small pad">{msg}</div>}
      {tree.length === 0 && <div className="muted small pad">{tr("Nothing yet. Create a folder, or import a file/folder of curl commands.", "Chưa có gì. Tạo thư mục, hoặc import file/thư mục chứa lệnh curl.")}</div>}
      <div
        className="tree"
        onDragOver={(e) => { if (dragId) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; } }}
        onDrop={(e) => { if (dragId) { e.preventDefault(); moveNode(dragId, null, false); setDragId(null); } }}
      >
        {tree.map((n) => (
          <TreeRow
            key={n.id}
            node={n}
            depth={0}
            parent={null}
            editing={editing}
            setEditing={setEditing}
            dragId={dragId}
            setDragId={setDragId}
            sel={sel}
            setSel={setSel}
            onMenu={(node, parent, e) => { e.preventDefault(); setMenu({ node, parent, x: e.clientX, y: e.clientY }); }}
          />
        ))}
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
  const items: CtxItem[] = [{ id: "rename", label: t("Rename", "Đổi tên"), action: () => setEditing(node.id) }];
  if (node.kind === "folder") {
    items.push(
      { id: "newReqHere", label: t("New request here", "Request mới trong đây"), action: () => setEditing(addRequestHere(node.id)) },
      { id: "newFolderHere", label: t("Subfolder", "Thư mục con"), action: () => setEditing(addFolder(node.id)) },
    );
  } else {
    items.push({ id: "open", label: t("Open request", "Mở request"), action: () => openSavedRequest(node.id, node.name, node.req) });
  }
  items.push({ id: "s", sep: true }, {
    id: "del", label: t("Delete", "Xoá"), danger: true,
    action: () => void confirmDialog({ message: t(`Delete “${node.name}”${node.kind === "folder" ? " and everything inside" : ""}?`, `Xoá “${node.name}”${node.kind === "folder" ? " và mọi thứ bên trong" : ""}?`) }).then((ok) => ok && removeNode(node.id)),
  });
  return items;
}

/** Tạo một request rỗng trong folder và trả id để đổi tên ngay. */
function addRequestHere(folderId: string): string {
  return addRequest(folderId, "GET /", { method: "GET", url: "", headers: [], body: "", insecure: false });
}

function TreeRow({
  node, depth, parent, editing, setEditing, dragId, setDragId, sel, setSel, onMenu,
}: {
  node: TreeNode;
  depth: number;
  parent: string | null;
  editing: string | null;
  setEditing: (id: string | null) => void;
  dragId: string | null;
  setDragId: (id: string | null) => void;
  sel: string | null;
  setSel: (id: string | null) => void;
  onMenu: (node: TreeNode, parent: string | null, e: React.MouseEvent) => void;
}) {
  const pad = { paddingLeft: 8 + depth * 14 };
  const isEditing = editing === node.id;
  // Kéo-thả: thả lên folder = vào trong; thả lên request = chèn trước nó.
  const dnd = (into: boolean) => ({
    draggable: !isEditing,
    onDragStart: (e: React.DragEvent) => { e.stopPropagation(); setDragId(node.id); e.dataTransfer.effectAllowed = "move"; },
    onDragEnd: () => setDragId(null),
    onDragOver: (e: React.DragEvent) => { if (dragId) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (dragId !== node.id) e.currentTarget.classList.add(into ? "drop-into" : "drop-before"); } },
    onDragLeave: (e: React.DragEvent) => e.currentTarget.classList.remove("drop-into", "drop-before"),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault(); e.stopPropagation();
      e.currentTarget.classList.remove("drop-into", "drop-before");
      if (dragId) { moveNode(dragId, node.id, into); setDragId(null); }
    },
  });

  const nameEl = isEditing ? (
    <input
      autoFocus
      className="tree-rename"
      defaultValue={node.name}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={(e) => { renameNode(node.id, e.target.value.trim() || node.name); setEditing(null); }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") setEditing(null);
      }}
      onClick={(e) => e.stopPropagation()}
    />
  ) : (
    <span className="grow ellipsis">{node.name}</span>
  );

  if (node.kind === "folder") {
    return (
      <>
        <div
          className={`tree-row ${dragId === node.id ? "dragging" : ""}`}
          style={pad}
          tabIndex={0}
          {...dnd(true)}
          onClick={() => toggleFolder(node.id)}
          onKeyDown={(e) => { if (e.key === "F2") { e.preventDefault(); setEditing(node.id); } }}
          onContextMenu={(e) => onMenu(node, parent, e)}
        >
          <span className="tree-caret">{node.open ? "▾" : "▸"}</span>
          <span className="tree-icon">🗂</span>
          {nameEl}
        </div>
        {node.open &&
          (node.children as TreeNode[]).map((c) => (
            <TreeRow key={c.id} node={c} depth={depth + 1} parent={node.id} editing={editing} setEditing={setEditing} dragId={dragId} setDragId={setDragId} sel={sel} setSel={setSel} onMenu={onMenu} />
          ))}
      </>
    );
  }
  return (
    <div
      className={`tree-row req ${sel === node.id ? "sel" : ""} ${dragId === node.id ? "dragging" : ""}`}
      style={pad}
      tabIndex={0}
      {...dnd(false)}
      onClick={() => !isEditing && setSel(node.id)}
      onDoubleClick={() => !isEditing && openSavedRequest(node.id, node.name, node.req)}
      onKeyDown={(e) => {
        if (e.key === "F2") { e.preventDefault(); setEditing(node.id); }
        if (e.key === "Enter") { e.preventDefault(); openSavedRequest(node.id, node.name, node.req); }
      }}
      onContextMenu={(e) => { setSel(node.id); onMenu(node, parent, e); }}
      title={node.req.url}
    >
      <span className={`method m-${node.req.method}`}>{node.req.method}</span>
      {nameEl}
    </div>
  );
}

/* ── Trình soạn header (danh sách name/value bật-tắt) ── */

function KVEditor({ rows, onChange, addLabel }: { rows: Header[]; onChange: (r: Header[]) => void; addLabel: string }) {
  const tr = useT();
  const set = (i: number, patch: Partial<Header>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="kv">
      {rows.map((r, i) => (
        <div className="kv-row" key={i}>
          <input type="checkbox" checked={r.on} title={tr("On/off", "Bật/tắt")} onChange={(e) => set(i, { on: e.target.checked })} />
          <input className="kv-k" value={r.name} placeholder={tr("Name", "Tên")} onChange={(e) => set(i, { name: e.target.value })} />
          <input className="kv-v" value={r.value} placeholder={tr("Value", "Giá trị")} onChange={(e) => set(i, { value: e.target.value })} />
          <button className="icon-btn" title={tr("Delete", "Xoá")} onClick={() => onChange(rows.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <button className="kv-add" onClick={() => onChange([...rows, { name: "", value: "", on: true }])}>＋ {addLabel}</button>
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
        filterPlaceholder={filter ?? t("Filter…", "Lọc…")}
        label={<span className={`ellipsis ${current?.className ?? ""}`}>{current?.label ?? t("Choose…", "Chọn…")}</span>}
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
    { id: "none", label: tr("None", "Không") },
    { id: "bearer", label: "Bearer Token" },
    { id: "basic", label: "Basic Auth" },
    { id: "apikey", label: "API Key (header)" },
  ];
  const set = (p: Partial<Auth>) => onChange({ ...auth, ...p });
  return (
    <div className="form auth-editor">
      <div className="field">
        <span className="field-cap">{tr("Auth type", "Kiểu xác thực")}</span>
        <SelectPicker value={auth.type} options={AUTH_TYPES} onPick={(id) => set({ type: id as Auth["type"] })} title={tr("Auth type", "Kiểu xác thực")} />
      </div>
      {auth.type === "bearer" && (
        <label>Token<input value={auth.token} placeholder={tr("token or {{token}}", "token hoặc {{token}}")} onChange={(e) => set({ token: e.target.value })} /></label>
      )}
      {auth.type === "basic" && (
        <div className="form-row">
          <label className="grow">Username<input value={auth.username} onChange={(e) => set({ username: e.target.value })} /></label>
          <label className="grow">Password<input value={auth.password} onChange={(e) => set({ password: e.target.value })} /></label>
        </div>
      )}
      {auth.type === "apikey" && (
        <div className="form-row">
          <label className="grow">{tr("Header name", "Tên header")}<input value={auth.key} placeholder="X-API-Key" onChange={(e) => set({ key: e.target.value })} /></label>
          <label className="grow">{tr("Value", "Giá trị")}<input value={auth.value} placeholder="{{apiKey}}" onChange={(e) => set({ value: e.target.value })} /></label>
        </div>
      )}
      {auth.type !== "none" && (
        <div className="muted small">{tr("The auth header is inserted when sending. You can use", "Header xác thực được chèn khi gửi. Dùng được biến")} <span className="mono">{"{{name}}"}</span> {tr("variables (Vars button in sidebar).", "(nút Biến ở sidebar).")}</div>
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
    <Modal title={tr("🔑 Environment variables", "🔑 Biến môi trường")} width={520} onClose={onClose}>
      <div className="form save-form">
        <div className="muted small">{tr("Use", "Dùng")} <span className="mono">{"{{name}}"}</span> {tr("in URL / header / body / auth. Scripts can set with", "trong URL / header / body / auth. Script có thể đặt bằng")} <span className="mono">setVar</span>.</div>
        {rows.length === 0 && <div className="muted small">{tr("No variables yet.", "Chưa có biến nào.")}</div>}
        {rows.map(([name, val]) => (
          <div className="var-row" key={name}>
            <span className="mono var-k ellipsis" title={name}>{name}</span>
            <input value={val} onChange={(e) => setVar(name, e.target.value)} />
            <button className="icon-btn" title={tr("Delete", "Xoá")} onClick={() => removeVar(name)}>×</button>
          </div>
        ))}
        <div className="var-row">
          <input placeholder={tr("variable name", "tên biến")} value={k} onChange={(e) => setK(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
          <input placeholder={tr("value", "giá trị")} value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
          <button className="primary" disabled={!k.trim()} onClick={add}>{tr("Add", "Thêm")}</button>
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
          <input type="checkbox" checked={r.on} title={tr("On/off", "Bật/tắt")} onChange={(e) => set(i, { on: e.target.checked })} />
          <input className="kv-k" value={r.k} placeholder={tr("Param", "Tham số")} onChange={(e) => set(i, { k: e.target.value })} />
          <input className="kv-v" value={r.v} placeholder={tr("Value", "Giá trị")} onChange={(e) => set(i, { v: e.target.value })} />
          <button className="icon-btn" title={tr("Delete", "Xoá")} onClick={() => apply(rows.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <button className="kv-add" onClick={() => apply([...rows, { k: "", v: "", on: true }])}>＋ {tr("Add param", "Thêm tham số")}</button>
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
  const tr = useT();
  const log = useWorkbench((s) => s.log);
  const [req, setReq] = useState<ReqState>(() => loadReq(tab));
  const [reqTab, setReqTab] = useState<(typeof REQ_TABS)[number]>("Params");
  const [resTab, setResTab] = useState<(typeof RES_TABS)[number]>("Body");
  const [resp, setResp] = useState<HttpResp | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [pretty, setPretty] = useState(true);
  const [copied, setCopied] = useState(false);
  // Đã lưu vào collection chưa (id của node); null = chưa lưu.
  const [savedId, setSavedId] = useState<string | null>(() => (typeof tab.payload.savedId === "string" ? tab.payload.savedId : null));
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveFolder, setSaveFolder] = useState<string>("");
  const [savedFlash, setSavedFlash] = useState(false);
  const [scriptMsg, setScriptMsg] = useState<{ ok: boolean; message: string } | null>(null);
  const folders = flattenFolders(useTree());

  const patch = (p: Partial<ReqState>) => setReq((r) => ({ ...r, ...p }));

  // Lưu lại request theo tab.
  useEffect(() => {
    localStorage.setItem(reqKey(tab.id), JSON.stringify(req));
  }, [tab.id, req]);

  const applyCurl = (text: string) => {
    const p = parseCurl(text);
    if (!p) return setError(tr("Couldn't parse a URL from the pasted curl command", "Không tách được URL từ lệnh curl đã dán"));
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
    if (!url) return setError(tr("Enter a URL", "Nhập URL"));
    // Dán nguyên lệnh curl vào ô URL rồi bấm Send → tách trước.
    if (looksLikeCurl(url)) return applyCurl(url);
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
    void navigator.clipboard.writeText(toCurl(req));
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
      setError(tr("Body is not valid JSON to format", "Body không phải JSON hợp lệ để format"));
    }
  };

  const flashSaved = () => { setSavedFlash(true); setTimeout(() => setSavedFlash(false), 1200); };
  const asSaved = (): SavedReq => ({ method: req.method, url: req.url, headers: req.headers, body: req.body, insecure: req.insecure, auth: req.auth, preScript: req.preScript, script: req.script });

  // Bấm Lưu: đã lưu rồi thì ghi đè tại chỗ; chưa thì mở hộp chọn folder + tên.
  const onSave = () => {
    if (savedId) {
      updateRequest(savedId, asSaved());
      flashSaved();
      log(`[http] cập nhật request đã lưu`);
    } else {
      const u = req.url.trim();
      const path = (() => { try { return new URL(/:\/\//.test(u) ? u : `https://${u}`).pathname; } catch { return u; } })();
      setSaveName(`${req.method} ${path || "/"}`);
      setSaveFolder("");
      setSaveOpen(true);
    }
  };
  const confirmSave = () => {
    const name = saveName.trim() || `${req.method} ${req.url}`;
    const id = addRequest(saveFolder || null, name, asSaved());
    setSavedId(id);
    setSaveOpen(false);
    flashSaved();
    log(`[http] lưu request “${name}” vào collection`);
  };

  const urlIsCurl = looksLikeCurl(req.url);
  const contentType = resp?.headers.find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
  const isJson = /json/i.test(contentType) || /^\s*[[{]/.test(resp?.body ?? "");
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
          title={tr("Method", "Phương thức")}
        />
        <input
          className="grow url"
          value={req.url}
          placeholder={tr("https://api… or paste a whole curl command here", "https://api… hoặc dán nguyên lệnh curl vào đây")}
          onChange={(e) => patch({ url: e.target.value })}
          onPaste={(e) => {
            const text = e.clipboardData.getData("text");
            if (looksLikeCurl(text)) { e.preventDefault(); applyCurl(text); }
          }}
          onKeyDown={(e) => e.key === "Enter" && void send()}
        />
        {urlIsCurl && <button onClick={() => applyCurl(req.url)} title={tr("Parse curl command into a request", "Tách lệnh curl thành request")}>⤵ {tr("Parse curl", "Tách curl")}</button>}
        <button className="primary" disabled={sending} onClick={() => void send()}>{sending ? tr("Sending…", "Đang gửi…") : "Send"}</button>
        <button
          onClick={onSave}
          title={savedId ? tr("Overwrite the saved request", "Ghi đè vào request đã lưu") : tr("Save this request into a folder", "Lưu request này vào một folder")}
        >
          {savedFlash ? tr("✓ Saved", "✓ Đã lưu") : savedId ? tr("Save", "Lưu") : tr("💾 Save", "💾 Lưu")}
        </button>
        <button onClick={copyCurl} title={tr("Copy this request as a curl command", "Copy request này thành lệnh curl")}>{copied ? tr("✓ Copied", "✓ Đã copy") : "Copy curl"}</button>
      </div>

      {saveOpen && (
        <Modal title={tr("💾 Save request to collection", "💾 Lưu request vào collection")} width={560} onClose={() => setSaveOpen(false)}>
          <div className="form save-form">
            <label>{tr("Name", "Tên")}
              <input autoFocus value={saveName} onChange={(e) => setSaveName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") confirmSave(); if (e.key === "Escape") setSaveOpen(false); }} />
            </label>
            <div className="field">
              <span className="field-cap">{tr("Folder", "Thư mục")}</span>
              <SelectPicker
                value={saveFolder}
                options={[{ id: "", label: tr("(Collections root)", "(Gốc collections)") }, ...folders.map((f) => ({ id: f.id, label: f.label }))]}
                onPick={setSaveFolder}
                title={tr("Choose folder", "Chọn thư mục")}
                filter={tr("Filter folders…", "Lọc thư mục…")}
              />
            </div>
            <div className="muted small">{tr("Tip: create a folder in the sidebar first if you want to group.", "Mẹo: tạo thư mục ở sidebar trước nếu muốn gom nhóm.")}</div>
            <div className="toolbar">
              <span className="grow" />
              <button onClick={() => setSaveOpen(false)}>{tr("Cancel", "Huỷ")}</button>
              <button className="primary" disabled={!saveName.trim()} onClick={confirmSave}>{tr("Save", "Lưu")}</button>
            </div>
          </div>
        </Modal>
      )}

      {error && <div className="error-box pre">⚠ {error}</div>}

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
          <label className="insecure" title={tr("Skip TLS certificate check (dev self-signed servers)", "Bỏ qua kiểm tra chứng chỉ TLS (server dev self-signed)")}>
            <input type="checkbox" checked={req.insecure} onChange={(e) => patch({ insecure: e.target.checked })} /> {tr("Skip TLS", "Bỏ qua TLS")}
          </label>
        </div>
        <div className="req-body">
          {reqTab === "Params" && <ParamsEditor url={req.url} onUrl={(u) => patch({ url: u })} />}
          {reqTab === "Headers" && <KVEditor rows={req.headers} onChange={(h) => patch({ headers: h })} addLabel={tr("Add header", "Thêm header")} />}
          {reqTab === "Auth" && <AuthEditor auth={req.auth} onChange={(a) => patch({ auth: a })} />}
          {reqTab === "Script" && (
            <div className="script-editor">
              <div className="script-section">
                <div className="script-title">{tr("Pre-request", "Trước khi gửi")}</div>
                <div className="muted small script-help">
                  {tr("Runs before sending (compute → setVar → used via {{var}}). Available:", "Chạy trước khi gửi (tính toán → setVar → dùng qua {{var}}). Có sẵn:")} <span className="mono">req</span>, <span className="mono">vars</span>, <span className="mono">setVar</span>, <span className="mono">getVar</span>.
                </div>
                <textarea
                  className="req-raw mono script-pre"
                  value={req.preScript}
                  placeholder={tr('// e.g. timestamp + signature\nsetVar("ts", Date.now())', '// vd. timestamp + chữ ký\nsetVar("ts", Date.now())')}
                  onChange={(e) => patch({ preScript: e.target.value })}
                />
              </div>
              <div className="script-section">
                <div className="script-title">{tr("After response", "Sau response")}</div>
                <div className="muted small script-help">
                  {tr("Runs after the response. Available:", "Chạy sau khi nhận response. Có sẵn:")} <span className="mono">json</span>, <span className="mono">resp</span>
                  {" "}(status/headers/body), <span className="mono">setVar(name, value)</span>, <span className="mono">getVar(name)</span>.
                </div>
                <textarea
                  className="req-raw mono script-post"
                  value={req.script}
                  placeholder={tr('// Save token from response into {{token}}\nsetVar("token", json.access_token)', '// Lưu token từ response vào biến {{token}}\nsetVar("token", json.access_token)')}
                  onChange={(e) => patch({ script: e.target.value })}
                />
              </div>
              {scriptMsg && <div className={`script-msg ${scriptMsg.ok ? "" : "danger-text"}`}>{scriptMsg.ok ? "✓ " : "⚠ "}{scriptMsg.message}</div>}
            </div>
          )}
          {reqTab === "Body" && (
            BODYLESS.has(req.method) ? (
              <div className="empty">{tr(`${req.method} sends no request body`, `${req.method} không gửi thân request`)}</div>
            ) : (
              <>
                <div className="body-toolbar">
                  <span className="muted small grow">{req.body.trim() ? tr(`${req.body.length} chars`, `${req.body.length} ký tự`) : tr("Request body", "Thân request")}</span>
                  <button className="link" disabled={!bodyIsJson} title={tr("Format JSON for readability", "Định dạng JSON cho dễ đọc")} onClick={() => formatBody(false)}>✨ Format JSON</button>
                  <button className="link" disabled={!bodyIsJson} title={tr("Collapse JSON to one line", "Thu gọn JSON về một dòng")} onClick={() => formatBody(true)}>Minify</button>
                </div>
                <textarea
                  className="req-raw mono"
                  value={req.body}
                  placeholder={tr('Request body (JSON, form…)\nExample: {"email":"a@b.c"}', 'Thân request (JSON, form…)\nVí dụ: {"email":"a@b.c"}')}
                  onChange={(e) => patch({ body: e.target.value })}
                />
              </>
            )
          )}
        </div>
      </div>

      <div className="pane">
        <div className="subtabs">
          {RES_TABS.map((t) => (
            <button key={t} className={t === resTab ? "on" : ""} onClick={() => setResTab(t)}>{t}</button>
          ))}
          {isJson && resTab === "Body" && (
            <button className={pretty ? "on" : ""} onClick={() => setPretty((v) => !v)} title={tr("Toggle JSON formatting", "Bật/tắt định dạng JSON")}>{pretty ? "Pretty" : "Raw"}</button>
          )}
          <span className="grow" />
          {resp ? (
            <span className="res-meta">
              <span className={`res-status st-${Math.floor(resp.status / 100)}`}>{resp.status} {resp.statusText}</span>
              <span className="muted small">{resp.timeMs} ms · {fmtSize(resp.bodyBytes)}</span>
            </span>
          ) : (
            <span className="muted small">{sending ? tr("Sending…", "Đang gửi…") : tr("Not sent", "Chưa gửi")}</span>
          )}
        </div>
        {!resp ? (
          <div className="empty">{sending ? tr("⏳ Waiting for response…", "⏳ Đang chờ phản hồi…") : tr("Click Send to send the request", "Bấm Send để gửi request")}</div>
        ) : resTab === "Body" ? (
          <>
            {resp.truncated && <div className="muted small pad">{tr(`⚠ Response too large, showing first ${fmtSize(8 * 1024 * 1024)}.`, `⚠ Phản hồi quá lớn, chỉ hiện ${fmtSize(8 * 1024 * 1024)} đầu.`)}</div>}
            <pre className="res-raw mono">{shownBody || tr("(empty body)", "(thân rỗng)")}</pre>
          </>
        ) : (
          <div className="res-headers mono">
            {resp.headers.map(([k, v], i) => (
              <div key={i} className="res-h"><span className="res-hk">{k}</span><span className="res-hv">{v}</span></div>
            ))}
            {!resp.headers.length && <div className="muted small pad">Không có header</div>}
          </div>
        )}
      </div>
    </div>
  );
}

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
  commands: () => [{ id: "http.new", group: "HTTP", title: t("New request", "Request mới"), hint: "Ctrl+N", run: () => newRequest() }],
};

function HttpEmpty() {
  const tr = useT();
  return (
    <div className="welcome">
      <h1>⚡ HTTP Client</h1>
      <p className="muted">{tr("Send real requests via Rust (no CORS). Paste a curl command into the URL box to turn it into a runnable request.", "Gửi request thật qua Rust (không dính CORS). Dán lệnh curl vào ô URL là tự tách thành request chạy được.")}</p>
      <div className="toolbar">
        <button className="primary" onClick={() => newRequest()}>＋ {tr("New request", "Request mới")}</button>
      </div>
    </div>
  );
}

export default httpApp;
