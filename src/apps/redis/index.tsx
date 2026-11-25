import { Swap } from "../../shell/Swap";
import { renderLog } from "../../shell/renderDebug";
import { copyText } from "../../shell/clipboard";
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Braces, ChevronDown, ChevronRight, ChevronsDown, Copy, Database, Folder, FolderOpen, FolderTree, Info, KeyRound, List, Minimize2, Pencil, Plug, Plus, RefreshCw, Save, Search, Trash2, TriangleAlert, Unplug, WandSparkles, X } from "lucide-react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { AppModule, Tab } from "../types";
import { useWorkbench } from "../../store/workbench";
import { TabbedLayout } from "../../shell/TabbedLayout";
import { Modal } from "../../shell/Modal";
import { Picker } from "../../shell/Picker";
import { Loading } from "../../shell/Loading";
import { confirmDialog } from "../../shell/confirm";
import { listNav, rowKey } from "../../shell/listNav";
import { Splitter, useSplitSize } from "../../shell/Resizable";
import { describe, newConn, sessionPasswords, useConns, type Conn } from "./connections";
import { t, useT } from "../../store/lang";
import { JsonView, parseJsonValue } from "../../shell/JsonView";

interface KeysPage { cursor: number; keys: string[] }
interface KeyDetail {
  key: string;
  kind: string;
  /** -1 = không hết hạn */
  ttl: number;
  size: number;
  columns: string[];
  rows: string[][];
  text: string | null;
}

async function call<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error(t("redis.mustRunInsideTheAppNpm"));
  return invoke<T>(cmd, args);
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const SCAN_COUNT = 500;

async function pickRedisKey(set: (p: string) => void) {
  const f = await openDialog({ multiple: false, title: t("redis.chooseSshPrivateKey") });
  if (typeof f === "string") set(f);
}

/** Mở Redis, nếu bật SSH tunnel thì mở `ssh -L` tới một cổng local rồi nối Redis qua đó.
    Trả về id kết nối + id tunnel (để đóng khi disconnect). */
async function redisConnectMaybeTunnel(conn: Conn, password: string): Promise<{ id: string; tunnelId: string | null }> {
  if (!conn.ssh?.enabled) {
    const id = await call<string>("redis_connect", { cfg: { ...conn, password } });
    return { id, tunnelId: null };
  }
  const s = conn.ssh;
  const localPort = 40000 + Math.floor(Math.random() * 20000);
  const tunnelId = `redis:${conn.id}:${localPort}`;
  await invoke("ssh_tunnel_open", {
    cfg: {
      id: tunnelId, host: s.host, port: s.port || 22, user: s.user, keyPath: s.keyPath,
      kind: "L", localPort, remoteHost: conn.host || "127.0.0.1", remotePort: conn.port || 6379,
    },
  });
  const cfg = { ...conn, host: "127.0.0.1", port: localPort, password };
  // Forward vừa mở có thể chưa sẵn sàng ngay → thử lại vài lần.
  let lastErr: unknown;
  for (let i = 0; i < 6; i++) {
    try {
      const id = await call<string>("redis_connect", { cfg });
      return { id, tunnelId };
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  await invoke("ssh_tunnel_close", { id: tunnelId }).catch(() => {});
  throw lastErr;
}

function openSession(c: Conn) {
  useWorkbench.getState().openTab({
    id: `redis:${c.id}`,
    appId: "redis",
    title: c.name,
    payload: { kind: "session", connId: c.id },
    danger: c.env === "prod",
  });
}

/* ── Cây key gấp theo dấu `:` (như RedisInsight) ── */
interface TreeRow {
  kind: "folder" | "leaf";
  path: string;   // đường dẫn folder, hoặc full key của leaf
  label: string;  // đoạn cuối
  depth: number;
  count: number;  // số key dưới folder
  full?: string;  // full key (leaf)
}
interface TNode { name: string; path: string; full?: string; children: Map<string, TNode>; count: number; sorted?: TNode[] }

/** Dựng cây key một lần cho mỗi danh sách key (mở/đóng folder chỉ đi lại cây, không dựng lại). */
function buildTree(keys: string[], sep = ":"): TNode {
  const root: TNode = { name: "", path: "", children: new Map(), count: 0 };
  for (const key of keys) {
    const parts = key.split(sep);
    let node = root;
    let acc = "";
    for (let i = 0; i < parts.length; i++) {
      acc = i === 0 ? parts[i] : acc + sep + parts[i];
      let child = node.children.get(parts[i]);
      if (!child) { child = { name: parts[i], path: acc, children: new Map(), count: 0 }; node.children.set(parts[i], child); }
      child.count++;
      if (i === parts.length - 1) child.full = key;
      node = child;
    }
  }
  return root;
}

/** Danh sách hàng hiển thị (phẳng, có depth) cho cây key, tôn trọng folder đang mở. */
function treeRows(root: TNode, open: Set<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (n: TNode, depth: number) => {
    // Sắp con một lần rồi cache trên node (cây dựng lại khi danh sách key đổi).
    const entries = n.sorted ??= [...n.children.values()].sort((a, b) => {
      const fa = a.children.size > 0, fb = b.children.size > 0;
      if (fa !== fb) return fa ? -1 : 1; // folder trước
      return a.name.localeCompare(b.name);
    });
    for (const c of entries) {
      if (c.children.size > 0) {
        const isOpen = open.has(c.path);
        rows.push({ kind: "folder", path: c.path, label: c.name, depth, count: c.count, full: c.full });
        if (isOpen) {
          if (c.full) rows.push({ kind: "leaf", path: c.full, label: c.name, depth: depth + 1, count: 1, full: c.full });
          walk(c, depth + 1);
        }
      } else {
        rows.push({ kind: "leaf", path: c.full!, label: c.name, depth, count: 1, full: c.full });
      }
    }
  };
  walk(root, 0);
  return rows;
}

/** Hành động của hàng key — ref ổn định để hàng (memo) không vẽ lại khi Session đổi state
 *  (gõ pattern, sửa giá trị, chọn key…). Chỉ hàng đổi `on`/`isOpen` mới vẽ lại. */
interface KeyRowApi { toggle: (path: string) => void; open: (key: string) => void; remove: (key: string) => void }

const TreeKeyRow = memo(function TreeKeyRow({ row, isOpen, on, api }: { row: TreeRow; isOpen: boolean; on: boolean; api: { current: KeyRowApi } }) {
  renderLog("TreeKeyRow");
  const folder = row.kind === "folder";
  return (
    <div
      className={`rkey ${folder ? "rkey-folder" : ""} ${on ? "on" : ""}`}
      style={{ paddingLeft: 8 + row.depth * 14 }}
      tabIndex={0}
      data-key={folder ? undefined : row.full}
      onClick={() => (folder ? api.current.toggle(row.path) : api.current.open(row.full!))}
      onKeyDown={(e) => rowKey(e, folder ? {
        Enter: () => api.current.toggle(row.path),
        " ": () => api.current.toggle(row.path),
        ArrowLeft: () => { if (isOpen) api.current.toggle(row.path); },
        ArrowRight: () => { if (!isOpen) api.current.toggle(row.path); },
      } : {
        Enter: () => api.current.open(row.full!),
        Delete: () => api.current.remove(row.full!),
      })}
      title={row.kind === "leaf" ? row.full : `${row.path} (${row.count})`}
    >
      {row.kind === "folder" ? (
        <>
          <span className="rkey-caret">{isOpen ? <><ChevronDown /><FolderOpen /></> : <><ChevronRight /><Folder /></>}</span>
          <span className="ellipsis grow">{row.label}</span>
          <span className="muted small rkey-count">{row.count}</span>
        </>
      ) : (
        <span className="mono ellipsis grow">{row.label}</span>
      )}
    </div>
  );
}, (a, b) => {
  // treeRows tạo object hàng mới mỗi lần đi cây → so theo nội dung.
  const x = a.row, y = b.row;
  return a.isOpen === b.isOpen && a.on === b.on && a.api === b.api &&
    x.kind === y.kind && x.path === y.path && x.label === y.label && x.depth === y.depth && x.count === y.count && x.full === y.full;
});

const FlatKeyRow = memo(function FlatKeyRow({ k, on, api }: { k: string; on: boolean; api: { current: KeyRowApi } }) {
  renderLog("FlatKeyRow");
  return (
    <div
      className={`rkey ${on ? "on" : ""}`}
      tabIndex={0}
      data-key={k}
      onClick={() => api.current.open(k)}
      onKeyDown={(e) => rowKey(e, { Enter: () => api.current.open(k), Delete: () => api.current.remove(k) })}
      title={k}
    >
      <span className="mono ellipsis grow">{k}</span>
    </div>
  );
});

/** Bảng giá trị hash/list/set/zset/stream — memo: chỉ vẽ lại khi đổi key (không theo từng phím gõ ở Session). */
const DetailGrid = memo(function DetailGrid({ columns, rows }: { columns: string[]; rows: string[][] }) {
  renderLog("DetailGrid");
  return (
    <div className="grid-wrap">
      <table className="grid mono">
        <thead><tr>{columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{r.map((v, j) => <td key={j} title={v.length > 60 ? v : undefined}>{v}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});

/* Form kết nối mở dạng MODAL (như app DB) — dùng store nhỏ để mở từ bất cứ đâu. */
let formReq: { connId?: string; seq: number } | null = null;
let formSeq = 0;
const formSubs = new Set<() => void>();
function openForm(connId?: string) {
  formReq = { connId, seq: ++formSeq };
  formSubs.forEach((f) => f());
}
function closeForm() {
  formReq = null;
  formSubs.forEach((f) => f());
}
const subForm = (cb: () => void) => { formSubs.add(cb); return () => { formSubs.delete(cb); }; };
const snapForm = () => formReq;
function useFormReq() {
  return useSyncExternalStore(subForm, snapForm);
}

/* ── Sidebar ───────────────────────────────────── */

function Sidebar() {
  renderLog("Sidebar");
  const tr = useT();
  const conns = useConns((s) => s.conns);
  const [sel, setSel] = useState<string | null>(null);
  return (
    <div className="side-list" onKeyDown={(e) => { listNav(e, { row: ".side-item", select: true }); }}>
      <div className="side-head">
        <span>{tr("redis.redisConnections")}</span>
        <button className="icon-btn" title={tr("redis.newConnection")} onClick={() => openForm()}><Plus /></button>
      </div>
      {conns.map((c) => (
        <div
          key={c.id}
          className={`side-item ${c.env === "prod" ? "prod" : ""} ${sel === c.id ? "sel" : ""}`}
          tabIndex={0}
          onClick={() => setSel(c.id)}
          onDoubleClick={() => openSession(c)}
          onKeyDown={(e) => rowKey(e, { Enter: () => openSession(c) })}
          title={`${tr("redis.doubleClickToOpen")} · ${describe(c)}`}
        >
          <span className="grow ellipsis">{c.name}</span>
          <span className={`env-tag ${c.env}`}>{c.env.toUpperCase()}</span>
          <span className="muted small">{c.port}</span>
          <button className="icon-btn small" title={tr("redis.edit")} onClick={(e) => { e.stopPropagation(); openForm(c.id); }}><Pencil /></button>
        </div>
      ))}
      {!conns.length && <div className="muted small pad">{tr("redis.noConnectionsYetClickToAdd")}</div>}
    </div>
  );
}

/* ── Form kết nối ──────────────────────────────── */

function ConnForm({ connId, onClose }: { connId?: string; onClose: () => void }) {
  const tr = useT();
  const { conns, save, remove } = useConns();
  const editing = conns.find((c) => c.id === connId);
  const [c, setC] = useState<Conn>(editing ?? newConn());
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const set = (patch: Partial<Conn>) => setC((x) => ({ ...x, ...patch }));

  const test = async () => {
    setStatus({ ok: true, text: c.ssh?.enabled ? tr("redis.openingSshTunnelTesting") : tr("redis.testingConnection") });
    try {
      const { id, tunnelId } = await redisConnectMaybeTunnel(c, password);
      const info = await call<string>("redis_info", { id, section: "server" });
      await call("redis_disconnect", { id });
      if (tunnelId) await invoke("ssh_tunnel_close", { id: tunnelId }).catch(() => {});
      const ver = /redis_version:(\S+)/.exec(info)?.[1];
      setStatus({ ok: true, text: `${tr("redis.connectedSuccessfully")}${ver ? ` — Redis ${ver}` : ""}` });
    } catch (e) {
      setStatus({ ok: false, text: errText(e) });
    }
  };
  const submit = () => {
    if (!c.name.trim()) return setStatus({ ok: false, text: tr("redis.enterAConnectionName") });
    save({ ...c, name: c.name.trim() });
    if (password) sessionPasswords.set(c.id, password);
    // Lưu mật khẩu NGAY lúc tạo: tick → keyring (lần sau tự nối); bỏ tick → xoá (lần sau mở modal hỏi).
    if (c.savePw) { if (password) void call("redis_save_password", { id: c.id, password }).catch(() => {}); }
    else void call("redis_forget_password", { id: c.id }).catch(() => {});
    onClose();
    openSession(c);
  };

  return (
    <Modal title={editing ? <><Pencil /> {tr("redis.editRedisConnection")}</> : <><Plus /> {tr("redis.newRedisConnection")}</>} width={560} onClose={onClose}>
      <div className="form account-form">
        <label>{tr("redis.name")}<input value={c.name} onChange={(e) => set({ name: e.target.value })} placeholder="vd. Cache HRM staging" autoFocus /></label>
        <div className="form-row">
          <label className="grow">Host<input className="mono" value={c.host} onChange={(e) => set({ host: e.target.value })} /></label>
          <label style={{ width: 100 }}>Port<input type="number" value={c.port} onChange={(e) => set({ port: Number(e.target.value) || 6379 })} /></label>
        </div>
        <div className="form-row">
          <label className="grow">{tr("redis.password")}
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <label style={{ width: 120 }}>Database
            <input type="number" min={0} value={c.db} onChange={(e) => set({ db: Math.max(0, Number(e.target.value) || 0) })} />
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={c.tls} onChange={(e) => set({ tls: e.target.checked })} />
          {tr("redis.useTlsRediss")}
        </label>
        <label className="check">
          <input type="checkbox" checked={c.savePw !== false} onChange={(e) => set({ savePw: e.target.checked })} />
          {tr("redis.savePassword")}
        </label>
        <div className="field">
          <span className="field-cap">{tr("redis.environment")}</span>
          <div className="picker-field">
            <Picker
              label={<span className="ellipsis">{c.env}</span>}
              items={[
                { id: "dev", label: "dev", selected: c.env === "dev" },
                { id: "staging", label: "staging", selected: c.env === "staging" },
                { id: "prod", label: tr("redis.prodRedBorderConfirmBeforeDelete"), selected: c.env === "prod" },
              ]}
              onPick={(id) => set({ env: id as Conn["env"] })}
            />
          </div>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={!!c.ssh?.enabled}
            onChange={(e) => set({ ssh: { host: "", port: 22, user: "", keyPath: "", ...c.ssh, enabled: e.target.checked } })}
          /> {tr("redis.connectViaSshTunnel")}
        </label>
        {c.ssh?.enabled && (
          <div className="ssh-fields">
            <div className="form-row">
              <label className="grow">SSH Host<input className="mono" value={c.ssh.host} onChange={(e) => set({ ssh: { ...c.ssh!, host: e.target.value } })} placeholder="jump.example.com" /></label>
              <label style={{ width: 90 }}>Port<input className="mono" type="number" value={c.ssh.port} onChange={(e) => set({ ssh: { ...c.ssh!, port: Number(e.target.value) || 22 } })} /></label>
              <label className="grow">SSH User<input value={c.ssh.user} onChange={(e) => set({ ssh: { ...c.ssh!, user: e.target.value } })} placeholder="ubuntu" /></label>
            </div>
            <label>{tr("redis.privateKeyBatchmodeNeedsKeyAgent")}
              <div className="form-row">
                <input className="grow mono" value={c.ssh.keyPath} onChange={(e) => set({ ssh: { ...c.ssh!, keyPath: e.target.value } })} placeholder={tr("redis.emptyDefaultKeySshAgent")} />
                <button onClick={() => void pickRedisKey((p) => set({ ssh: { ...c.ssh!, keyPath: p } }))}><FolderOpen />{tr("redis.browse")}</button>
              </div>
            </label>
            <div className="muted small">{tr("redis.redisConnects127001")} <span className="mono">{c.host || "host"}:{c.port || 6379}</span> {tr("redis.viaTheSshServerAbove")}</div>
          </div>
        )}
        <div className="toolbar">
          <button onClick={test}><Plug />{tr("redis.testConnection")}</button>
          <span className="grow" />
          {editing && <button className="danger" onClick={() => void confirmDialog({ message: tr("redis.deleteConnectionNamed", { name: c.name || tr("redis.thisFallback") }) }).then((ok) => { if (!ok) return; remove(c.id); onClose(); })}><Trash2 />{tr("redis.delete")}</button>}
          <button className="primary" onClick={submit}><Save />{tr("redis.saveOpen")}</button>
        </div>
        {status && <div className={status.ok ? "muted" : "error-box"}>{status.text}</div>}
      </div>
    </Modal>
  );
}

/** Render modal form từ store (mở được cả khi không ở sidebar). */
function ConnFormHost() {
  const req = useFormReq();
  if (!req) return null;
  return <ConnForm key={req.seq} connId={req.connId} onClose={closeForm} />;
}

/* ── Phiên làm việc ────────────────────────────── */

function fmtTtl(ttl: number) {
  if (ttl === -1) return t("redis.noExpiry");
  if (ttl < 0) return "—";
  const d = Math.floor(ttl / 86400), h = Math.floor((ttl % 86400) / 3600), m = Math.floor((ttl % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${ttl % 60}s`;
  return `${ttl}s`;
}

const KIND_COLOR: Record<string, string> = {
  string: "var(--ok)", hash: "var(--accent)", list: "var(--warn)",
  set: "var(--k-set)", zset: "var(--k-zset)", stream: "var(--k-stream)", none: "var(--muted)",
};

/** Vỏ ngoài: kết nối bị xoá khi tab đang mở → gỡ hẳn phần thân (cleanup ngắt kết nối vẫn chạy) thay vì
 *  return sớm giữa chừng các hook (đổi thứ tự hook → React lỗi). */
function Session({ tab }: { tab: Tab }) {
  const exists = useConns((s) => s.conns.some((c) => c.id === tab.payload.connId));
  const tr = useT();
  if (!exists) return <div className="empty">{tr("redis.thisConnectionWasDeleted")}</div>;
  return <SessionBody tab={tab} />;
}

function SessionBody({ tab }: { tab: Tab }) {
  renderLog("SessionBody");
  const tr = useT();
  const conn = useConns((s) => s.conns.find((c) => c.id === tab.payload.connId));
  const log = useWorkbench((s) => s.log);
  const [dbId, setDbId] = useState<string | null>(null);
  const dbIdRef = useRef<string | null>(null);
  const tunnelIdRef = useRef<string | null>(null);
  const [password, setPassword] = useState(sessionPasswords.get(String(tab.payload.connId)) ?? "");
  const [remember, setRemember] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [needPw, setNeedPw] = useState(false);
  /** Không có phiên: vừa bấm Ngắt hoặc nối lỗi (không phải lỗi mật khẩu). Khác với lúc đang tự nối khi mở tab. */
  const [offline, setOffline] = useState(false);
  const autoTried = useRef(false);
  const [error, setError] = useState("");

  const [dbs, setDbs] = useState<number[]>([]);
  const [db, setDb] = useState(conn?.db ?? 0);
  const [dbsize, setDbsize] = useState<number | null>(null);

  const [pattern, setPattern] = useState("*");
  const [keys, setKeys] = useState<string[]>([]);
  const [cursor, setCursor] = useState(0);
  const [loadingKeys, setLoadingKeys] = useState(false);

  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<KeyDetail | null>(null);
  const [loadingKey, setLoadingKey] = useState(false);
  const [editValue, setEditValue] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  /** Bề rộng cột key — kéo được, nhớ lại. */
  const [keysW, setKeysW] = useSplitSize("redis.keys", 300, 180, 600);
  /** Hiển thị key dạng cây (gấp theo `:`) hay danh sách phẳng. */
  const [treeView, setTreeView] = useState(() => localStorage.getItem("redis.treeView") !== "0");
  const [openFolders, setOpenFolders] = useState<Set<string>>(new Set());
  const toggleFolder = (p: string) => setOpenFolders((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; });
  // Cây dựng lại chỉ khi danh sách key đổi; hàng hiển thị chỉ tính lại khi mở/đóng folder (không theo mỗi phím gõ).
  const keyTree = useMemo(() => (treeView ? buildTree(keys) : null), [keys, treeView]);
  const rows = useMemo(() => (keyTree ? treeRows(keyTree, openFolders) : []), [keyTree, openFolders]);
  const keyRowApi = useRef<KeyRowApi>(null as unknown as KeyRowApi);
  /** Lượt mở key mới nhất — ↑/↓ mở key liên tục, bỏ kết quả về muộn của key cũ. */
  const openSeq = useRef(0);

  useEffect(() => () => {
    if (dbIdRef.current) void call("redis_disconnect", { id: dbIdRef.current }).catch(() => {});
    if (tunnelIdRef.current) void invoke("ssh_tunnel_close", { id: tunnelIdRef.current }).catch(() => {});
  }, []);

  if (!conn) return <div className="empty">{tr("redis.thisConnectionWasDeleted")}</div>;

  const loadKeys = useCallback(async (id: string, pat: string, from = 0) => {
    setLoadingKeys(true);
    try {
      const page = await call<KeysPage>("redis_scan", { id, cursor: from, pattern: pat, count: SCAN_COUNT });
      setKeys((prev) => (from === 0 ? page.keys : [...prev, ...page.keys]));
      setCursor(page.cursor);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoadingKeys(false);
    }
  }, []);

  const connect = async (pw: string = password) => {
    setConnecting(true);
    setOffline(false);
    setError("");
    try {
      const { id, tunnelId } = await redisConnectMaybeTunnel(conn, pw);
      dbIdRef.current = id;
      tunnelIdRef.current = tunnelId;
      setDbId(id);
      if (pw) sessionPasswords.set(conn.id, pw);
      // Lưu/xoá mật khẩu theo tick "Lưu mật khẩu" (khi nối từ modal nhập).
      if (remember && pw) void call("redis_save_password", { id: conn.id, password: pw }).catch(() => {});
      else if (!remember) void call("redis_forget_password", { id: conn.id }).catch(() => {});
      const [count, size] = await Promise.all([
        call<number>("redis_databases", { id }),
        call<number>("redis_dbsize", { id }),
      ]);
      setDbs(Array.from({ length: count }, (_, i) => i));
      setDbsize(size);
      log(t("redis.logConnected", { name: conn.name, desc: describe(conn) }));
      await loadKeys(id, "*");
    } catch (e) {
      const msg = errText(e);
      setError(msg);
      // Chỉ lỗi xác thực mới hỏi mật khẩu; lỗi mạng / tunnel / sai host → màn "chưa kết nối" có Thử lại + Sửa cấu hình
      // (trước đây mọi lỗi đều bật modal mật khẩu → tưởng nhầm là sai mật khẩu).
      if (/NOAUTH|WRONGPASS|invalid (username-)?password|auth(entication)? (required|failed)|requires? (a )?password/i.test(msg)) setNeedPw(true);
      else setOffline(true);
    } finally {
      setConnecting(false);
    }
  };

  // Tự kết nối khi mở: có mật khẩu lưu (RAM/keyring) hoặc đã chọn "Lưu mật khẩu" (kể cả không mật khẩu) → khỏi hỏi.
  useEffect(() => {
    if (autoTried.current || dbIdRef.current) return;
    autoTried.current = true;
    void (async () => {
      const ram = sessionPasswords.get(conn.id);
      if (ram !== undefined) { setPassword(ram); return void connect(ram); }
      const saved = await call<string | null>("redis_get_password", { id: conn.id }).catch(() => null);
      if (saved != null) { setPassword(saved); sessionPasswords.set(conn.id, saved); return void connect(saved); }
      // Mặc định (chưa bỏ tick "Lưu mật khẩu") → tự nối với mật khẩu rỗng, kể cả Redis không có mật khẩu.
      if (conn.savePw !== false) return void connect("");
      setNeedPw(true); // ĐÃ bỏ tick lưu → mở modal nhập mật khẩu
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const switchDb = async (n: number) => {
    if (!dbId) return;
    setDb(n);
    setSelected(null); setDetail(null); setInfo(null); setKeys([]); setCursor(0);
    try {
      setDbsize(await call<number>("redis_select", { id: dbId, db: n }));
      await loadKeys(dbId, pattern);
    } catch (e) {
      setError(errText(e));
    }
  };

  const openKey = async (k: string) => {
    if (!dbId) return;
    const my = ++openSeq.current;
    setSelected(k);
    setEditValue(null);
    setInfo(null);
    setLoadingKey(true);
    setError("");
    try {
      const d = await call<KeyDetail>("redis_key", { id: dbId, key: k });
      if (my === openSeq.current) setDetail(d);
    } catch (e) {
      if (my !== openSeq.current) return;
      setDetail(null);
      setError(errText(e));
    } finally {
      if (my === openSeq.current) setLoadingKey(false);
    }
  };

  const del = async (key: string | null = selected) => {
    if (!dbId || !key) return;
    try {
      const n = await call<number>("redis_del", { id: dbId, keys: [key] });
      log(t("redis.logDeleted", { selected: key, n }));
      setKeys((ks) => ks.filter((k) => k !== key));
      if (key === selected) { setSelected(null); setDetail(null); }
      setDbsize((s) => (s === null ? s : Math.max(0, s - n)));
    } catch (e) {
      setError(errText(e));
    }
  };

  const isProdConn = conn.env === "prod";
  /** Hỏi rồi xoá key (cùng câu hỏi với nút xoá ở khung giá trị) — dùng cho phím Delete trên danh sách key. */
  const confirmDel = (key: string) => void confirmDialog({
    message: (isProdConn ? tr("redis.thisIsAProdConnection") : "") + tr("redis.permanentlyDeleteKey") + " " + key + "?",
    confirmLabel: tr("redis.deleteKey"),
  }).then((ok) => ok && void del(key));

  keyRowApi.current = { toggle: toggleFolder, open: (k) => void openKey(k), remove: confirmDel };

  /** Giá trị string là JSON → hiện đẹp (nhớ lựa chọn Pretty/Raw). */
  const [pretty, setPretty] = useState(() => localStorage.getItem("redis.prettyJson") !== "0");
  const togglePretty = () => setPretty((v) => { localStorage.setItem("redis.prettyJson", v ? "0" : "1"); return !v; });
  const json = useMemo(() => (detail?.kind === "string" ? parseJsonValue(detail.text) : undefined), [detail]);
  const isJson = json !== undefined;
  /** Bản gốc lưu dạng gọn (một dòng) → khi lưu thu gọn lại, không đổi định dạng dữ liệu vì đã sửa ở dạng đẹp. */
  const compactJson = isJson && !(detail?.text ?? "").includes("\n");
  const editJson = editValue !== null ? parseJsonValue(editValue) : undefined;
  const startEdit = () => setEditValue(isJson && pretty ? JSON.stringify(json, null, 2) : detail?.text ?? "");

  const saveValue = async () => {
    if (!dbId || !detail || editValue === null) return;
    const parsed = compactJson ? parseJsonValue(editValue) : undefined;
    const value = parsed !== undefined ? JSON.stringify(parsed) : editValue;
    try {
      await call("redis_set_string", { id: dbId, key: detail.key, value });
      setDetail({ ...detail, text: value, size: new Blob([value]).size });
      setEditValue(null);
      log(t("redis.logSaved", { key: detail.key }));
    } catch (e) {
      setError(errText(e));
    }
  };

  const showInfo = async () => {
    if (!dbId) return;
    if (info !== null) return setInfo(null);
    try {
      setInfo(await call<string>("redis_info", { id: dbId }));
      setSelected(null); setDetail(null);
    } catch (e) {
      setError(errText(e));
    }
  };

  if (!dbId) {
    const connectingScreen = (
      <div className="view">
        <Loading label={<><div>{tr("redis.connectingTo")} <b>{conn.name}</b>…</div><div className="muted small">Redis · {describe(conn)}</div></>} />
      </div>
    );
    if (!connecting && !needPw && offline) return (
      <div className="view">
        <div className="empty redis-offline">
          <Unplug />
          <div><b>{conn.name}</b> — {tr("redis.notConnected")}</div>
          <div className="muted small">Redis · {describe(conn)}</div>
          {error && <div className="error-box pre"><TriangleAlert /> {error}</div>}
          <div className="toolbar">
            <button onClick={() => openForm(conn.id)}><Pencil />{tr("redis.editConfig")}</button>
            <button className="primary" autoFocus onClick={() => void connect()}><Plug />{tr("redis.connect")}</button>
          </div>
        </div>
      </div>
    );
    if (connecting || !needPw) return connectingScreen;
    return (
      <>
        {connectingScreen}
        <Modal title={<><KeyRound /> {tr("redis.enterPassword")}</>} width={480} onClose={() => useWorkbench.getState().closeTab(tab.id)}>
          <div className="form account-form">
            <div className="muted small">{conn.name} — Redis · {describe(conn)}</div>
            <label>{tr("redis.password")}
              <input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !connecting) void connect(); }} placeholder={tr("redis.leaveEmptyIfNotNeeded")} />
            </label>
            <label className="check">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              {tr("redis.savePassword")}
            </label>
            {error && <div className="error-box"><TriangleAlert /> {error}</div>}
            <div className="toolbar">
              <button onClick={() => openForm(conn.id)}><Pencil />{tr("redis.editConfig")}</button>
              <span className="grow" />
              <button onClick={() => useWorkbench.getState().closeTab(tab.id)}><X />{tr("redis.cancel")}</button>
              <button className="primary" disabled={connecting} onClick={() => connect()}><Plug /><Swap on={connecting} a={tr("redis.connecting")} b={tr("redis.connect")} /></button>
            </div>
          </div>
        </Modal>
      </>
    );
  }

  const kind = detail?.kind ?? "";
  const isProd = conn.env === "prod";

  return (
    <div className="view">
      <div className="toolbar">
        <Picker
          title={tr("redis.pickDatabase")}
          label={<span className="ellipsis">db{db}</span>}
          items={dbs.map((n) => ({ id: String(n), label: `db${n}`, selected: n === db }))}
          onPick={(id) => void switchDb(Number(id))}
        />
        <span className="muted small">{dbsize ?? "…"} {tr("redis.keys")}</span>
        <input
          className="grow mono"
          value={pattern}
          placeholder={tr("redis.keyPatternEGUserEnter")}
          onChange={(e) => setPattern(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { setKeys([]); setCursor(0); void loadKeys(dbId, pattern); } }}
        />
        <button disabled={loadingKeys} onClick={() => { setKeys([]); setCursor(0); void loadKeys(dbId, pattern); }}><RefreshCw /> {tr("redis.search")}</button>
        <button onClick={() => void showInfo()} className={info !== null ? "primary" : ""}><Info />INFO</button>
        <button onClick={() => {
          if (dbIdRef.current) void call("redis_disconnect", { id: dbIdRef.current }).catch(() => {});
          if (tunnelIdRef.current) void invoke("ssh_tunnel_close", { id: tunnelIdRef.current }).catch(() => {});
          dbIdRef.current = null; tunnelIdRef.current = null; setDbId(null); setDetail(null); setKeys([]);
          setError(""); setOffline(true);
        }}><Unplug />{tr("redis.disconnect")}</button>
      </div>

      {error && <div className="error-box pre"><TriangleAlert /> {error}</div>}

      <div className="split">
        <div className="pane rkeys" style={{ width: keysW, flex: "0 0 auto" }}>
          <div className="pane-title">
            <span className="grow">{tr("redis.keys2")} ({keys.length}{loadingKeys ? "…" : ""})</span>
            <button
              className={`icon-btn ${treeView ? "on" : ""}`}
              title={treeView ? tr("redis.treeViewFoldByClickFor") : tr("redis.flatListClickForTree")}
              onClick={() => { const v = !treeView; setTreeView(v); localStorage.setItem("redis.treeView", v ? "1" : "0"); }}
            >{treeView ? <FolderTree /> : <List />}</button>
          </div>
          <div
            className="rkey-list"
            onKeyDown={(e) => {
              // ↑/↓ chỉ chuyển focus; tới key (không phải folder) thì mở key đó — không bật/tắt folder khi đi qua.
              const before = document.activeElement;
              if (!listNav(e, { row: ".rkey" }) || document.activeElement === before) return;
              const k = (document.activeElement as HTMLElement | null)?.dataset.key;
              if (k) keyRowApi.current.open(k);
            }}
          >
            {treeView
              ? rows.map((row) => (
                  <TreeKeyRow
                    key={`${row.kind}:${row.path}`}
                    row={row}
                    isOpen={row.kind === "folder" && openFolders.has(row.path)}
                    on={row.kind === "leaf" && row.full === selected}
                    api={keyRowApi}
                  />
                ))
              : keys.map((k) => <FlatKeyRow key={k} k={k} on={k === selected} api={keyRowApi} />)}
            {loadingKeys && <Loading variant={keys.length ? "row" : "center"} />}
            {!keys.length && !loadingKeys && (
              <div className="muted small pad rkey-empty">
                <div>{tr("redis.noKeysMatchPattern", { pattern })}</div>
                <div className="rkey-empty-hint">{tr("redis.noKeysHint")} <span className="muted">(db{db} · {dbsize ?? "…"} {tr("redis.keys")})</span></div>
                {pattern.trim() !== "*" && (
                  <button className="rkey-empty-btn" onClick={() => { setPattern("*"); setKeys([]); setCursor(0); void loadKeys(dbId, "*"); }}>
                    <Search />{tr("redis.showAllKeys")}
                  </button>
                )}
              </div>
            )}
            {!loadingKeys && cursor !== 0 && (
              <button className="rkey-more" onClick={() => void loadKeys(dbId, pattern, cursor)}><ChevronsDown />{tr("redis.loadMore")}</button>
            )}
          </div>
        </div>
        <Splitter axis="x" live="prev" min={180} max={600} onResize={(d) => setKeysW((w) => w + d)} onReset={() => setKeysW(300)} />

        <div className="pane">
          <div className="pane-title ellipsis">
            {info !== null ? "INFO" : detail ? (
              <>
                <span className="mono">{detail.key}</span>
                <span className="kind-badge" style={{ color: KIND_COLOR[kind] ?? undefined, borderColor: KIND_COLOR[kind] ?? undefined }}>{kind}</span>
                <span className="muted small">TTL {fmtTtl(detail.ttl)} · {detail.size} {tr("redis.elements")}</span>
                <span className="grow" />
                <button className="icon-btn" title={tr("redis.reload")} onClick={() => void openKey(detail.key)}><RefreshCw /></button>
                <button className="icon-btn" title={tr("redis.copyKeyName")} onClick={() => void copyText(detail.key)}><Copy /></button>
                <button className="icon-btn danger" title={tr("redis.deleteKey")} onClick={() => void confirmDialog({ message: (isProd ? tr("redis.thisIsAProdConnection") : "") + tr("redis.permanentlyDeleteKey") + " " + detail.key + "?", confirmLabel: tr("redis.deleteKey") }).then((ok) => ok && void del())}><Trash2 /></button>
              </>
            ) : tr("redis.value")}
          </div>

          {info !== null ? (
            <pre className="io mono rinfo">{info}</pre>
          ) : loadingKey ? (
            <Loading label={tr("redis.reading")} />
          ) : !detail ? (
            <div className="empty">{tr("redis.pickAKeyOnTheLeft")}</div>
          ) : detail.kind === "string" ? (
            <div className="rstring">
              <div className="toolbar">
                {editValue === null ? (
                  <>
                    <button onClick={startEdit}><Pencil />{tr("redis.editValue")}</button>
                    {isJson && <button onClick={togglePretty} title={tr("redis.prettyJsonHint")}><Braces /><Swap on={pretty} a={tr("redis.showRaw")} b={tr("redis.prettyJson")} /></button>}
                    <button onClick={() => void copyText(isJson && pretty ? JSON.stringify(json, null, 2) : detail.text ?? "")}><Copy />{tr("redis.copyValue")}</button>
                    {isJson && <span className="badge rjson-badge">JSON</span>}
                  </>
                ) : (
                  <>
                    <button className="primary" onClick={() => void saveValue()}><Save />{tr("redis.saveSetKeepTtl")}</button>
                    <button onClick={() => setEditValue(null)}><X />{tr("redis.cancel")}</button>
                    {editJson !== undefined && <button onClick={() => setEditValue(JSON.stringify(editJson, null, 2))}><WandSparkles />{tr("redis.formatJson")}</button>}
                    {editJson !== undefined && <button onClick={() => setEditValue(JSON.stringify(editJson))}><Minimize2 />{tr("redis.minifyJson")}</button>}
                    {isJson && editJson === undefined && <span className="small rjson-bad"><TriangleAlert /> {tr("redis.invalidJson")}</span>}
                    {compactJson && editJson !== undefined && <span className="muted small">{tr("redis.savedCompactHint")}</span>}
                    {isProd && <span className="muted small">{tr("redis.prodConnectionDoubleCheckBeforeSaving")}</span>}
                  </>
                )}
              </div>
              {editValue === null && isJson && pretty ? (
                <JsonView value={json} className="io" />
              ) : (
                <textarea
                  className="io mono"
                  readOnly={editValue === null}
                  value={editValue ?? detail.text ?? ""}
                  onChange={(e) => setEditValue(e.target.value)}
                  spellCheck={false}
                />
              )}
            </div>
          ) : detail.rows.length ? (
            <DetailGrid columns={detail.columns} rows={detail.rows} />
          ) : detail.text ? (
            <pre className="io mono">{detail.text}</pre>
          ) : (
            <div className="empty">{tr("redis.noData")}</div>
          )}
        </div>
      </div>
    </div>
  );
}

function TabView({ tab }: { tab: Tab }) {
  return <Session tab={tab} />;
}

const redisApp: AppModule = {
  View: () => (
    <>
      <TabbedLayout
        appId="redis"
        Sidebar={Sidebar}
        TabView={TabView}
        empty={
          <div className="welcome">
            <h1><Database /> Redis</h1>
            <p className="muted">{t("redis.browseKeysViewValuesDeleteKeys")}</p>
            <button className="primary" onClick={() => openForm()}><Plus /> {t("redis.newConnection")}</button>
          </div>
        }
      />
      <ConnFormHost />
    </>
  ),
  commands: () => [
    { id: "redis.new", group: "Redis", title: t("redis.newRedisConnection2"), run: () => openForm() },
    ...useConns.getState().conns.map((c) => ({
      id: `redis.open.${c.id}`,
      group: "Redis",
      title: `${t("redis.openRedisConnection")} ${c.name}`,
      run: () => openSession(c),
    })),
  ],
};

export default redisApp;
