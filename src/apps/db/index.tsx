import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { AppModule, Tab } from "../types";
import { useWorkbench } from "../../store/workbench";
import { TabbedLayout } from "../../shell/TabbedLayout";
import { Picker } from "../../shell/Picker";
import { DbIcon, TableIcon } from "../../shell/icons";
import { ContextMenu, type CtxItem } from "../../shell/ContextMenu";
import { Modal } from "../../shell/Modal";
import { confirmDialog } from "../../shell/confirm";
import { Splitter, useSplitSize } from "../../shell/Resizable";
import { DRIVERS, describe, newConn, sessionPasswords, useConns, type Conn, type Driver } from "./connections";
import { addDbFolder, removeDbFolder, renameDbFolder, toggleDbFolder, useDbFolders } from "./folders";
import { removeQuery, renameQuery, saveQuery, useSavedQueries } from "./queries";
import { assembleSync, planMysqlSync, type SyncItem, type SyncKind, type SyncPlan, type SyncTable } from "./mysqlSync";
import { buildUpdates, countSql, isPageable, pagedSql, parseSourceTable, quoteIdent, stripSql, type GridDriver, type GridEdits } from "./gridEdit";
import { t, useT } from "../../store/lang";
import { lazy, Suspense } from "react";
// Sơ đồ ER tải lười (chỉ khi mở) để không làm nặng chunk app DB.
const ErDiagram = lazy(() => import("./ErDiagram").then((m) => ({ default: m.ErDiagram })));

async function pickDbKey(set: (p: string) => void) {
  const f = await openDialog({ multiple: false, title: t("db.chooseSshPrivateKey") });
  if (typeof f === "string") set(f);
}

/** Mở kết nối DB, nếu bật SSH tunnel thì mở `ssh -L` tới một cổng local rồi nối DB qua đó.
    Trả về id kết nối DB + id tunnel (để đóng khi disconnect). */
async function dbConnectMaybeTunnel(conn: Conn, password: string): Promise<{ id: string; tunnelId: string | null }> {
  const useTunnel = !!conn.ssh?.enabled && conn.driver !== "sqlite";
  if (!useTunnel) {
    const id = await call<string>("db_connect", { cfg: { ...conn, password } });
    return { id, tunnelId: null };
  }
  const s = conn.ssh!;
  const localPort = 40000 + Math.floor(Math.random() * 20000);
  const tunnelId = `db:${conn.id}:${localPort}`;
  await invoke("ssh_tunnel_open", {
    cfg: {
      id: tunnelId, host: s.host, port: s.port || 22, user: s.user, keyPath: s.keyPath,
      kind: "L", localPort, remoteHost: conn.host || "127.0.0.1", remotePort: conn.port ?? DRIVERS[conn.driver].port ?? 5432,
    },
  });
  const cfg = { ...conn, host: "127.0.0.1", port: localPort, password };
  // Forward vừa mở có thể chưa sẵn sàng ngay → thử lại vài lần trước khi bỏ cuộc.
  let lastErr: unknown;
  for (let i = 0; i < 6; i++) {
    try {
      const id = await call<string>("db_connect", { cfg });
      return { id, tunnelId };
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  await invoke("ssh_tunnel_close", { id: tunnelId }).catch(() => {});
  throw lastErr;
}

interface QueryOut {
  columns: string[];
  rows: (string | null)[][];
  rowsAffected: number;
  elapsedMs: number;
  truncated: boolean;
  /** Câu lệnh đã sinh ra kết quả này (gắn phía UI) — để sửa dữ liệu trên lưới biết bảng nguồn. */
  sql?: string;
  /** Kết quả phân trang phía server (SELECT không tự có LIMIT): câu gốc, trang (từ 0), cỡ trang, còn trang sau.
   *  Cassandra: `cass.states[k]` = paging state (token driver) để lấy trang k (trang 0 = null). */
  paging?: { base: string; page: number; size: number; hasNext: boolean; cass?: { states: (string | null)[] } };
  /** Cassandra: token để lấy trang kế (backend trả về); null/undefined = hết dữ liệu. */
  pagingState?: string | null;
}

/** Cassandra: gắn thông tin trang từ paging state của driver (chỉ đi tới/lùi theo token đã biết). */
function withCassPaging(out: QueryOut, base: string, page: number, size: number, states: (string | null)[]): QueryOut {
  const ns = states.slice(0, page + 1);
  if (out.pagingState) ns[page + 1] = out.pagingState;
  return { ...out, truncated: false, sql: base, paging: { base, page, size, hasNext: !!out.pagingState && out.rows.length > 0, cass: { states: ns } } };
}

/** Kết quả lấy dư 1 dòng (size+1) → cắt về size + đánh dấu còn trang sau. */
function withPaging(out: QueryOut, base: string, page: number, size: number): QueryOut {
  const hasNext = out.rows.length > size;
  return { ...out, rows: hasNext ? out.rows.slice(0, size) : out.rows, truncated: false, sql: base, paging: { base, page, size, hasNext } };
}
interface TableInfo { schema: string; name: string; kind: string }

/** Routine trong một database: thủ tục / hàm / event (bộ lập lịch MySQL). */
type RoutineKind = "procedure" | "function" | "event";
interface RoutineInfo { db: string; name: string; kind: RoutineKind }
const ROUTINE_ICON: Record<RoutineKind, string> = { procedure: "⚙", function: "ƒ", event: "⏰" };

/** Tách nhiều câu lệnh SQL bằng ';' ở mức ngoài — bỏ qua dấu ';' trong chuỗi '…', "…", `…`,
    comment -- / # / /* … *\/ và chuỗi dollar-quote của Postgres ($$ … $$ / $tag$ … $tag$). */
function splitStatements(text: string): string[] {
  const out: string[] = [];
  let buf = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "-" && next === "-") { const e = text.indexOf("\n", i); const end = e < 0 ? n : e; buf += text.slice(i, end); i = end; continue; }
    if (ch === "#") { const e = text.indexOf("\n", i); const end = e < 0 ? n : e; buf += text.slice(i, end); i = end; continue; }
    if (ch === "/" && next === "*") {
      const e = text.indexOf("*/", i + 2);
      const end = e < 0 ? n : e + 2;
      buf += text.slice(i, end); i = end; continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      let j = i + 1;
      while (j < n) {
        if (text[j] === ch) {
          if (text[j + 1] === ch) { j += 2; continue; } // '' / "" / `` escape
          j++; break;
        }
        if (text[j] === "\\" && ch === "'") { j += 2; continue; } // escape kiểu MySQL
        j++;
      }
      buf += text.slice(i, j); i = j; continue;
    }
    if (ch === "$") {
      // $tag$ … $tag$
      const m = /^\$[A-Za-z0-9_]*\$/.exec(text.slice(i));
      if (m) {
        const tag = m[0];
        const e = text.indexOf(tag, i + tag.length);
        const end = e < 0 ? n : e + tag.length;
        buf += text.slice(i, end); i = end; continue;
      }
    }
    if (ch === ";") { out.push(buf); buf = ""; i++; continue; }
    buf += ch; i++;
  }
  out.push(buf);
  return out.map((s) => s.trim()).filter(Boolean);
}

/* ── Gợi ý khi gõ SQL ─────────────────────────────
   Nguồn: từ khoá SQL + tên database + tên bảng + tên cột (của các db đã mở).
   Gõ "bảng." → chỉ gợi ý cột của bảng đó. */

type Sug = { label: string; kind: "kw" | "db" | "table" | "col"; hint?: string };

/** Tô đậm đoạn khớp (không phân biệt hoa thường) trong nhãn gợi ý. */
function hlMatch(label: string, q: string) {
  const at = q ? label.toLowerCase().indexOf(q) : -1;
  if (at < 0) return label;
  return <>{label.slice(0, at)}<b className="sug-hl">{label.slice(at, at + q.length)}</b>{label.slice(at + q.length)}</>;
}

const SQL_WORDS = [
  "SELECT", "FROM", "WHERE", "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE", "JOIN",
  "LEFT", "RIGHT", "INNER", "OUTER", "ON", "GROUP", "BY", "ORDER", "HAVING", "LIMIT", "OFFSET",
  "AS", "AND", "OR", "NOT", "NULL", "IS", "IN", "LIKE", "BETWEEN", "DISTINCT", "CASE", "WHEN",
  "THEN", "ELSE", "END", "CREATE", "TABLE", "VIEW", "INDEX", "ALTER", "DROP", "PRIMARY", "KEY",
  "FOREIGN", "REFERENCES", "UNION", "ALL", "ASC", "DESC", "EXISTS", "CAST", "COUNT", "SUM", "MIN",
  "MAX", "AVG", "TRUE", "FALSE", "DEFAULT", "IF", "EXPLAIN", "USING", "WITH", "RETURNING",
];

/** Toạ độ con trỏ (viewport) trong textarea, để đặt popup gợi ý. */
function caretXY(ta: HTMLTextAreaElement, pos: number): { x: number; y: number } {
  const cs = getComputedStyle(ta);
  const div = document.createElement("div");
  const props = [
    "boxSizing", "width", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
    "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "tabSize",
  ] as const;
  for (const p of props) div.style[p as never] = cs[p as never];
  div.style.position = "absolute";
  div.style.visibility = "hidden";
  div.style.whiteSpace = "pre-wrap";
  div.style.wordWrap = "break-word";
  div.style.top = "0";
  div.style.left = "0";
  div.style.minHeight = cs.lineHeight;
  div.textContent = ta.value.slice(0, pos);
  const span = document.createElement("span");
  span.textContent = ta.value.slice(pos) || ".";
  div.appendChild(span);
  document.body.appendChild(div);
  const rect = ta.getBoundingClientRect();
  const out = {
    x: rect.left + span.offsetLeft - ta.scrollLeft + parseFloat(cs.fontSize) * 0.2,
    y: rect.top + span.offsetTop - ta.scrollTop + parseFloat(cs.lineHeight || cs.fontSize) + 2,
  };
  document.body.removeChild(div);
  return out;
}

const ROW_LIMIT = 1000;

async function call<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error(t("db.mustRunInsideTheAppNpm"));
  return invoke<T>(cmd, args);
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function openSession(c: Conn) {
  useWorkbench.getState().openTab({
    id: `db:${c.id}`,
    appId: "db",
    title: `🗄 ${c.name}`,
    payload: { kind: "session", connId: c.id },
    danger: c.env === "prod",
  });
}

/* Form cấu hình kết nối mở dạng MODAL (không phải tab). */
let formReq: { connId?: string; folderId?: string } | null = null;
const formSubs = new Set<() => void>();
function openForm(connId?: string, folderId?: string) {
  formReq = { connId, folderId };
  formSubs.forEach((f) => f());
}
function closeForm() {
  formReq = null;
  formSubs.forEach((f) => f());
}
function useFormReq() {
  return useSyncExternalStore((cb) => { formSubs.add(cb); return () => { formSubs.delete(cb); }; }, () => formReq);
}

/* Yêu cầu mở modal "Database mới" trong phiên của một server (dùng khi chuột phải server ở sidebar).
   Mỗi lần bấm tăng một token để phiên đang mở nhận ra yêu cầu mới (kể cả tab đã mở sẵn). */
let newDbReq: { connId: string; token: number } | null = null;
const newDbSubs = new Set<() => void>();
function requestNewDb(connId: string) {
  newDbReq = { connId, token: (newDbReq?.token ?? 0) + 1 };
  newDbSubs.forEach((f) => f());
}
function useNewDbReq() {
  return useSyncExternalStore((cb) => { newDbSubs.add(cb); return () => { newDbSubs.delete(cb); }; }, () => newDbReq);
}

/* ── Sidebar ───────────────────────────────────── */

function Sidebar() {
  const tr = useT();
  const conns = useConns((s) => s.conns);
  const [dragId, setDragId] = useState<string | null>(null);
  /** Kéo-thả sắp lại vị trí: chèn kết nối `dragId` vào trước `targetId` (null = cuối), đổi folderId. */
  const dropOn = (targetId: string | null, folderId: string) => {
    if (!dragId) return;
    const arr = [...useConns.getState().conns];
    const di = arr.findIndex((c) => c.id === dragId);
    if (di < 0) return;
    const [moved] = arr.splice(di, 1);
    moved.folderId = folderId;
    let ti = targetId ? arr.findIndex((c) => c.id === targetId) : arr.length;
    if (ti < 0) ti = arr.length;
    arr.splice(ti, 0, moved);
    useConns.getState().setAll(arr);
    setDragId(null);
  };
  const folders = useDbFolders();
  const [menu, setMenu] = useState<{ x: number; y: number; items: CtxItem[] } | null>(null);
  const [editingFolder, setEditingFolder] = useState<string | null>(null);
  /** Kết nối đang đổi tên tại chỗ (F2 / menu chuột phải). */
  const [editingConn, setEditingConn] = useState<string | null>(null);
  const renameConn = (c: Conn, name: string) => {
    const n = name.trim();
    if (n && n !== c.name) useConns.getState().save({ ...c, name: n });
    setEditingConn(null);
  };
  const [sel, setSel] = useState<string | null>(null);

  const move = (c: Conn, folderId: string) => useConns.getState().save({ ...c, folderId });

  const connMenu = (c: Conn): CtxItem[] => [
    { id: "open", label: tr("db.openConnect"), action: () => openSession(c) },
    { id: "edit", label: tr("db.editConfig"), action: () => openForm(c.id) },
    { id: "rename", label: tr("db.renameF2"), action: () => setEditingConn(c.id) },
    ...(c.driver === "mysql" || c.driver === "postgres"
      ? [{
          id: "newdb",
          label: c.driver === "postgres" ? tr("db.newSchemaRunSql") : tr("db.newDatabaseRunSql"),
          action: () => { openSession(c); requestNewDb(c.id); },
        }]
      : []),
    {
      id: "dup",
      label: tr("db.duplicateConnection"),
      action: () => {
        const copy: Conn = { ...c, id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, name: `${c.name} (copy)` };
        useConns.getState().save(copy);
        openForm(copy.id);
      },
    },
    { id: "s1", sep: true },
    // Chuyển vào thư mục.
    ...folders.filter((f) => f.id !== c.folderId).map((f) => ({ id: `mv-${f.id}`, label: `${tr("db.moveTo")} 🗂 ${f.name}`, action: () => move(c, f.id) })),
    ...(c.folderId ? [{ id: "mv-root", label: tr("db.moveOutOfFolder"), action: () => move(c, "") }] : []),
    { id: "s2", sep: true },
    { id: "forget", label: tr("db.forgetSavedPassword"), action: () => void call("db_forget_password", { id: c.id }).catch(() => {}) },
    {
      id: "del",
      label: tr("db.deleteConnection"),
      danger: true,
      action: () => void confirmDialog({ message: tr("db.deleteConnectionTheSavedPasswordIs", { name: c.name }) }).then((ok) => {
        if (!ok) return;
        void call("db_forget_password", { id: c.id }).catch(() => {});
        useConns.getState().remove(c.id);
      }),
    },
  ];

  const folderMenu = (f: { id: string; name: string }): CtxItem[] => [
    { id: "add", label: tr("db.newConnectionInFolder"), action: () => openForm(undefined, f.id) },
    { id: "rename", label: tr("db.renameFolder"), action: () => setEditingFolder(f.id) },
    { id: "s1", sep: true },
    { id: "del", label: tr("db.deleteFolderConnectionsMoveOut"), danger: true, action: () => void confirmDialog({ message: tr("db.deleteFolderConnectionsInsideMoveOut", { name: f.name }) }).then((ok) => ok && removeDbFolder(f.id)) },
  ];

  const connRow = (c: Conn, inFolder: boolean) => (
    <div
      key={c.id}
      className={`side-item ${c.env === "prod" ? "prod" : ""} ${sel === c.id ? "sel" : ""} ${dragId === c.id ? "dragging" : ""}`}
      style={inFolder ? { paddingLeft: 24 } : undefined}
      draggable={editingConn !== c.id}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return; // phím gõ trong ô đổi tên
        if (e.key === "F2") { e.preventDefault(); setEditingConn(c.id); }
        else if (e.key === "Enter") { e.preventDefault(); openSession(c); }
      }}
      onDragStart={(e) => { setDragId(c.id); e.dataTransfer.effectAllowed = "move"; }}
      onDragEnd={() => setDragId(null)}
      onDragOver={(e) => { if (dragId) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (dragId !== c.id) e.currentTarget.classList.add("drop-before"); } }}
      onDragLeave={(e) => e.currentTarget.classList.remove("drop-before")}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); e.currentTarget.classList.remove("drop-before"); dropOn(c.id, c.folderId ?? ""); }}
      onClick={() => setSel(c.id)}
      onDoubleClick={() => openSession(c)}
      onContextMenu={(e) => { e.preventDefault(); setSel(c.id); setMenu({ x: e.clientX, y: e.clientY, items: connMenu(c) }); }}
      title={`${tr("db.doubleClickToOpen")} · ${describe(c)}`}
    >
      {editingConn === c.id ? (
        <input
          autoFocus
          className="tree-rename grow"
          defaultValue={c.name}
          onFocus={(e) => e.currentTarget.select()}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onBlur={(e) => renameConn(c, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") { e.preventDefault(); setEditingConn(null); }
          }}
        />
      ) : (
        <span className="grow ellipsis">{c.name}</span>
      )}
      <span className={`env-tag ${c.env}`}>{c.env.toUpperCase()}</span>
      <span className="muted small">{DRIVERS[c.driver].name.split(" ")[0]}</span>
      <button className="icon-btn small" title={tr("db.edit")} onClick={(e) => { e.stopPropagation(); openForm(c.id); }}>✏</button>
    </div>
  );

  const rootConns = conns.filter((c) => !c.folderId || !folders.some((f) => f.id === c.folderId));

  return (
    <div
      className="side-list fill"
      onDragOver={(e) => { if (dragId) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; } }}
      onDrop={(e) => { if (dragId) { e.preventDefault(); dropOn(null, ""); } }}
      onContextMenu={(e) => {
        // Chỉ khi chuột phải vào CHỖ TRỐNG (hàng kết nối/thư mục có menu riêng).
        if ((e.target as HTMLElement).closest(".side-item, .tree-row, input, button")) return;
        e.preventDefault();
        setMenu({
          x: e.clientX,
          y: e.clientY,
          items: [
            { id: "newConn", label: tr("db.newConnection"), action: () => openForm() },
            { id: "newFolder", label: tr("db.newFolder"), action: () => setEditingFolder(addDbFolder()) },
          ],
        });
      }}
    >
      <div className="side-head">
        <span>{tr("db.connections")}</span>
        <span className="side-actions">
          <button className="icon-btn" title={tr("db.newConnection")} onClick={() => openForm()}>＋</button>
          <button className="icon-btn" title={tr("db.newFolder")} onClick={() => setEditingFolder(addDbFolder())}>🗂</button>
        </span>
      </div>

      {folders.map((f) => (
        <div key={f.id}>
          <div
            className="tree-row"
            tabIndex={0}
            onClick={() => toggleDbFolder(f.id)}
            onKeyDown={(e) => { if (e.key === "F2") { e.preventDefault(); setEditingFolder(f.id); } }}
            onDragOver={(e) => { if (dragId) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; e.currentTarget.classList.add("drop-into"); } }}
            onDragLeave={(e) => e.currentTarget.classList.remove("drop-into")}
            onDrop={(e) => { e.preventDefault(); e.stopPropagation(); e.currentTarget.classList.remove("drop-into"); dropOn(null, f.id); }}
            onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, items: folderMenu(f) }); }}
          >
            <span className="tree-caret">{f.open ? "▾" : "▸"}</span>
            <span className="tree-icon">🗂</span>
            {editingFolder === f.id ? (
              <input
                autoFocus
                className="tree-rename"
                defaultValue={f.name}
                onFocus={(e) => e.currentTarget.select()}
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => { renameDbFolder(f.id, e.target.value.trim() || f.name); setEditingFolder(null); }}
                onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") setEditingFolder(null); }}
              />
            ) : (
              <span className="grow ellipsis">{f.name}</span>
            )}
            <span className="row-actions" onClick={(e) => e.stopPropagation()}>
              <button className="icon-btn" title={tr("db.newConnectionInFolder2")} onClick={() => openForm(undefined, f.id)}>＋</button>
              <button className="icon-btn" title={tr("db.rename")} onClick={() => setEditingFolder(f.id)}>✎</button>
              <button className="icon-btn danger" title={tr("db.deleteFolder")} onClick={() => void confirmDialog({ message: tr("db.deleteFolderConnectionsInsideMoveOut", { name: f.name }) }).then((ok) => ok && removeDbFolder(f.id))}>×</button>
            </span>
          </div>
          {f.open && conns.filter((c) => c.folderId === f.id).map((c) => connRow(c, true))}
        </div>
      ))}
      {rootConns.map((c) => connRow(c, false))}

      {!conns.length && !folders.length && <div className="muted small pad">{tr("db.noConnectionsYetClickToAdd")}</div>}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

/* ── Form thêm/sửa kết nối ─────────────────────── */

function ConnForm({ connId, folderId, onClose }: { connId?: string; folderId?: string; onClose: () => void }) {
  const tr = useT();
  const { conns, save, remove } = useConns();
  const editing = conns.find((c) => c.id === connId);
  const folders = useDbFolders();
  const [c, setC] = useState<Conn>(editing ?? { ...newConn(), folderId: folderId ?? "" });
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const set = (patch: Partial<Conn>) => setC((x) => ({ ...x, ...patch }));
  const isFile = c.driver === "sqlite";

  const test = async () => {
    setStatus({ ok: true, text: c.ssh?.enabled ? tr("db.openingSshTunnelTesting") : tr("db.testingConnection") });
    try {
      const { id, tunnelId } = await dbConnectMaybeTunnel(c, password);
      await call("db_disconnect", { id });
      if (tunnelId) await invoke("ssh_tunnel_close", { id: tunnelId }).catch(() => {});
      setStatus({ ok: true, text: tr("db.connectedSuccessfully") });
    } catch (e) {
      setStatus({ ok: false, text: errText(e) });
    }
  };
  const submit = () => {
    if (!c.name.trim()) return setStatus({ ok: false, text: tr("db.enterAConnectionName") });
    save({ ...c, name: c.name.trim() });
    if (password) sessionPasswords.set(c.id, password);
    // Quyết định lưu mật khẩu NGAY lúc tạo: tick → ghi keyring (lần sau tự nối); bỏ tick → xoá (lần sau mở modal hỏi).
    if (!isFile) {
      if (c.savePw) { if (password) void call("db_save_password", { id: c.id, password }).catch(() => {}); }
      else void call("db_forget_password", { id: c.id }).catch(() => {});
    }
    onClose();
    openSession(c);
  };

  return (
    <Modal title={editing ? tr("db.editConnection") : tr("db.newConnection2")} width={620} onClose={onClose}>
      <div className="form account-form">
        <label>{tr("db.name")}<input value={c.name} onChange={(e) => set({ name: e.target.value })} placeholder="vd. HRM dev" autoFocus /></label>
        <div className="field">
          <span className="field-cap">{tr("db.type")}</span>
          <div className="picker-field">
            <Picker
              label={<span className="ellipsis">{DRIVERS[c.driver].name}</span>}
              items={(Object.keys(DRIVERS) as Driver[]).map((d) => ({ id: d, label: DRIVERS[d].name, selected: c.driver === d }))}
              onPick={(id) => { const d = id as Driver; set({ driver: d, port: DRIVERS[d].port }); }}
            />
          </div>
        </div>
        {isFile ? (
          <label>File<input className="mono" value={c.file} onChange={(e) => set({ file: e.target.value })} placeholder="D:\data\app.db" /></label>
        ) : (
          <>
            <div className="form-row">
              <label className="grow">Host<input value={c.host} onChange={(e) => set({ host: e.target.value })} /></label>
              <label style={{ width: 100 }}>Port<input type="number" value={c.port ?? ""} onChange={(e) => set({ port: e.target.value ? Number(e.target.value) : undefined })} /></label>
            </div>
            <div className="form-row">
              <label className="grow">User<input value={c.user} onChange={(e) => set({ user: e.target.value })} /></label>
              <label className="grow">{tr("db.password")}
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </label>
            </div>
            <label className="check">
              <input type="checkbox" checked={c.savePw !== false} onChange={(e) => set({ savePw: e.target.checked })} />
              {tr("db.savePassword")}
            </label>
            <label>
              {c.driver === "cassandra" ? "Keyspace" : "Database"}
              <input value={c.database} onChange={(e) => set({ database: e.target.value })}
                placeholder={c.driver === "cassandra" ? tr("db.emptyListAllKeyspaces") : undefined} />
            </label>
          </>
        )}
        <div className="field">
          <span className="field-cap">{tr("db.environment")}</span>
          <div className="picker-field">
            <Picker
              label={<span className="ellipsis">{c.env}</span>}
              items={[
                { id: "dev", label: "dev", selected: c.env === "dev" },
                { id: "staging", label: "staging", selected: c.env === "staging" },
                { id: "prod", label: tr("db.prodRedBorderConfirmBeforeWrites"), selected: c.env === "prod" },
              ]}
              onPick={(id) => set({ env: id as Conn["env"] })}
            />
          </div>
        </div>
        <div className="field">
          <span className="field-cap">{tr("db.folder")}</span>
          <div className="picker-field">
            <Picker
              label={<span className="ellipsis">{folders.find((f) => f.id === c.folderId)?.name ?? tr("db.noFolder")}</span>}
              items={[{ id: "", label: tr("db.noFolder"), selected: !c.folderId }, ...folders.map((f) => ({ id: f.id, label: f.name, selected: c.folderId === f.id }))]}
              onPick={(id) => set({ folderId: id })}
            />
          </div>
        </div>
        {!isFile && (
          <>
            <label className="check">
              <input
                type="checkbox"
                checked={!!c.ssh?.enabled}
                onChange={(e) => set({ ssh: { host: "", port: 22, user: "", keyPath: "", ...c.ssh, enabled: e.target.checked } })}
              /> {tr("db.connectViaSshTunnel")}
            </label>
            {c.ssh?.enabled && (
              <div className="ssh-fields">
                <div className="form-row">
                  <label className="grow">SSH Host<input className="mono" value={c.ssh.host} onChange={(e) => set({ ssh: { ...c.ssh!, host: e.target.value } })} placeholder="jump.example.com" /></label>
                  <label style={{ width: 90 }}>Port<input className="mono" type="number" value={c.ssh.port} onChange={(e) => set({ ssh: { ...c.ssh!, port: Number(e.target.value) || 22 } })} /></label>
                  <label className="grow">SSH User<input value={c.ssh.user} onChange={(e) => set({ ssh: { ...c.ssh!, user: e.target.value } })} placeholder="ubuntu" /></label>
                </div>
                <label>{tr("db.privateKeyBatchmodeNeedsKeyAgent")}
                  <div className="form-row">
                    <input className="grow mono" value={c.ssh.keyPath} onChange={(e) => set({ ssh: { ...c.ssh!, keyPath: e.target.value } })} placeholder={tr("db.emptyDefaultKeySshAgent")} />
                    <button onClick={() => void pickDbKey((p) => set({ ssh: { ...c.ssh!, keyPath: p } }))}>{tr("db.browse")}</button>
                  </div>
                </label>
                <div className="muted small">{tr("db.dbConnects127001")} <span className="mono">{c.host || "host"}:{c.port ?? "port"}</span> {tr("db.viaTheSshServerAbove")}</div>
              </div>
            )}
          </>
        )}
        <div className="toolbar">
          <button onClick={test}>{tr("db.testConnection")}</button>
          <span className="grow" />
          {editing && (
            <button className="danger" onClick={() => void confirmDialog({ message: tr("db.deleteConnectionAndPassword", { name: c.name || tr("db.thisFallback") }) }).then((ok) => { if (!ok) return; void call("db_forget_password", { id: c.id }).catch(() => {}); remove(c.id); onClose(); })}>{tr("db.delete")}</button>
          )}
          <button className="primary" onClick={submit}>{tr("db.saveOpen")}</button>
        </div>
        {status && <div className={status.ok ? "muted" : "error-box"}>{status.text}</div>}
      </div>
    </Modal>
  );
}

/* ── Phiên làm việc với một kết nối ────────────── */

const READ_ONLY = /^\s*(select|show|describe|desc|explain|with|pragma|values)\b/i;
/** Câu đổi CẤU TRÚC (bảng/cột/routine) → cần nạp lại cây; DML (INSERT/UPDATE/DELETE) thì không. */
const isDdl = (stmt: string) =>
  /^(create|alter|drop|rename|truncate)\b/i.test(stmt.replace(/^(\s|--[^\n]*\n?|#[^\n]*\n?|\/\*[\s\S]*?\*\/)+/, ""));
const isWrite = (sql: string) => sql.split(";").some((s) => s.trim() && !READ_ONLY.test(s));

function quote(c: Conn, t: TableInfo) {
  // Qualify theo db/schema để mở bảng ở db khác db đang chọn cũng đúng.
  if (c.driver === "mysql") return t.schema ? `\`${t.schema}\`.\`${t.name}\`` : `\`${t.name}\``;
  if (c.driver === "postgres") return t.schema === "public" ? `"${t.name}"` : `"${t.schema}"."${t.name}"`;
  // Cassandra: keyspace (≈ schema) là "database" của nó → luôn qualify.
  if (c.driver === "cassandra") return t.schema ? `"${t.schema}"."${t.name}"` : `"${t.name}"`;
  return `"${t.name}"`;
}

/** Gợi ý tên khi lưu query: dòng đầu không phải comment, cắt gọn. */
function deriveQueryName(sql: string): string {
  const line = sql.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("--")) ?? "";
  const s = line.replace(/\s+/g, " ").slice(0, 48).trim();
  return s || "Query";
}

function Session({ tab }: { tab: Tab }) {
  const conn = useConns((s) => s.conns.find((c) => c.id === tab.payload.connId));
  const allConns = useConns((s) => s.conns);
  const log = useWorkbench((s) => s.log);
  const tr = useT();
  const [dbId, setDbId] = useState<string | null>(null);
  const dbIdRef = useRef<string | null>(null);
  const tunnelIdRef = useRef<string | null>(null);
  const [password, setPassword] = useState(sessionPasswords.get(String(tab.payload.connId)) ?? "");
  const [remember, setRemember] = useState(true);
  const [connecting, setConnecting] = useState(false);
  /** Chỉ hiện form nhập mật khẩu khi KHÔNG tự kết nối được (chưa lưu / sai mật khẩu). */
  const [needPw, setNeedPw] = useState(false);
  const [dbs, setDbs] = useState<string[]>([]);
  /** DB đã "mở kết nối" (có caret, đã nạp) — kiểu Navicat; ⊇ expanded. */
  const [opened, setOpened] = useState<Set<string>>(new Set());
  /** DB đang xổ danh sách con (tạm đóng = bỏ khỏi đây nhưng vẫn trong opened). */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [tablesByDb, setTablesByDb] = useState<Record<string, TableInfo[]>>({});
  const [colsByDb, setColsByDb] = useState<Record<string, { table: string; column: string }[]>>({});
  const [loadingDbs, setLoadingDbs] = useState<Set<string>>(new Set());
  /** Gợi ý khi gõ SQL (tên bảng / cột / database / từ khoá). */
  const [sug, setSug] = useState<{ items: Sug[]; x: number; y: number; start: number; end: number; q: string } | null>(null);
  const [sugIdx, setSugIdx] = useState(0);
  const [filter, setFilter] = useState("");
  const [sql, setSql] = useState("");
  const [results, setResults] = useState<QueryOut[]>([]);
  /** Menu chuột phải trên một bảng (thêm cột/index, copy tên…). */
  const [tblMenu, setTblMenu] = useState<{ x: number; y: number; t: TableInfo } | null>(null);
  /** Modal ALTER TABLE / CREATE INDEX. */
  const [ddl, setDdl] = useState<{ kind: "col" | "idx"; t: TableInfo } | null>(null);
  /** Đổi tên bảng tại chỗ (F2). */
  const [renaming, setRenaming] = useState<{ t: TableInfo; name: string } | null>(null);
  /** Modal cấu trúc bảng (Edit table) và tạo bảng mới. */
  const [structT, setStructT] = useState<TableInfo | null>(null);
  const [newTable, setNewTable] = useState<{ schema: string } | null>(null);
  const [syncOpen, setSyncOpen] = useState(false);
  const [dumping, setDumping] = useState(false);
  /** Tiến trình dump cả database (việc nặng: lặp từng bảng, có thể kèm dữ liệu). */
  const [dumpProgress, setDumpProgress] = useState<{ db: string; done: number; total: number; table: string } | null>(null);
  /** Database/schema đang dùng để chạy query (gửi tham số `schema` → backend dùng pool đặt sẵn database/search_path). */
  const [activeDb, setActiveDb] = useState("");
  /** Bảng đang chọn (click đơn) → khung thông tin cơ bản; double-click / Enter mới chạy SELECT. */
  const [selTable, setSelTable] = useState<TableInfo | null>(null);
  /** Database đang được chọn (click đơn) — khác activeDb (db đang USE). */
  const [selDb, setSelDb] = useState<string | null>(null);
  /** Menu chuột phải trên một database (Open / Edit / New / Dump). */
  const [dbMenu, setDbMenu] = useState<{ x: number; y: number; db: string } | null>(null);
  /** Modal tạo database mới / sửa charset-collation database. */
  const [newDbOpen, setNewDbOpen] = useState(false);
  const [alterDb, setAlterDb] = useState<string | null>(null);
  /** Database đang mở sơ đồ quan hệ khoá ngoại (MySQL). */
  const [erDb, setErDb] = useState<{ db: string; focus?: string } | null>(null);
  /** Query đã lưu (theo kết nối) + modal lưu/đổi tên + menu chuột phải. */
  const connId = String(tab.payload.connId);
  const savedAll = useSavedQueries();
  const savedQueries = useMemo(() => savedAll.filter((q) => q.connId === connId).sort((a, b) => a.name.localeCompare(b.name)), [savedAll, connId]);
  /** Tên query đang mở trong editor (để nút Lưu điền sẵn + biết đang sửa cái nào). */
  const [curQueryName, setCurQueryName] = useState("");
  /** Modal "Lưu query": null = đóng. */
  const [saveName, setSaveName] = useState<string | null>(null);
  /** Modal đổi tên query đã lưu. */
  const [renameQ, setRenameQ] = useState<{ id: string; name: string } | null>(null);
  /** Menu chuột phải trên một query đã lưu. */
  const [qMenu, setQMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  /** Routine (procedure/function/event) theo database — nạp lười cùng bảng. */
  const [routinesByDb, setRoutinesByDb] = useState<Record<string, RoutineInfo[]>>({});
  /** Nhóm mở thêm (mặc-định-đóng: routines) — key `db|kind`. */
  const [openSecs, setOpenSecs] = useState<Set<string>>(new Set());
  /** Nhóm đóng bớt (mặc-định-mở: Tables/Views) — key `db|tables|views`. */
  const [closedSecs, setClosedSecs] = useState<Set<string>>(new Set());
  /** Menu chuột phải trên một routine. */
  const [routineMenu, setRoutineMenu] = useState<{ x: number; y: number; r: RoutineInfo } | null>(null);
  /** Modal soạn routine (CREATE PROCEDURE/FUNCTION/EVENT). */
  const [routineModal, setRoutineModal] = useState<{ db: string; name: string; kind: RoutineKind; mode: "new" | "edit"; sql: string; dropFirst?: string } | null>(null);
  /** Modal Event kiểu Navicat (form cấu hình lịch) — chỉ MySQL; có init = sửa event cũ. */
  const [eventModal, setEventModal] = useState<{ db: string; mode: "new" | "edit"; init?: EventInit } | null>(null);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  /** Id của query đang chạy (để nút Cancel gọi db_cancel). */
  const runId = useRef<string | null>(null);
  /** Giới hạn thời gian mỗi câu lệnh (giây); 0 = không giới hạn. Nhớ trong localStorage. */
  /** Cỡ trang mặc định cho kết quả phân trang (nhớ localStorage). */
  const [pageSize, setPageSize] = useState(() => Number(localStorage.getItem("db.pageSize")) || 200);
  const [timeoutSecs, setTimeoutSecs] = useState(() => Number(localStorage.getItem("db.timeoutSecs")) || 0);
  const [confirmSql, setConfirmSql] = useState<string | null>(null);
  /** Bề rộng cột danh sách bảng — kéo được, nhớ lại. (Phải đặt trước mọi lệnh return sớm.) */
  const [tablesW, setTablesW] = useSplitSize("db.tables", 220, 160, 480);
  const editor = useRef<HTMLTextAreaElement>(null);

  // Đóng tab → đóng kết nối + SSH tunnel phía Rust.
  useEffect(() => () => {
    if (dbIdRef.current) void call("db_disconnect", { id: dbIdRef.current }).catch(() => {});
    if (tunnelIdRef.current) void invoke("ssh_tunnel_close", { id: tunnelIdRef.current }).catch(() => {});
  }, []);

  if (!conn) return <div className="empty">{t("db.connectionWasDeleted")}</div>;
  const needsPassword = conn.driver !== "sqlite";

  const connect = async (pw: string = password) => {
    if (!conn) return;
    setConnecting(true);
    setError("");
    try {
      const { id, tunnelId } = await dbConnectMaybeTunnel(conn, pw);
      dbIdRef.current = id;
      tunnelIdRef.current = tunnelId;
      setDbId(id);
      // Lưu mật khẩu: tick thì ghi vào Windows Credential Manager (lần sau tự kết nối, khỏi nhập); bỏ tick thì xoá.
      if (pw) sessionPasswords.set(conn.id, pw);
      if (needsPassword) {
        if (remember && pw) void call("db_save_password", { id: conn.id, password: pw }).catch(() => {});
        else if (!remember) void call("db_forget_password", { id: conn.id }).catch(() => {});
      }
      log(t("db.logConnected", { name: conn.name, desc: describe(conn) }));
      // Config có nhập database cụ thể → chỉ hiện đúng db đó; để trống → liệt kê mọi database (tải lười bảng khi mở).
      const configured = conn.database.trim();
      const list = configured ? [configured] : await call<string[]>("db_databases", { id });
      setDbs(list);
      // Mở sẵn db đã cấu hình (hoặc db duy nhất) cho tiện.
      const auto = configured || (list.length === 1 ? list[0] : null);
      if (auto) { setOpened(new Set([auto])); setExpanded(new Set([auto])); void loadTables(id, auto); }
    } catch (e) {
      setError(errText(e));
      // Kết nối hỏng (vd. mật khẩu lưu bị sai) → hiện form để nhập lại.
      if (needsPassword) setNeedPw(true);
    } finally {
      setConnecting(false);
    }
  };

  /** Tải bảng + cột của một database (lazy; cột dùng cho gợi ý SQL). */
  const loadTables = async (idArg: string, db: string) => {
    setLoadingDbs((s) => new Set(s).add(db));
    try {
      const ts = await call<TableInfo[]>("db_tables", { id: idArg, schema: db });
      setTablesByDb((m) => ({ ...m, [db]: ts }));
      // Cột chỉ dùng cho gợi ý khi gõ SQL — information_schema.columns có thể chậm (MySQL nhiều bảng)
      // → nạp ngầm, KHÔNG bắt cây bảng phải chờ.
      void call<string[]>("db_columns", { id: idArg, schema: db })
        .then((cols) => setColsByDb((m) => ({
          ...m,
          [db]: cols.map((s) => { const [ , t, c] = s.split("\u001f"); return { table: t ?? "", column: c ?? "" }; }),
        })))
        .catch(() => {});
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoadingDbs((s) => { const n = new Set(s); n.delete(db); return n; });
    }
    void loadRoutines(idArg, db);
  };

  /** Nạp danh sách routine (procedure/function/event) của một database — chỉ MySQL/Postgres. */
  const loadRoutines = async (idArg: string, db: string) => {
    if (conn.driver !== "mysql" && conn.driver !== "postgres") return;
    const esc = db.replace(/'/g, "''");
    try {
      const list: RoutineInfo[] = [];
      if (conn.driver === "mysql") {
        const [rt, ev] = await Promise.all([
          call<QueryOut>("db_query", { id: idArg, sql: `SELECT ROUTINE_NAME, ROUTINE_TYPE FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA='${esc}' ORDER BY ROUTINE_TYPE, ROUTINE_NAME`, limit: 5000 }).catch(() => null),
          call<QueryOut>("db_query", { id: idArg, sql: `SELECT EVENT_NAME FROM information_schema.EVENTS WHERE EVENT_SCHEMA='${esc}' ORDER BY EVENT_NAME`, limit: 5000 }).catch(() => null),
        ]);
        if (rt) for (const r of rt.rows) { const name = r[0] ?? ""; if (name) list.push({ db, name, kind: (r[1] ?? "").toUpperCase() === "FUNCTION" ? "function" : "procedure" }); }
        if (ev) for (const r of ev.rows) { const name = r[0] ?? ""; if (name) list.push({ db, name, kind: "event" }); }
      } else {
        const q = await call<QueryOut>("db_query", { id: idArg, sql: `SELECT p.proname, CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='${esc}' AND p.prokind IN ('f','p') ORDER BY 2, 1`, limit: 5000 }).catch(() => null);
        if (q) for (const r of q.rows) { const name = r[0] ?? ""; if (name) list.push({ db, name, kind: (r[1] ?? "").toUpperCase() === "PROCEDURE" ? "procedure" : "function" }); }
      }
      setRoutinesByDb((m) => ({ ...m, [db]: list }));
    } catch { /* bỏ qua — server cũ / thiếu quyền information_schema */ }
  };
  /** Mở kết nối db (kiểu Navicat): có caret, xổ con, nạp bảng + USE để query. */
  const openDb = (db: string) => {
    setOpened((s) => new Set(s).add(db));
    setExpanded((s) => new Set(s).add(db));
    if (dbIdRef.current && !tablesByDb[db]) void loadTables(dbIdRef.current, db);
    setActiveDb(db);
  };
  /** Tạm đóng / mở lại (vẫn giữ kết nối) — KHÔNG đổi USE. */
  const toggleExpand = (db: string) => {
    const willExpand = !expanded.has(db);
    setExpanded((s) => { const n = new Set(s); if (n.has(db)) n.delete(db); else n.add(db); return n; });
    if (willExpand && dbIdRef.current && !tablesByDb[db]) void loadTables(dbIdRef.current, db);
  };
  /** Đóng hẳn kết nối db: mất caret, bỏ USE, giải phóng cache đã nạp. */
  const closeDb = (db: string) => {
    setSelTable((cur) => (cur?.schema === db ? null : cur));
    setOpened((s) => { const n = new Set(s); n.delete(db); return n; });
    setExpanded((s) => { const n = new Set(s); n.delete(db); return n; });
    setActiveDb((cur) => (cur === db ? "" : cur));
    setTablesByDb((m) => { const n = { ...m }; delete n[db]; return n; });
    setColsByDb((m) => { const n = { ...m }; delete n[db]; return n; });
    setRoutinesByDb((m) => { const n = { ...m }; delete n[db]; return n; });
  };
  // Lần đầu có danh sách db: nếu config chỉ đích danh `database` thì tự USE db đó. Ngược lại không USE mặc định.
  // Sau lần đầu chỉ xác thực (xoá activeDb nếu db biến mất) — không ép lại khi người dùng đã tự đóng.
  const didInitActive = useRef(false);
  useEffect(() => {
    if (!dbs.length) return;
    if (!didInitActive.current) {
      didInitActive.current = true;
      const cfg = conn.database.trim();
      if (cfg && dbs.includes(cfg)) { setActiveDb(cfg); return; }
    }
    setActiveDb((cur) => (cur && dbs.includes(cur) ? cur : ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbs]);
  /** Nạp lại danh sách db + bảng của các db đang mở. */
  const reloadDbs = async () => {
    if (!dbIdRef.current) return;
    try {
      setDbs(await call<string[]>("db_databases", { id: dbIdRef.current }));
      for (const db of expanded) void loadTables(dbIdRef.current, db);
    } catch (e) { setError(errText(e)); }
  };

  // Tự kết nối khi mở: SQLite (không cần pass) hoặc đã có mật khẩu lưu (RAM / keyring) → khỏi hỏi lại (giống Navicat).
  const autoTried = useRef(false);
  useEffect(() => {
    if (autoTried.current || dbIdRef.current || !conn) return;
    autoTried.current = true;
    void (async () => {
      if (!needsPassword) return void connect("");
      const ram = sessionPasswords.get(conn.id);
      if (ram !== undefined) { setPassword(ram); return void connect(ram); }
      const saved = await call<string | null>("db_get_password", { id: conn.id }).catch(() => null);
      if (saved != null) { setPassword(saved); sessionPasswords.set(conn.id, saved); return void connect(saved); }
      // Mặc định (chưa bỏ tick "Lưu mật khẩu") → nối thẳng với mật khẩu rỗng, kể cả DB không có mật khẩu.
      if (conn.savePw !== false) return void connect("");
      setNeedPw(true); // ĐÃ bỏ tick lưu → mở modal nhập mật khẩu
    })();
    // chỉ chạy một lần khi mở tab
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Chuột phải server ở sidebar → "Database mới": mở phiên rồi mở modal tạo DB khi đã kết nối.
  const newDbReq = useNewDbReq();
  const newDbTokenRef = useRef(0);
  useEffect(() => {
    if (!newDbReq || !conn || newDbReq.connId !== conn.id) return;
    if (newDbReq.token === newDbTokenRef.current) return; // đã xử lý token này
    if (!dbId) return; // chờ kết nối xong rồi mới mở modal (cần dbId cho picker charset)
    newDbTokenRef.current = newDbReq.token;
    setNewDbOpen(true);
  }, [newDbReq, conn, dbId]);

  /* ── Sửa dữ liệu trên bảng kết quả (kiểu Navicat) ── */
  const editTargets = useRef(new Map<string, EditTarget>());
  const gridEditorImpl = useRef<GridEditor | null>(null);
  gridEditorImpl.current = {
    driver: conn ? (conn.driver as GridDriver) : "mysql",
    resolve: async (sql) => {
      const src = parseSourceTable(sql);
      if (!src) return /^\s*(select|with)\b/i.test(sql.replace(/^(\s|--[^\n]*\n?|\/\*[\s\S]*?\*\/)+/, "")) ? { ok: false, reason: tr("db.roNotSingleTable") } : null;
      if (!dbId || !conn) return null;
      if (conn.driver === "cassandra") return { ok: false, reason: tr("db.roDriver") };
      const schema = src.schema ?? (conn.driver === "mysql" ? (activeDb || conn.database) : conn.driver === "postgres" ? (activeDb || "public") : "main");
      const key = `${schema}.${src.table}`;
      const cached = editTargets.current.get(key);
      if (cached) return cached;
      try {
        const cols = (await call<string[]>("db_table_columns", { id: dbId, schema, table: src.table })).map((x) => x.split("\u001f"));
        if (!cols.length) return { ok: false, reason: tr("db.roMetaError", { msg: key }) };
        const pkCols = cols.filter((c) => (conn.driver === "sqlite" ? !!c[4] && c[4] !== "0" : c[4] === "PRI")).map((c) => c[0]);
        const d = conn.driver as GridDriver;
        // Không có schema trong câu SELECT → để UPDATE không qualify; chạy cùng schema (activeSchema) như lúc SELECT.
        const tableRef = src.schema ? `${quoteIdent(src.schema, d)}.${quoteIdent(src.table, d)}` : quoteIdent(src.table, d);
        const target: EditTarget = pkCols.length
          ? { ok: true, tableRef, pkCols, tableCols: new Set(cols.map((c) => c[0])) }
          : { ok: false, reason: tr("db.roNoPk") };
        editTargets.current.set(key, target);
        return target;
      } catch (e) {
        return { ok: false, reason: tr("db.roMetaError", { msg: errText(e) }) };
      }
    },
    save: async (stmts) => {
      if (!dbId || !conn) return { done: 0, zero: 0, error: tr("db.connectionWasDeleted") };
      if (conn.env === "prod") {
        const ok = await confirmDialog({
          title: tr("db.saveToProdTitle", { n: stmts.length }),
          message: stmts.slice(0, 15).join("\n") + (stmts.length > 15 ? "\n…" : ""),
          confirmLabel: tr("db.saveToProdConfirm"),
        });
        if (!ok) return { done: 0, zero: 0, cancelled: true };
      }
      let zero = 0;
      for (let i = 0; i < stmts.length; i++) {
        try {
          const out = await call<QueryOut>("db_query", { id: dbId, sql: stmts[i], limit: 1, timeoutSecs, schema: activeSchema() });
          if (!out.rowsAffected) zero++;
        } catch (e) {
          return { done: i, zero, error: errText(e) };
        }
      }
      log(tr("db.logGridSaved", { n: stmts.length, name: conn.name }));
      return { done: stmts.length, zero };
    },
  };
  const gridPagerImpl = useRef<GridPager | null>(null);
  gridPagerImpl.current = {
    fetch: async (pg, page, size) => {
      if (!dbId) throw new Error(tr("db.connectionWasDeleted"));
      if (pg.cass) {
        // Đổi cỡ trang → token cũ không dùng được nữa, đọc lại từ đầu.
        const same = size === pg.size;
        const states = same ? pg.cass.states : [null];
        const p = same ? page : 0;
        const out = await call<QueryOut>("db_query", { id: dbId, sql: pg.base, limit: size, timeoutSecs, pageSize: size, pageState: states[p] ?? null });
        return withCassPaging(out, pg.base, p, size, states);
      }
      const out = await call<QueryOut>("db_query", { id: dbId, sql: pagedSql(pg.base, size, page * size), limit: size + 1, timeoutSecs, schema: activeSchema() });
      return withPaging(out, pg.base, page, size);
    },
    count: async (base) => {
      if (!dbId) throw new Error(tr("db.connectionWasDeleted"));
      const out = await call<QueryOut>("db_query", { id: dbId, sql: countSql(base), limit: 1, timeoutSecs, schema: activeSchema() });
      return Number(out.rows[0]?.[0] ?? 0);
    },
    setDefaultSize: (n) => { setPageSize(n); localStorage.setItem("db.pageSize", String(n)); },
  };
  const gridPager = useMemo<GridPager>(() => ({
    fetch: (pg, p, sz) => gridPagerImpl.current!.fetch(pg, p, sz),
    count: (b) => gridPagerImpl.current!.count(b),
    setDefaultSize: (n) => gridPagerImpl.current!.setDefaultSize(n),
  }), []);
  const gridEditor = useMemo<GridEditor>(() => ({
    get driver() { return gridEditorImpl.current!.driver; },
    resolve: (sql) => gridEditorImpl.current!.resolve(sql),
    save: (stmts) => gridEditorImpl.current!.save(stmts),
  }), []);

  /** Database/schema đang chọn để chạy query → gửi kèm tham số `schema` cho db_query. Backend dùng pool
   *  có database/search_path đặt sẵn lúc kết nối — KHÔNG ghép "USE x;" vào câu (ProxySQL từ chối, lỗi 1148). */
  const activeSchema = (): string | undefined =>
    (conn?.driver === "mysql" || conn?.driver === "postgres") && activeDb.trim() ? activeDb.trim() : undefined;

  const exec = async (text: string, confirmed = false) => {
    if (!dbId || !text.trim()) return;
    if (conn.env === "prod" && !confirmed && isWrite(text)) return setConfirmSql(text);
    setConfirmSql(null);
    setRunning(true);
    setError("");
    const stmts = splitStatements(text);
    if (!stmts.length) { setRunning(false); return; }
    setResults([]);
    // Chạy lần lượt từng câu, giữ mọi kết quả (như Navicat). Câu lỗi → dừng, vẫn hiện các kết quả trước đó.
    const outs: QueryOut[] = [];
    let ddl = false;
    try {
      for (let i = 0; i < stmts.length; i++) {
        const qid = `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
        runId.current = qid;
        // Cassandra: SELECT luôn đọc theo trang bằng paging state của driver (như TablePlus) — không có OFFSET.
        const cassPage = conn.driver === "cassandra" && /^select\b/i.test(stripSql(stmts[i]));
        const pageable = !cassPage && isPageable(stmts[i], conn.driver as GridDriver);
        const out = await call<QueryOut>("db_query", {
          id: dbId,
          sql: pageable ? pagedSql(stmts[i], pageSize, 0) : stmts[i],
          limit: pageable ? pageSize + 1 : cassPage ? pageSize : ROW_LIMIT,
          queryId: qid,
          timeoutSecs,
          schema: activeSchema(),
          ...(cassPage ? { pageSize, pageState: null } : {}),
        });
        outs.push(cassPage ? withCassPaging(out, stmts[i], 0, pageSize, [null]) : pageable ? withPaging(out, stmts[i], 0, pageSize) : { ...out, sql: stmts[i] });
        setResults([...outs]); // cập nhật dần để thấy từng bảng khi chạy nhiều câu
        if (isDdl(stmts[i])) { ddl = true; editTargets.current.clear(); }
      }
    } catch (e) {
      // Báo rõ câu nào lỗi (kèm câu lệnh) khi chạy nhiều câu.
      const idx = outs.length; // số câu đã chạy thành công = chỉ số câu lỗi
      const where = stmts.length > 1 ? tr("db.statementFailed", { p: idx + 1, stmtsLength: stmts.length, p2: stmts[idx] }) : "";
      setError(where + errText(e));
    } finally {
      runId.current = null;
      if (ddl) for (const db of expanded) void loadTables(dbId, db);
      setRunning(false);
    }
  };

  /** Hủy câu lệnh đang chạy (gọi db_cancel với query_id hiện tại). */
  const cancelRun = () => {
    if (runId.current) void call("db_cancel", { queryId: runId.current }).catch(() => {});
  };

  /** Ctrl+Enter: chạy đoạn đang bôi đen, không bôi đen thì chạy cả ô. */
  const runEditor = () => {
    const el = editor.current;
    const picked = el && el.selectionStart !== el.selectionEnd ? sql.slice(el.selectionStart, el.selectionEnd) : sql;
    void exec(picked);
  };
  /** EXPLAIN câu lệnh đang chọn (hoặc cả ô), giữ nguyên câu trong ô soạn. */
  const runExplain = () => {
    const el = editor.current;
    const text = el && el.selectionStart !== el.selectionEnd ? sql.slice(el.selectionStart, el.selectionEnd) : sql;
    const stmts = splitStatements(text);
    if (!stmts.length) return;
    void exec(stmts.map((s) => (/^\s*explain\b/i.test(s) ? s : `EXPLAIN ${s}`)).join(";\n"));
  };

  /* ── Nhóm trong cây (Tables/Views + routines) ─────── */
  const toggleSet = (set: Set<string>, key: string) => { const n = new Set(set); if (n.has(key)) n.delete(key); else n.add(key); return n; };
  /** Nhóm có đang mở? defOpen = mở sẵn (Tables/Views) → theo closedSecs; ngược lại (routines) → theo openSecs. */
  const secOpen = (key: string, defOpen: boolean) => (defOpen ? !closedSecs.has(key) : openSecs.has(key));
  const toggleSec = (key: string, defOpen: boolean) =>
    defOpen ? setClosedSecs((s) => toggleSet(s, key)) : setOpenSecs((s) => toggleSet(s, key));
  const genId = () => `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const bq = (s: string) => s.replace(/`/g, "``");   // escape backtick (MySQL)
  const dq = (s: string) => s.replace(/"/g, '""');   // escape double-quote (Postgres)
  const routineKw = (k: RoutineKind) => (k === "event" ? "EVENT" : k === "function" ? "FUNCTION" : "PROCEDURE");

  /** Chạy một routine DDL như MỘT câu (không tách theo ';', vì thân BEGIN…END chứa ';'). */
  const runRoutine = async (sql: string, db: string, dropFirst?: string) => {
    if (!dbId || !sql.trim()) return;
    if (conn.env === "prod") {
      const ok = await confirmDialog({ message: tr("db.runThisRoutineDdlOnProd") });
      if (!ok) return;
    }
    setRunning(true); setError(""); setResults([]);
    try {
      if (dropFirst) { const qid = genId(); runId.current = qid; await call("db_query", { id: dbId, sql: dropFirst, limit: 1, queryId: qid, timeoutSecs }); }
      const qid = genId(); runId.current = qid;
      const out = await call<QueryOut>("db_query", { id: dbId, sql, limit: ROW_LIMIT, queryId: qid, timeoutSecs });
      setResults([out]);
      setRoutineModal(null);
      if (dbIdRef.current) void loadRoutines(dbIdRef.current, db);
    } catch (e) {
      setError(errText(e));
    } finally { runId.current = null; setRunning(false); }
  };

  /** Mở modal "routine mới" với mẫu sẵn (đã qualify theo db → chạy được ngay). */
  const newRoutine = (db: string, kind: RoutineKind) => {
    const mysql = conn.driver === "mysql";
    // Event (MySQL) có form cấu hình lịch kiểu Navicat thay cho SQL thô.
    if (kind === "event" && mysql) { setEventModal({ db, mode: "new" }); return; }
    const name = kind === "event" ? "new_event" : kind === "function" ? "new_function" : "new_procedure";
    let sql: string;
    if (mysql) {
      const q = `\`${bq(db)}\`.\`${name}\``;
      sql =
        kind === "event"
          ? `CREATE EVENT ${q}\nON SCHEDULE EVERY 1 DAY\nSTARTS CURRENT_TIMESTAMP\nON COMPLETION PRESERVE\nENABLE\nDO\n  -- ${t("db.tplRunOnSchedule")}\n  SELECT 1;`
          : kind === "function"
          ? `CREATE FUNCTION ${q}(arg1 INT)\nRETURNS INT\nDETERMINISTIC\nBEGIN\n  RETURN arg1;\nEND`
          : `CREATE PROCEDURE ${q}(IN arg1 INT)\nBEGIN\n  -- ${t("db.tplWriteStatementsHere")}\n  SELECT arg1;\nEND`;
    } else {
      const q = `"${dq(db)}"."${name}"`;
      sql =
        kind === "function"
          ? `CREATE OR REPLACE FUNCTION ${q}(arg1 int)\nRETURNS int\nLANGUAGE sql AS $$\n  SELECT arg1;\n$$;`
          : `CREATE OR REPLACE PROCEDURE ${q}(arg1 int)\nLANGUAGE plpgsql AS $$\nBEGIN\n  -- ${t("db.tplStatements")}\nEND;\n$$;`;
    }
    setRoutineModal({ db, name, kind, mode: "new", sql });
  };

  /** Mở modal xem/sửa định nghĩa routine đã có (SHOW CREATE / pg_get_functiondef).
   * Event MySQL → form cấu hình (đọc information_schema.EVENTS). */
  const openRoutine = async (r: RoutineInfo) => {
    if (!dbId) return;
    if (r.kind === "event" && conn.driver === "mysql") {
      try {
        const out = await call<QueryOut>("db_query", { id: dbId, sql: `SELECT EVENT_NAME, EVENT_DEFINITION, EVENT_TYPE, EXECUTE_AT, INTERVAL_VALUE, INTERVAL_FIELD, STARTS, ENDS, ON_COMPLETION, STATUS, EVENT_COMMENT FROM information_schema.EVENTS WHERE EVENT_SCHEMA='${r.db.replace(/'/g, "''")}' AND EVENT_NAME='${r.name.replace(/'/g, "''")}' LIMIT 1`, limit: 1 });
        const row = out.rows[0];
        if (!row) { setError(tr("db.eventNotFound")); return; }
        const statusMap: Record<string, string> = { ENABLED: "ENABLE", DISABLED: "DISABLE", SLAVESIDE_DISABLED: "DISABLE ON SLAVE" };
        const init: EventInit = {
          name: row[0] ?? r.name,
          body: row[1] ?? "SELECT 1;",
          mode: (row[2] ?? "").toUpperCase() === "ONE TIME" ? "at" : "every",
          at: row[3] ?? "CURRENT_TIMESTAMP",
          every: row[4] ?? "1",
          unit: (row[5] ?? "DAY").toUpperCase(),
          starts: row[6] ?? "",
          ends: row[7] ?? "",
          preserve: (row[8] ?? "").toUpperCase() === "PRESERVE",
          status: statusMap[(row[9] ?? "").toUpperCase()] ?? "ENABLE",
          comment: row[10] ?? "",
        };
        setEventModal({ db: r.db, mode: "edit", init });
      } catch (e) { setError(errText(e)); }
      return;
    }
    try {
      let def = "";
      let dropFirst: string | undefined;
      if (conn.driver === "mysql") {
        const kw = routineKw(r.kind);
        const out = await call<QueryOut>("db_query", { id: dbId, sql: `SHOW CREATE ${kw} \`${bq(r.db)}\`.\`${bq(r.name)}\``, limit: 1 });
        const ci = out.columns.findIndex((c) => /^create /i.test(c));
        def = out.rows[0]?.[ci >= 0 ? ci : out.columns.length - 1] ?? "";
        // SHOW CREATE không kèm tên database → chèn db vào sau từ khoá để chạy đúng chỗ.
        def = def.replace(new RegExp(`\\b${kw}\\s+\``, "i"), `${kw} \`${bq(r.db)}\`.\``);
        dropFirst = `DROP ${kw} IF EXISTS \`${bq(r.db)}\`.\`${bq(r.name)}\``;
      } else {
        const out = await call<QueryOut>("db_query", { id: dbId, sql: `SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='${r.db.replace(/'/g, "''")}' AND p.proname='${r.name.replace(/'/g, "''")}' LIMIT 1`, limit: 1 });
        def = out.rows[0]?.[0] ?? ""; // đã là CREATE OR REPLACE → không cần dropFirst
      }
      setRoutineModal({ db: r.db, name: r.name, kind: r.kind, mode: "edit", sql: def, dropFirst });
    } catch (e) { setError(errText(e)); }
  };

  /** Xoá routine (DROP) — hỏi xác nhận. */
  const dropRoutine = (r: RoutineInfo) =>
    void confirmDialog({ message: tr("db.delete2", { kind: r.kind, name: r.name }) }).then((ok) => {
      if (!ok) return;
      const sql = conn.driver === "mysql"
        ? `DROP ${routineKw(r.kind)} IF EXISTS \`${bq(r.db)}\`.\`${bq(r.name)}\``
        : `DROP ${r.kind === "procedure" ? "PROCEDURE" : "FUNCTION"} IF EXISTS "${dq(r.db)}"."${dq(r.name)}"`;
      void runRoutine(sql, r.db);
    });

  /** Đổi tên bảng (DDL khác nhau theo hệ). */
  const doRename = (t: TableInfo, newName: string) => {
    setRenaming(null);
    const n = newName.trim();
    if (!n || n === t.name) return;
    const qi = (s: string) => (conn.driver === "mysql" ? `\`${s}\`` : `"${s}"`);
    const sql = conn.driver === "mysql"
      ? `RENAME TABLE ${quote(conn, t)} TO ${t.schema ? `${qi(t.schema)}.` : ""}${qi(n)};`
      : `ALTER TABLE ${quote(conn, t)} RENAME TO ${qi(n)};`;
    void exec(sql);
  };

  /** Query trả về một giá trị text (DDL…) — lấy ô đầu tiên khớp. */
  const queryText = async (q: string, pick?: RegExp): Promise<string> => {
    const out = await call<QueryOut>("db_query", { id: dbId!, sql: q, limit: 50 });
    for (const row of out.rows) for (const cell of row) {
      if (cell == null) continue;
      if (!pick || pick.test(cell)) return cell;
    }
    return "";
  };

  /** Sinh nội dung dump SQL cho MỘT bảng (cấu trúc, tuỳ chọn kèm dữ liệu). Dùng lại cho dump cả database. */
  const buildTableDump = async (t: TableInfo, withData: boolean): Promise<string> => {
    const qi = (s: string) => (conn.driver === "mysql" ? `\`${s}\`` : `"${s}"`);
    const ref = quote(conn, t);
    let ddl = "";
    if (conn.driver === "mysql") {
      ddl = (await queryText(`SHOW CREATE TABLE ${ref}`, /CREATE TABLE/i)).trim();
    } else if (conn.driver === "sqlite") {
      ddl = (await queryText(`SELECT sql FROM sqlite_master WHERE type='table' AND name='${t.name.replace(/'/g, "''")}'`)).trim();
      if (!ddl) ddl = `CREATE TABLE ${ref} ();`;
    } else {
      // Postgres: dựng CREATE TABLE từ metadata cột.
      const rows = await call<string[]>("db_table_columns", { id: dbId!, schema: t.schema, table: t.name });
      const cols = rows.map((s) => { const [name, type, nl, def, key] = s.split("\u001f"); return { name, type, nl, def, key }; });
      const pks = cols.filter((c) => c.key === "PRI").map((c) => qi(c.name));
      const lines = cols.map((c) => `  ${qi(c.name)} ${c.type}${c.nl === "NO" ? " NOT NULL" : ""}${c.def ? ` DEFAULT ${c.def}` : ""}`);
      if (pks.length) lines.push(`  PRIMARY KEY (${pks.join(", ")})`);
      ddl = `CREATE TABLE ${ref} (\n${lines.join(",\n")}\n);`;
    }
    if (!/;\s*$/.test(ddl)) ddl += ";";

    let content = `-- ${t.schema}.${t.name}\n${ddl}\n`;
    if (withData) {
      const data = await call<QueryOut>("db_query", { id: dbId!, sql: `SELECT * FROM ${ref} LIMIT 5000`, limit: 5000 });
      if (data.columns.length && data.rows.length) {
        const esc = (v: string | null) => (v === null ? "NULL" : `'${v.replace(/'/g, "''")}'`);
        const colList = data.columns.map(qi).join(", ");
        content += "\n" + data.rows.map((r) => `INSERT INTO ${ref} (${colList}) VALUES (${r.map(esc).join(", ")});`).join("\n") + "\n";
        if (data.truncated) content += `-- (only first ${data.rows.length} rows dumped)\n`;
      }
    }
    return content;
  };

  /** Dump "struct" hoặc "struct + data" của MỘT bảng ra file .sql. */
  const dumpTable = async (t: TableInfo, withData: boolean) => {
    if (!dbId) return;
    setDumping(true);
    setError("");
    try {
      const content = `-- Dump ${t.schema}.${t.name} — ${new Date().toISOString()}\n` + (await buildTableDump(t, withData));
      const path = await saveDialog({ defaultPath: `${t.name}.sql`, filters: [{ name: "SQL", extensions: ["sql"] }] });
      if (typeof path !== "string") return;
      await invoke("write_text_file", { path, content });
      log(`db: dump ${t.name} → ${path}`);
    } catch (e) {
      setError(errText(e));
    } finally {
      setDumping(false);
    }
  };

  /** Dump TOÀN BỘ bảng của một database ra một file .sql. */
  const dumpDatabase = async (db: string, withData: boolean) => {
    if (!dbId) return;
    setDumping(true);
    setError("");
    try {
      const tables = (tablesByDb[db] ?? (await call<TableInfo[]>("db_tables", { id: dbId, schema: db }))).filter((t) => t.kind !== "view");
      // Bảng tạo theo thứ tự tên → tắt kiểm tra khoá ngoại khi import (như mysqldump); file chạy tuần tự trong MỘT phiên nên an toàn.
      const fkOff = conn.driver === "mysql" ? "SET FOREIGN_KEY_CHECKS=0;\n\n" : conn.driver === "sqlite" ? "PRAGMA foreign_keys=OFF;\n\n" : "";
      const fkOn = conn.driver === "mysql" ? "\nSET FOREIGN_KEY_CHECKS=1;\n" : conn.driver === "sqlite" ? "\nPRAGMA foreign_keys=ON;\n" : "";
      let content = `-- Dump database ${db} — ${new Date().toISOString()}\n-- ${tables.length} table(s)\n\n${fkOff}`;
      for (let i = 0; i < tables.length; i++) {
        setDumpProgress({ db, done: i, total: tables.length, table: tables[i].name });
        content += (await buildTableDump(tables[i], withData)) + "\n";
      }
      content += fkOn;
      setDumpProgress(null);
      const path = await saveDialog({ defaultPath: `${db}.sql`, filters: [{ name: "SQL", extensions: ["sql"] }] });
      if (typeof path !== "string") return;
      await invoke("write_text_file", { path, content });
      log(`db: dump database ${db} → ${path}`);
    } catch (e) {
      setError(errText(e));
    } finally {
      setDumping(false);
      setDumpProgress(null);
    }
  };

  /** Mục menu chuột phải trên một DATABASE (Open / Edit / New / Dump). */
  const databaseMenu = (db: string): CtxItem[] => {
    const isSql = conn.driver === "mysql" || conn.driver === "postgres" || conn.driver === "sqlite";
    const items: CtxItem[] = [
      { id: "open", label: tr("db.openUseForQueries"), action: () => openDb(db) },
    ];
    if (opened.has(db)) {
      items.push(expanded.has(db)
        ? { id: "collapse", label: tr("db.collapseKeepOpen"), action: () => toggleExpand(db) }
        : { id: "expand", label: tr("db.expand"), action: () => toggleExpand(db) });
      items.push({ id: "closedb", label: tr("db.closeDatabaseDisconnect"), action: () => closeDb(db) });
    }
    if (conn.driver === "mysql") {
      items.push({ id: "er", label: tr("db.erMenu"), action: () => setErDb({ db }) });
      items.push({ id: "edit", label: tr("db.editCharsetCollation"), action: () => setAlterDb(db) });
    }
    if (conn.driver === "mysql" || conn.driver === "postgres") {
      items.push({ id: "new", label: conn.driver === "postgres" ? tr("db.newSchema") : tr("db.newDatabase"), action: () => setNewDbOpen(true) });
    }
    // Tạo routine mới trong database này (procedure/function, và event với MySQL).
    if (conn.driver === "mysql" || conn.driver === "postgres") {
      items.push(
        { id: "sr", sep: true },
        { id: "newproc", label: tr("db.newProcedure"), action: () => { openDb(db); newRoutine(db, "procedure"); } },
        { id: "newfunc", label: tr("db.newFunction"), action: () => { openDb(db); newRoutine(db, "function"); } },
      );
      if (conn.driver === "mysql") {
        items.push({ id: "newevent", label: tr("db.newEventSchedule"), action: () => { openDb(db); newRoutine(db, "event"); } });
      }
    }
    if (isSql) {
      items.push(
        { id: "s1", sep: true },
        { id: "dumpStruct", label: tr("db.dumpSqlStructure"), disabled: dumping, action: () => void dumpDatabase(db, false) },
        { id: "dumpAll", label: tr("db.dumpSqlStructureData"), disabled: dumping, action: () => void dumpDatabase(db, true) },
      );
    }
    // Xoá database/schema/keyspace (DROP) — vĩnh viễn, hỏi xác nhận mạnh.
    if (conn.driver === "mysql" || conn.driver === "postgres" || conn.driver === "cassandra") {
      const dropLabel =
        conn.driver === "postgres" ? tr("db.deleteSchemaDrop")
        : conn.driver === "cassandra" ? tr("db.deleteKeyspaceDrop")
        : tr("db.deleteDatabaseDrop");
      const dropSql =
        conn.driver === "postgres" ? `DROP SCHEMA "${db.replace(/"/g, '""')}" CASCADE;`
        : conn.driver === "cassandra" ? `DROP KEYSPACE "${db.replace(/"/g, '""')}";`
        : `DROP DATABASE \`${db.replace(/`/g, "``")}\`;`;
      items.push(
        { id: "s3", sep: true },
        { id: "drop", label: dropLabel, danger: true, action: () => void confirmDialog({
          message: tr("db.permanentlyDeleteAndAllTablesData", { db }),
        }).then((ok) => {
          if (!ok) return;
          void exec(dropSql).then(() => {
            closeDb(db);
            void reloadDbs();
          });
        }) },
      );
    }
    items.push(
      { id: "s2", sep: true },
      { id: "refresh", label: tr("db.refresh"), action: () => dbIdRef.current && void loadTables(dbIdRef.current, db) },
      { id: "copy", label: tr("db.copyName"), action: () => void navigator.clipboard.writeText(db) },
    );
    return items;
  };

  /** Mục menu chuột phải trên bảng (kiểu Navicat). */
  const tableMenu = (t: TableInfo): CtxItem[] => {
    const ref = quote(conn, t);
    const truncSql = conn.driver === "sqlite" ? `DELETE FROM ${ref};` : `TRUNCATE TABLE ${ref};`;
    const ask = (msg: string, sql: string) => () =>
      void confirmDialog({ message: msg }).then((ok) => { if (ok) void exec(sql); });
    const copyItem: CtxItem = { id: "copy", label: tr("db.copyTableName"), action: () => void navigator.clipboard.writeText(t.name) };
    // Cassandra (CQL): bỏ các mục DDL/dump đặc thù SQL; giữ xem dữ liệu / cấu trúc / TRUNCATE / DROP.
    if (conn.driver === "cassandra") {
      return [
        { id: "open", label: tr("db.viewDataSelect"), action: () => openTable(t) },
        { id: "s1", sep: true },
        { id: "edit", label: tr("db.editTableStructure"), action: () => setStructT(t) },
        { id: "s2", sep: true },
        { id: "truncate", label: "Truncate…", danger: true, action: ask(tr("db.truncateTable", { name: t.name }), truncSql) },
        { id: "drop", label: tr("db.deleteTableDrop"), danger: true, action: ask(tr("db.permanentlyDeleteTableAndAllIts", { name: t.name }), `DROP TABLE ${ref};`) },
        { id: "s4", sep: true },
        copyItem,
      ];
    }
    return [
      { id: "open", label: tr("db.viewDataSelect"), action: () => openTable(t) },
      { id: "s1", sep: true },
      { id: "edit", label: tr("db.editTableStructure"), action: () => setStructT(t) },
      { id: "new", label: tr("db.newTable"), action: () => setNewTable({ schema: t.schema }) },
      { id: "col", label: tr("db.addColumn"), action: () => setDdl({ kind: "col", t }) },
      { id: "idx", label: tr("db.addIndex"), action: () => setDdl({ kind: "idx", t }) },
      ...(conn.driver === "mysql" ? [{ id: "er", label: tr("db.erMenu"), action: () => setErDb({ db: t.schema || activeDb || conn.database.trim(), focus: t.name }) }] : []),
      { id: "s2", sep: true },
      { id: "dumpStruct", label: tr("db.dumpSqlStructure"), disabled: dumping, action: () => void dumpTable(t, false) },
      { id: "dumpAll", label: tr("db.dumpSqlStructureData"), disabled: dumping, action: () => void dumpTable(t, true) },
      { id: "s3", sep: true },
      { id: "empty", label: tr("db.emptyDeleteRows"), danger: true, action: ask(tr("db.deleteAllDataIn", { name: t.name }), `DELETE FROM ${ref};`) },
      { id: "truncate", label: conn.driver === "sqlite" ? tr("db.emptySqliteHasNoTruncate") : "Truncate…", danger: true, action: ask(tr("db.truncateTable", { name: t.name }), truncSql) },
      { id: "drop", label: tr("db.deleteTableDrop"), danger: true, action: ask(tr("db.permanentlyDeleteTableAndAllIts", { name: t.name }), `DROP TABLE ${ref};`) },
      { id: "s4", sep: true },
      copyItem,
    ];
  };

  const openTable = (t: TableInfo) => {
    const q = `SELECT * FROM ${quote(conn, t)};`;
    // Không đụng tới ô soạn SQL — chạy thẳng vào bảng kết quả (phân trang tự động).
    void exec(q);
  };

  if (!dbId) {
    // Nền: màn hình chờ (spinner). Khi cần mật khẩu thì hiện MODAL nhập đè lên trên.
    const connectingScreen = (
      <div className="view">
        <div className="db-connecting">
          <span className="spinner" />
          <div>{tr("db.connectingTo")} <b>{conn.name}</b>…</div>
          <div className="muted small">{DRIVERS[conn.driver].name} · {describe(conn)}</div>
        </div>
      </div>
    );
    if (connecting || !needPw) return connectingScreen;
    return (
      <>
        {connectingScreen}
        <Modal title={tr("db.enterPassword")} width={480} onClose={() => useWorkbench.getState().closeTab(tab.id)}>
          <div className="form account-form">
            <div className="muted small">{conn.name} — {DRIVERS[conn.driver].name} · {describe(conn)}</div>
            <label>{tr("db.password")}
              <input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && connect()} />
            </label>
            <label className="check">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              {tr("db.savePassword")}
            </label>
            {error && <div className="error-box">⚠ {error}</div>}
            <div className="toolbar">
              <button onClick={() => openForm(conn.id)}>{tr("db.editConfig2")}</button>
              <span className="grow" />
              <button onClick={() => useWorkbench.getState().closeTab(tab.id)}>{tr("db.cancel")}</button>
              <button className="primary" disabled={connecting} onClick={() => connect()}>{connecting ? tr("db.connecting") : tr("db.connect")}</button>
            </div>
          </div>
        </Modal>
      </>
    );
  }

  /* ── Gợi ý SQL: dựng danh sách từ dữ liệu đã tải ── */
  const allTables = Object.values(tablesByDb).flat();
  const allCols = Object.values(colsByDb).flat();

  const updateSug = (el: HTMLTextAreaElement) => {
    const pos = el.selectionStart;
    const before = el.value.slice(0, pos);
    const m = before.match(/([A-Za-z0-9_$]+\.[A-Za-z0-9_$]*|[A-Za-z0-9_$]*)$/);
    if (!m) return setSug(null);
    const token = m[0];
    if (token === "") return setSug(null);
    const start = pos - token.length;
    const dot = token.lastIndexOf(".");
    const qualifier = dot >= 0 ? token.slice(0, dot).toLowerCase() : null;
    const prefix = (dot >= 0 ? token.slice(dot + 1) : token).toLowerCase();

    const items: Sug[] = [];
    const seen = new Set<string>();
    const push = (s: Sug) => { const k = s.kind + s.label.toLowerCase(); if (!seen.has(k)) { seen.add(k); items.push(s); } };

    if (qualifier) {
      // Sau "bảng." → chỉ cột của bảng đó.
      for (const c of allCols) if (c.table.toLowerCase() === qualifier) push({ label: c.column, kind: "col", hint: c.table });
    } else {
      for (const t of allTables) push({ label: t.name, kind: "table", hint: t.schema });
      for (const c of allCols) push({ label: c.column, kind: "col", hint: c.table });
      for (const d of dbs) push({ label: d, kind: "db", hint: "database" });
      for (const w of SQL_WORDS) push({ label: w, kind: "kw" });
    }

    // Bảng / cột / database khớp kiểu CONTAINS (gõ "order" ra cả "sale_order", "order_item"); từ khoá SQL chỉ khớp
    // tiền tố (contains với từ khoá rất nhiễu: "or" → ORDER, FOR…). Xếp: khớp đúng → khớp đầu → khớp giữa
    // (vị trí càng sớm càng trên), cùng mức thì giữ ưu tiên bảng → cột → database → từ khoá.
    const ranked: { s: Sug; rank: number; order: number }[] = [];
    items.forEach((s, order) => {
      const l = s.label.toLowerCase();
      const at = l.indexOf(prefix);
      if (at < 0 || (s.kind === "kw" && at > 0)) return;
      ranked.push({ s, order, rank: l === prefix ? 0 : at === 0 ? 1 : 2 + at });
    });
    const KIND = { table: 0, col: 1, db: 2, kw: 3 } as const;
    ranked.sort((a, b) => (Math.min(a.rank, 2) - Math.min(b.rank, 2)) || (KIND[a.s.kind] - KIND[b.s.kind]) || (a.rank - b.rank) || (a.order - b.order));
    const matched = ranked.slice(0, 20).map((r) => r.s);
    if (!matched.length) return setSug(null);
    const { x, y } = caretXY(el, pos);
    setSug({ items: matched, x, y, start, end: pos, q: prefix });
    setSugIdx(0);
  };

  const acceptSug = (i: number) => {
    if (!sug) return;
    const el = editor.current;
    const it = sug.items[i];
    if (!el || !it) return setSug(null);
    // Chọn xong thêm dấu cách để gõ tiếp; ngay sau đã có khoảng trắng thì chỉ đưa con trỏ qua nó (không nhân đôi).
    const rest = el.value.slice(sug.end);
    const gap = /^\s/.test(rest) ? "" : " ";
    const next = el.value.slice(0, sug.start) + it.label + gap + rest;
    const caret = sug.start + it.label.length + 1;
    setSql(next);
    setSug(null);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(caret, caret); });
  };

  const fl = filter.trim().toLowerCase();
  const tablesOf = (db: string) => (tablesByDb[db] ?? []).filter((t) => !fl || t.name.toLowerCase().includes(fl));
  // Khi đang lọc: ẩn db không khớp tên và không có bảng khớp (đã tải).
  const shownDbs = dbs.filter((db) => !fl || db.toLowerCase().includes(fl) || tablesOf(db).length > 0);
  // Config đã chỉ đích danh 1 database → bỏ node database ở gốc, hiện thẳng danh sách bảng.
  const singleDb = conn.database.trim() !== "" && dbs.length === 1 ? dbs[0] : null;

  /** Một hàng bảng (dùng cho cả cây lẫn danh sách phẳng khi chỉ có 1 db). */
  const tableRow = (t: TableInfo, padLeft: number) =>
    renaming && renaming.t.schema === t.schema && renaming.t.name === t.name ? (
      <div key={`${t.schema}.${t.name}`} className="side-item" style={{ paddingLeft: padLeft }} onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          className="tree-rename grow"
          value={renaming.name}
          onChange={(e) => setRenaming({ t, name: e.target.value })}
          onBlur={() => doRename(t, renaming.name)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); doRename(t, renaming.name); } if (e.key === "Escape") setRenaming(null); }}
        />
      </div>
    ) : (
      <div key={`${t.schema}.${t.name}`} className={`side-item ${selTable?.schema === t.schema && selTable?.name === t.name ? "sel" : ""}`} style={{ paddingLeft: padLeft }}
        tabIndex={0}
        onClick={() => setSelTable(t)}
        onDoubleClick={() => openTable(t)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); openTable(t); }
          else if (e.key === "F2" && conn.driver !== "cassandra") { e.preventDefault(); setRenaming({ t, name: t.name }); }
        }}
        onContextMenu={(e) => { e.preventDefault(); setSelTable(t); setTblMenu({ x: e.clientX, y: e.clientY, t }); }}
        title={`${t.schema}.${t.name} — ${tr("db.tableRowHint")}`}>
        <span style={{ display: "inline-flex", alignItems: "center" }}>{t.kind === "view" ? "👁" : <TableIcon />}</span>
        <span className="grow ellipsis">{t.name}</span>
      </div>
    );

  /** Một nhóm gập được trong cây (header .tree-row.sub + danh sách con). */
  const section = (
    key: string, pad: number, defOpen: boolean, icon: ReactNode, label: string,
    count: number, children: ReactNode, onNew?: () => void,
  ) => {
    const open = (!!fl && count > 0) || secOpen(key, defOpen);
    return (
      <div key={key}>
        <div className="tree-row sub" style={{ paddingLeft: pad }} onClick={() => toggleSec(key, defOpen)}
          onContextMenu={onNew ? (e) => { e.preventDefault(); onNew(); } : undefined}
          title={onNew ? tr("db.rightClickNew") : undefined}>
          <span className="tree-caret">{open ? "▾" : "▸"}</span>
          <span className="routine-ic">{icon}</span>
          <span className="grow ellipsis muted small">{label}</span>
          <span className="muted small">{count}</span>
        </div>
        {open && children}
      </div>
    );
  };

  /** Một hàng routine. */
  const routineRow = (r: RoutineInfo, pad: number) => (
    <div key={`${r.kind}.${r.name}`} className="side-item" style={{ paddingLeft: pad }} tabIndex={0}
      onDoubleClick={() => void openRoutine(r)}
      onContextMenu={(e) => { e.preventDefault(); setRoutineMenu({ x: e.clientX, y: e.clientY, r }); }}
      title={`${r.name} — ${tr("db.doubleClickToViewEditRight")}`}>
      <span className="routine-ic">{ROUTINE_ICON[r.kind]}</span>
      <span className="grow ellipsis">{r.name}</span>
    </div>
  );

  /** Toàn bộ nhóm con của một database: Tables / Views / Procedures / Functions / Events. */
  const dbChildren = (db: string, pad: number): ReactNode => {
    const ip = pad + 16; // thụt vào của item trong nhóm
    const all = tablesOf(db);
    const tables = all.filter((t) => t.kind !== "view");
    const views = all.filter((t) => t.kind === "view");
    const list = routinesByDb[db];
    const canRoutine = conn.driver === "mysql" || conn.driver === "postgres";
    const kinds: RoutineKind[] = conn.driver === "postgres" ? ["procedure", "function"] : ["procedure", "function", "event"];
    const rlabel: Record<RoutineKind, string> = { procedure: tr("db.procedures"), function: tr("db.functions"), event: tr("db.events") };
    return (
      <>
        {(!fl || tables.length > 0) && section(`${db}|tables`, pad, true, <TableIcon />, tr("db.tables"), tables.length, tables.map((t) => tableRow(t, ip)))}
        {views.length > 0 && section(`${db}|views`, pad, true, "👁", tr("db.views"), views.length, views.map((t) => tableRow(t, ip)))}
        {canRoutine && list && kinds.map((kind) => {
          const items = list.filter((r) => r.kind === kind && (!fl || r.name.toLowerCase().includes(fl)));
          if (fl && !items.length) return null;
          return section(`${db}|${kind}`, pad, false, ROUTINE_ICON[kind], rlabel[kind], items.length, items.map((r) => routineRow(r, ip)), () => newRoutine(db, kind));
        })}
      </>
    );
  };

  return (
    <div
      className="db-session"
      onKeyDown={(e) => {
        // Ctrl+R chạy câu lệnh khi focus ở bất kỳ đâu trong vùng làm việc (không riêng ô soạn SQL).
        if (e.defaultPrevented) return;
        if ((e.ctrlKey || e.metaKey) && (e.key === "r" || e.key === "R")) { e.preventDefault(); runEditor(); }
      }}
    >
      <div className="db-tables" style={{ width: tablesW, flex: "0 0 auto" }}>
        <input
          placeholder={singleDb ? tr("db.filterTablesIn", { singleDb }) : tr("db.filterInDatabases", { dbsLength: dbs.length })}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <div
          className="db-table-list"
          onContextMenu={(e) => {
            // Hàng con (bảng, routine, nhóm…) đã tự mở menu riêng (preventDefault) → không mở thêm menu database đè lên.
            if (!singleDb || e.defaultPrevented) return;
            e.preventDefault();
            setDbMenu({ x: e.clientX, y: e.clientY, db: singleDb });
          }}
        >
          {singleDb ? (
            // Đã chỉ đích danh db trong cấu hình → hiện nhóm (Tables/Views/…), không có node database.
            loadingDbs.has(singleDb) && !tablesByDb[singleDb]
              ? <div className="muted small pad">{tr("db.loading")}</div>
              : dbChildren(singleDb, 8)
          ) : (
            <>
              {shownDbs.map((db) => (
                <div key={db}>
                  <div
                    className={`tree-row ${db === activeDb ? "active-db" : ""} ${selDb === db ? "sel" : ""}`}
                    onClick={() => setSelDb(db)}
                    onDoubleClick={() => (opened.has(db) ? toggleExpand(db) : openDb(db))}
                    onContextMenu={(e) => { e.preventDefault(); setSelDb(db); setDbMenu({ x: e.clientX, y: e.clientY, db }); }}
                    title={`${db} — ${opened.has(db) ? tr("db.doubleClickToCollapseExpandRight") : tr("db.doubleClickToOpenUse")}`}
                  >
                    {opened.has(db)
                      ? <span className="tree-caret" onClick={(e) => { e.stopPropagation(); toggleExpand(db); }} title={expanded.has(db) ? tr("db.collapse") : tr("db.expand")}>{expanded.has(db) ? "▾" : "▸"}</span>
                      : <span className="tree-caret" />}
                    <span className="tree-icon"><DbIcon /></span>
                    <span className="grow ellipsis">{db}</span>
                    {db === activeDb && <span className="env-tag use" title={tr("db.currentQueryDatabase")}>USE</span>}
                    {tablesByDb[db] && <span className="muted small">{tablesByDb[db].length}</span>}
                  </div>
                  {expanded.has(db) && (
                    loadingDbs.has(db) && !tablesByDb[db]
                      ? <div className="muted small pad" style={{ paddingLeft: 24 }}>{tr("db.loading")}</div>
                      : dbChildren(db, 22)
                  )}
                </div>
              ))}
              {!dbs.length && <div className="muted small pad">{tr("db.noDatabases")}</div>}
            </>
          )}
        </div>
        {selTable && dbId && (
          <TableInfoPanel
            conn={conn}
            dbId={dbId}
            table={selTable}
            onOpen={() => openTable(selTable)}
            onStructure={() => setStructT(selTable)}
            onClose={() => setSelTable(null)}
          />
        )}
      </div>
      <Splitter axis="x" onResize={(d) => setTablesW((w) => w + d)} onReset={() => setTablesW(220)} />
      <div className="view">
        <div className="toolbar db-toolbar">
          <span className="dot green" /> {describe(conn)}
          {dumpProgress && (
            <span className="db-progress" title={dumpProgress.table}>
              <span className="update-bar"><span style={{ width: `${(dumpProgress.done / Math.max(1, dumpProgress.total)) * 100}%` }} /></span>
              {tr("db.dumpProgress", { db: dumpProgress.db, done: dumpProgress.done, total: dumpProgress.total, table: dumpProgress.table })}
            </span>
          )}
          {dbs.length > 0 && conn.driver !== "sqlite" && (
            <span className="db-active" title={tr("db.databaseUsedToRunQueriesUse")}>
              <Picker
                label={<><span className="tree-icon"><DbIcon /></span> {activeDb || tr("db.default")}</>}
                items={dbs.map((d) => ({ id: d, label: d, selected: d === activeDb }))}
                onPick={(d) => { setSelDb(d); openDb(d); }}
                filterPlaceholder={tr("db.filterDatabases")}
              />
            </span>
          )}
          <span className="grow" />
          <Picker
            label={<>📑 {curQueryName || tr("db.queries")}{savedQueries.length ? ` (${savedQueries.length})` : ""}</>}
            title={tr("db.savedQueriesForThisConnectionPick")}
            items={savedQueries.length
              ? savedQueries.map((q) => ({ id: q.id, label: q.name, selected: q.name === curQueryName }))
              : [{ id: "__none__", label: tr("db.noSavedQueries"), disabled: true }]}
            onPick={(id) => { const q = savedQueries.find((x) => x.id === id); if (q) { setSql(q.sql); setCurQueryName(q.name); } }}
            onItemContextMenu={(id, e) => { if (id === "__none__") return; setQMenu({ x: e.clientX, y: e.clientY, id }); }}
            filterPlaceholder={tr("db.filterQueries")}
          />
          <button
            onClick={() => { if (!sql.trim()) return; setSaveName(curQueryName || deriveQueryName(sql)); }}
            disabled={!sql.trim()}
            title={tr("db.saveCurrentSqlAsANamed")}
          >💾 {tr("db.save")}</button>
          {conn.driver !== "cassandra" && (
            <button onClick={() => setSyncOpen(true)} title={tr("db.syncStructureBetweenDatabasesPickServer")}>⇄ Struct sync</button>
          )}
          <label className="db-timeout" title={tr("db.statementTimeoutInSeconds0Unlimited")}>
            ⏱
            <input
              type="number"
              min={0}
              value={timeoutSecs}
              onChange={(e) => { const v = Math.max(0, Number(e.target.value) || 0); setTimeoutSecs(v); localStorage.setItem("db.timeoutSecs", String(v)); }}
            />s
          </label>
          {conn.driver !== "cassandra" && (
            <button disabled={running} onClick={runExplain} title={tr("db.showExecutionPlanOfSelectedStatement")}>EXPLAIN</button>
          )}
          {running
            ? <button className="danger" onClick={cancelRun} title={tr("db.stopTheRunningStatement")}>■ {tr("db.cancel2")}</button>
            : <button className="primary" onClick={runEditor} title={tr("db.runCtrlEnterCtrlRSelect")}>{tr("db.run")}</button>}
        </div>
        <textarea
          ref={editor}
          className="db-editor mono"
          value={sql}
          spellCheck={false}
          placeholder={tr("db.selectCtrlEnterOrCtrlR")}
          onChange={(e) => { setSql(e.target.value); updateSug(e.currentTarget); }}
          onClick={(e) => updateSug(e.currentTarget)}
          onBlur={() => setSug(null)}
          onKeyDown={(e) => {
            // Điều hướng popup gợi ý khi đang mở.
            if (sug && sug.items.length) {
              if (e.key === "ArrowDown") { e.preventDefault(); setSugIdx((i) => (i + 1) % sug.items.length); return; }
              if (e.key === "ArrowUp") { e.preventDefault(); setSugIdx((i) => (i - 1 + sug.items.length) % sug.items.length); return; }
              if (e.key === "Tab" || (e.key === "Enter" && !e.ctrlKey && !e.metaKey)) { e.preventDefault(); acceptSug(sugIdx); return; }
              if (e.key === "Escape") { e.preventDefault(); setSug(null); return; }
            }
            if ((e.ctrlKey || e.metaKey) && (e.key === "Enter" || e.key === "r" || e.key === "R")) {
              e.preventDefault();
              runEditor();
            }
          }}
        />
        {sug && sug.items.length > 0 && (
          <div
            className="sql-sug"
            style={{
              left: Math.min(sug.x, window.innerWidth - 280),
              top: Math.min(sug.y, window.innerHeight - 260),
            }}
          >
            {sug.items.map((it, i) => (
              <div
                key={`${it.kind}:${it.label}:${i}`}
                className={`sug-item ${i === sugIdx ? "on" : ""}`}
                onMouseDown={(e) => { e.preventDefault(); acceptSug(i); }}
                onMouseEnter={() => setSugIdx(i)}
              >
                <span className={`sug-kind ${it.kind}`}>{it.kind === "table" ? "▦" : it.kind === "col" ? "▪" : it.kind === "db" ? "🗃" : "K"}</span>
                <span className="grow ellipsis">{hlMatch(it.label, sug.q)}</span>
                {it.hint && <span className="muted small ellipsis">{it.hint}</span>}
              </div>
            ))}
          </div>
        )}
        {confirmSql && (
          <div className="error-box toolbar">
            {tr("db.thisIsAProdConnectionAnd")}
            <span className="grow" />
            <button onClick={() => setConfirmSql(null)}>{tr("db.cancel")}</button>
            <button className="primary danger" onClick={() => exec(confirmSql, true)}>{tr("db.runOnProd")}</button>
          </div>
        )}
        {error && <div className="error-box">⚠ {error}</div>}
        {results.length > 1 ? (
          <div className="results-list">
            {results.map((o, i) => (
              <ResultGrid key={i} out={o} title={`${tr("db.result")} ${i + 1}/${results.length}`} editor={gridEditor} pager={gridPager} />
            ))}
          </div>
        ) : results.length === 1 ? (
          <ResultGrid out={results[0]} editor={gridEditor} pager={gridPager} />
        ) : (
          !error && <ResultGrid out={null} />
        )}
      </div>
      {tblMenu && (
        <ContextMenu
          x={tblMenu.x}
          y={tblMenu.y}
          items={tableMenu(tblMenu.t)}
          onClose={() => setTblMenu(null)}
        />
      )}
      {dbMenu && (
        <ContextMenu
          x={dbMenu.x}
          y={dbMenu.y}
          items={databaseMenu(dbMenu.db)}
          onClose={() => setDbMenu(null)}
        />
      )}
      {newDbOpen && (
        <NewDbModal
          conn={conn}
          dbId={dbId}
          onClose={() => setNewDbOpen(false)}
          onRun={(q) => { void exec(q).then(() => void reloadDbs()); }}
        />
      )}
      {erDb && dbId && (
        <Suspense fallback={null}>
          <ErDiagram
            dbId={dbId}
            connKey={conn.id}
            db={erDb.db}
            focus={erDb.focus}
            onClose={() => setErDb(null)}
            onOpenTable={(name) => { const db = erDb.db; setErDb(null); openTable({ schema: db, name, kind: "table" }); }}
          />
        </Suspense>
      )}
      {alterDb !== null && (
        <AlterDbModal
          conn={conn}
          db={alterDb}
          dbId={dbId}
          onClose={() => setAlterDb(null)}
          onRun={(q) => { void exec(q); }}
        />
      )}
      {ddl && (
        <DdlModal
          kind={ddl.kind}
          conn={conn}
          table={ddl.t}
          onClose={() => setDdl(null)}
          onRun={(q) => void exec(q)}
        />
      )}
      {structT && dbId && (
        <TableStructModal
          dbId={dbId}
          table={structT}
          onClose={() => setStructT(null)}
          onAddColumn={() => { setDdl({ kind: "col", t: structT }); setStructT(null); }}
        />
      )}
      {newTable && (
        <NewTableModal
          conn={conn}
          schema={newTable.schema}
          onClose={() => setNewTable(null)}
          onRun={(q) => { void exec(q); }}
        />
      )}
      {syncOpen && dbId && (
        <StructSyncModal
          current={{ conn, dbId }}
          conns={allConns}
          onClose={() => setSyncOpen(false)}
          onReloadSession={() => void reloadDbs()}
        />
      )}
      {routineMenu && (
        <ContextMenu
          x={routineMenu.x}
          y={routineMenu.y}
          onClose={() => setRoutineMenu(null)}
          items={[
            { id: "view", label: tr("db.viewEditDefinition"), action: () => void openRoutine(routineMenu.r) },
            { id: "copy", label: tr("db.copyName"), action: () => void navigator.clipboard.writeText(routineMenu.r.name) },
            { id: "s1", sep: true },
            { id: "drop", label: tr("db.deleteDrop"), danger: true, action: () => dropRoutine(routineMenu.r) },
          ] as CtxItem[]}
        />
      )}
      {routineModal && (
        <RoutineModal
          info={routineModal}
          driver={conn.driver}
          running={running}
          onClose={() => setRoutineModal(null)}
          onRun={(sql) => void runRoutine(sql, routineModal.db, routineModal.mode === "edit" ? routineModal.dropFirst : undefined)}
        />
      )}
      {eventModal && (
        <EventModal
          db={eventModal.db}
          mode={eventModal.mode}
          init={eventModal.init}
          running={running}
          onClose={() => setEventModal(null)}
          onRun={(sql, origName) => void runRoutine(sql, eventModal.db, eventModal.mode === "edit" && origName ? `DROP EVENT IF EXISTS \`${bq(eventModal.db)}\`.\`${bq(origName)}\`` : undefined)}
          onRawEdit={(sql) => { const db = eventModal.db; setEventModal(null); setRoutineModal({ db, name: eventModal.init?.name ?? "new_event", kind: "event", mode: "new", sql }); }}
        />
      )}
      {qMenu && (
        <ContextMenu
          x={qMenu.x}
          y={qMenu.y}
          onClose={() => setQMenu(null)}
          items={(() => {
            const q = savedQueries.find((x) => x.id === qMenu.id);
            if (!q) return [];
            return [
              { id: "load", label: tr("db.loadIntoEditor"), action: () => { setSql(q.sql); setCurQueryName(q.name); } },
              { id: "rename", label: tr("db.rename2"), action: () => setRenameQ({ id: q.id, name: q.name }) },
              { id: "s1", sep: true },
              { id: "del", label: tr("db.deleteQuery"), danger: true, action: () => void confirmDialog({ message: tr("db.deleteSavedQuery", { name: q.name }) }).then((ok) => { if (ok) { removeQuery(q.id); if (curQueryName === q.name) setCurQueryName(""); } }) },
            ] as CtxItem[];
          })()}
        />
      )}
      {saveName !== null && (
        <Modal title={tr("db.saveQuery")} width={440} onClose={() => setSaveName(null)}>
          <div className="form account-form">
            <label>{tr("db.name")}
              <input
                autoFocus
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && saveName.trim()) { saveQuery(connId, saveName.trim(), sql); setCurQueryName(saveName.trim()); setSaveName(null); } }}
                placeholder={tr("db.eGActiveUsersReport")}
              />
            </label>
            {savedQueries.some((q) => q.name === saveName.trim()) && (
              <div className="muted small">{tr("db.aQueryWithThisNameExists")}</div>
            )}
            <div className="toolbar">
              <span className="grow" />
              <button onClick={() => setSaveName(null)}>{tr("db.cancel")}</button>
              <button className="primary" disabled={!saveName.trim()} onClick={() => { saveQuery(connId, saveName.trim(), sql); setCurQueryName(saveName.trim()); setSaveName(null); }}>{tr("db.save")}</button>
            </div>
          </div>
        </Modal>
      )}
      {renameQ && (
        <Modal title={tr("db.renameQuery")} width={440} onClose={() => setRenameQ(null)}>
          <div className="form account-form">
            <label>{tr("db.name")}
              <input
                autoFocus
                value={renameQ.name}
                onChange={(e) => setRenameQ({ ...renameQ, name: e.target.value })}
                onKeyDown={(e) => { if (e.key === "Enter" && renameQ.name.trim()) { const old = savedQueries.find((x) => x.id === renameQ.id); renameQuery(renameQ.id, renameQ.name.trim()); if (old && curQueryName === old.name) setCurQueryName(renameQ.name.trim()); setRenameQ(null); } }}
              />
            </label>
            <div className="toolbar">
              <span className="grow" />
              <button onClick={() => setRenameQ(null)}>{tr("db.cancel")}</button>
              <button className="primary" disabled={!renameQ.name.trim()} onClick={() => { const old = savedQueries.find((x) => x.id === renameQ.id); renameQuery(renameQ.id, renameQ.name.trim()); if (old && curQueryName === old.name) setCurQueryName(renameQ.name.trim()); setRenameQ(null); }}>{tr("db.rename")}</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* Memo: bảng kết quả có thể rất lớn — không vẽ lại mỗi lần gõ phím trong ô SQL (out không đổi). */
/** Số dòng vẽ ngay ở lần đầu; phần còn lại vẽ ở khung hình sau → kết quả lớn hiện tức thì, không khựng. */
const FIRST_ROWS = 120;

/** Bảng nguồn + khoá chính của một kết quả (sửa được), hoặc lý do chỉ đọc. */
type EditTarget =
  | { ok: true; tableRef: string; pkCols: string[]; tableCols: Set<string> }
  | { ok: false; reason: string };

/** Session cung cấp cho lưới: xác định bảng nguồn + chạy các câu UPDATE khi Save. */
interface GridEditor {
  driver: GridDriver;
  /** null = không phải SELECT (không hiện gì về sửa). */
  resolve: (sql: string) => Promise<EditTarget | null>;
  /** Chạy lần lượt; `done` = số câu đã xong (dừng ở câu lỗi), `zero` = số câu không khớp dòng nào. */
  save: (stmts: string[]) => Promise<{ done: number; zero: number; error?: string; cancelled?: boolean }>;
}

/** Session cung cấp cho lưới: lấy một trang khác / đếm tổng / nhớ cỡ trang. */
interface GridPager {
  fetch: (pg: NonNullable<QueryOut["paging"]>, page: number, size: number) => Promise<QueryOut>;
  count: (base: string) => Promise<number>;
  setDefaultSize: (n: number) => void;
}
const PAGE_SIZES = [100, 200, 500, 1000];

const ResultGrid = memo(function ResultGrid({ out: initial, title, editor, pager }: {
  out: QueryOut | null; title?: string; editor?: GridEditor; pager?: GridPager;
}) {
  const tr = useT();
  // Trang đang xem: sau khi chuyển trang thì thay cho kết quả ban đầu (gắn với đúng `initial`).
  const [view, setView] = useState<{ src: QueryOut | null; out: QueryOut | null }>({ src: null, out: null });
  const out = view.src === initial && view.out ? view.out : initial;
  const [pageBusy, setPageBusy] = useState(false);
  const [total, setTotal] = useState<{ base: string; n: number | null; busy: boolean } | null>(null);

  // Gắn số dòng đã vẽ với đúng kết quả `out` → kết quả mới luôn bắt đầu lại từ FIRST_ROWS.
  const [painted, setPainted] = useState<{ out: QueryOut | null; n: number }>({ out: null, n: FIRST_ROWS });
  const shown = painted.out === out ? painted.n : FIRST_ROWS;
  useEffect(() => {
    if (!out || out.rows.length <= FIRST_ROWS) return;
    const id = setTimeout(() => setPainted({ out, n: out.rows.length }), 16);
    return () => clearTimeout(id);
  }, [out]);

  /* ── Sửa dữ liệu trên lưới (kiểu Navicat) ── */
  const [target, setTarget] = useState<{ out: QueryOut | null; t: EditTarget | null }>({ out: null, t: null });
  const [base, setBase] = useState<{ out: QueryOut | null; rows: (string | null)[][] }>({ out: null, rows: [] });
  const [edits, setEdits] = useState<GridEdits>(new Map());
  const [editing, setEditing] = useState<{ r: number; c: number } | null>(null);
  const typed = useRef(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const [cellMenu, setCellMenu] = useState<{ x: number; y: number; r: number; c: number } | null>(null);

  useEffect(() => {
    setEdits(new Map());
    setEditing(null);
    setNote(null);
    if (!out || !editor || !out.sql || !out.columns.length) { setTarget({ out, t: null }); return; }
    let alive = true;
    void editor.resolve(out.sql).then((t) => { if (alive) setTarget({ out, t }); });
    return () => { alive = false; };
  }, [out, editor]);

  if (!out) return <div className="pane"><div className="empty">{tr("db.resultsAppearHere")}</div></div>;

  const rows = base.out === out ? base.rows : out.rows;
  const t = target.out === out ? target.t : null;
  const pkMissing = t?.ok ? t.pkCols.filter((pk) => !out.columns.includes(pk)) : [];
  const canEditAny = !!t?.ok && !pkMissing.length && !saving;
  const editable = (c: number) => {
    const name = out.columns[c];
    return canEditAny && !!t?.ok && t.tableCols.has(name) && out.columns.indexOf(name) === out.columns.lastIndexOf(name);
  };
  const cellValue = (r: number, c: number) => (edits.get(r)?.has(c) ? edits.get(r)!.get(c)! : rows[r][c]);
  const nChanges = [...edits.values()].reduce((n, m) => n + m.size, 0);

  const setCell = (r: number, c: number, v: string | null) => {
    setEdits((prev) => {
      const next = new Map(prev);
      const row = new Map(next.get(r) ?? []);
      if (v === rows[r][c]) row.delete(c); else row.set(c, v);
      if (row.size) next.set(r, row); else next.delete(r);
      return next;
    });
  };
  const nextEditable = (c: number, dir: 1 | -1) => {
    for (let j = c + dir; j >= 0 && j < out.columns.length; j += dir) if (editable(j)) return j;
    return -1;
  };
  const commit = (r: number, c: number, value: string, move?: 1 | -1) => {
    // Ô gốc NULL mà chưa gõ gì → giữ NULL (không biến thành chuỗi rỗng chỉ vì mở ô rồi thoát).
    if (typed.current) setCell(r, c, value);
    typed.current = false;
    const nc = move ? nextEditable(c, move) : -1;
    setEditing(nc >= 0 ? { r, c: nc } : null);
  };

  const save = async () => {
    if (!t?.ok || !editor || !nChanges) return;
    const stmts = buildUpdates({ driver: editor.driver, tableRef: t.tableRef, columns: out.columns, rows, edits, pkCols: t.pkCols });
    setSaving(true);
    setNote(null);
    const res = await editor.save(stmts.map((x) => x.sql));
    setSaving(false);
    if (res.cancelled) return;
    // Dòng đã lưu xong → gộp giá trị mới vào dữ liệu gốc; dòng chưa lưu (lỗi giữa chừng) giữ nguyên ô sửa.
    const okRows = new Set(stmts.slice(0, res.done).map((x) => x.row));
    setBase({ out, rows: rows.map((row, i) => (okRows.has(i) ? row.map((v, c) => (edits.get(i)?.has(c) ? edits.get(i)!.get(c)! : v)) : row)) });
    setEdits((prev) => { const next = new Map(prev); okRows.forEach((r) => next.delete(r)); return next; });
    if (res.error) setNote({ kind: "error", text: tr("db.saveFailedAt", { i: res.done + 1, n: stmts.length, msg: res.error }) });
    else if (res.zero) setNote({ kind: "info", text: tr("db.savedZeroRows", { n: stmts.length, zero: res.zero }) });
    else setNote({ kind: "info", text: tr("db.savedRows", { n: stmts.length }) });
  };

  /* ── Phân trang phía server ── */
  const pg = out.paging;
  const offset = pg ? pg.page * pg.size : 0;
  const tot = pg && total && total.base === pg.base ? total : null;
  const lastPage = pg && tot?.n != null ? Math.max(0, Math.ceil(tot.n / pg.size) - 1) : null;
  const goPage = async (page: number, size = pg?.size ?? 200) => {
    if (!pager || !pg || nChanges || pageBusy) return;
    setPageBusy(true);
    setNote(null);
    try {
      const res = await pager.fetch(pg, Math.max(0, page), size);
      setView({ src: initial, out: res });
    } catch (e) {
      setNote({ kind: "error", text: errText(e) });
    } finally {
      setPageBusy(false);
    }
  };
  const countAll = async () => {
    if (!pager || !pg) return;
    setTotal({ base: pg.base, n: null, busy: true });
    try {
      const n = await pager.count(pg.base);
      setTotal({ base: pg.base, n, busy: false });
    } catch (e) {
      setTotal(null);
      setNote({ kind: "error", text: errText(e) });
    }
  };
  const lockTitle = nChanges ? tr("db.pageSaveFirst") : undefined;

  const info = out.columns.length
    ? pg
      ? tr("db.pageRows", { from: rows.length ? offset + 1 : 0, to: offset + rows.length }) + (tot?.n != null ? ` ${tr("db.pageOfTotal", { total: tot.n })}` : "")
      : out.truncated
        ? tr("db.gridRowCountTruncated", { n: out.rows.length, limit: ROW_LIMIT })
        : tr("db.gridRowCount", { n: out.rows.length })
    : tr("db.gridRowsAffected", { n: out.rowsAffected });
  const readOnlyReason = t && !t.ok ? t.reason : pkMissing.length ? tr("db.roPkMissing", { cols: pkMissing.join(", ") }) : "";

  return (
    <div className="pane result-pane">
      <div className="pane-title">
        {title && <b className="muted">{title} · </b>}{info} · {out.elapsedMs} ms
        {nChanges > 0 ? (
          <>
            <span className="grid-dirty">· {tr("db.gridChanges", { n: nChanges })}</span>
            <span className="grow" />
            <button disabled={saving} onClick={() => { setEdits(new Map()); setEditing(null); setNote(null); }}>↺ {tr("db.gridDiscard")}</button>
            <button className="primary" disabled={saving} onClick={() => void save()}>💾 {saving ? tr("db.gridSaving") : tr("db.gridSave")}</button>
          </>
        ) : (
          <>
            {canEditAny && <span className="muted grid-hint"> · ✎ {tr("db.gridEditHint")}</span>}
            {readOnlyReason && <span className="muted grid-hint" title={readOnlyReason}> · 🔒 {tr("db.gridReadOnly", { reason: readOnlyReason })}</span>}
            <span className="grow" />
          </>
        )}
        {out.columns.length > 0 && (
          <button onClick={() => navigator.clipboard.writeText(toTsv({ ...out, rows }))} title={tr("db.pasteIntoExcel")}>Copy (TSV)</button>
        )}
      </div>
      {note && <div className={note.kind === "error" ? "error-box pre grid-note" : "muted small grid-note"}>{note.text}</div>}
      {out.columns.length > 0 ? (
        <div className={`grid-wrap${pageBusy ? " busy" : ""}`}>
          <table className="grid mono">
            <thead>
              <tr><th>#</th>{out.columns.map((c, i) => <th key={i}>{c}</th>)}</tr>
            </thead>
            <tbody>
              {(shown < rows.length ? rows.slice(0, shown) : rows).map((r, i) => (
                <tr key={i}>
                  <td className="muted">{offset + i + 1}</td>
                  {r.map((_, j) => {
                    if (editing && editing.r === i && editing.c === j) {
                      const cur = cellValue(i, j);
                      return (
                        <td key={j} className="cell editing">
                          <input
                            autoFocus
                            className="cell-input mono"
                            defaultValue={cur ?? ""}
                            placeholder={cur === null ? "NULL" : undefined}
                            onFocus={(e) => { typed.current = false; e.currentTarget.select(); }}
                            onChange={() => { typed.current = true; }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") { e.preventDefault(); commit(i, j, e.currentTarget.value); }
                              else if (e.key === "Tab") { e.preventDefault(); commit(i, j, e.currentTarget.value, e.shiftKey ? -1 : 1); }
                              else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); typed.current = false; setEditing(null); }
                            }}
                            onBlur={(e) => { if (editing && editing.r === i && editing.c === j) commit(i, j, e.currentTarget.value); }}
                          />
                        </td>
                      );
                    }
                    const v = cellValue(i, j);
                    const edited = !!edits.get(i)?.has(j);
                    return (
                      <td
                        key={j}
                        className={`${v === null ? "null" : "cell"}${edited ? " edited" : ""}${editable(j) ? " editable" : ""}`}
                        title={v !== null && v.length > 40 ? v : undefined}
                        onDoubleClick={editable(j) ? () => setEditing({ r: i, c: j }) : undefined}
                        onContextMenu={(e) => { e.preventDefault(); setCellMenu({ x: e.clientX, y: e.clientY, r: i, c: j }); }}
                      >
                        {v === null ? "NULL" : v}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty">{tr("db.gridDone")}</div>
      )}
      {pg && out.columns.length > 0 && (
        <div className="grid-pager">
          <button className="icon-btn" title={lockTitle ?? tr("db.pageFirst")} disabled={pageBusy || pg.page === 0 || nChanges > 0} onClick={() => void goPage(0)}>⏮</button>
          <button className="icon-btn" title={lockTitle ?? tr("db.pagePrev")} disabled={pageBusy || pg.page === 0 || nChanges > 0} onClick={() => void goPage(pg.page - 1)}>◀</button>
          <span className="grid-pager-page">
            {tr("db.pageLabel", { n: pg.page + 1 })}{lastPage != null ? ` / ${lastPage + 1}` : ""}
          </span>
          <button className="icon-btn" title={lockTitle ?? tr("db.pageNext")} disabled={pageBusy || !pg.hasNext || nChanges > 0} onClick={() => void goPage(pg.page + 1)}>▶</button>
          {lastPage != null && (
            <button className="icon-btn" title={lockTitle ?? tr("db.pageLast")} disabled={pageBusy || pg.page >= lastPage || nChanges > 0} onClick={() => void goPage(lastPage)}>⏭</button>
          )}
          {pageBusy && <span className="spinner grid-pager-spin" />}
          <span className="grow" />
          {!pg.cass && (
            <button disabled={!!tot?.busy} onClick={() => void countAll()} title={tr("db.pageCountHint")}>
              Σ {tot?.busy ? tr("db.pageCounting") : tot?.n != null ? tr("db.pageTotal", { total: tot.n }) : tr("db.pageCount")}
            </button>
          )}
          <Picker
            label={<span>{tr("db.pageSize", { n: pg.size })}</span>}
            items={PAGE_SIZES.map((n) => ({ id: String(n), label: tr("db.pageSize", { n }), selected: n === pg.size }))}
            onPick={(id) => { const n = Number(id); pager?.setDefaultSize(n); void goPage(0, n); }}
            disabled={pageBusy || nChanges > 0}
          />
        </div>
      )}
      {cellMenu && (
        <ContextMenu
          x={cellMenu.x}
          y={cellMenu.y}
          onClose={() => setCellMenu(null)}
          items={((): CtxItem[] => {
            const { r, c } = cellMenu;
            const v = cellValue(r, c);
            const items: CtxItem[] = [];
            if (editable(c)) {
              items.push(
                { id: "edit", label: tr("db.gridEditCell"), action: () => setEditing({ r, c }) },
                { id: "null", label: tr("db.gridSetNull"), disabled: v === null, action: () => setCell(r, c, null) },
                { id: "empty", label: tr("db.gridSetEmpty"), disabled: v === "", action: () => setCell(r, c, "") },
              );
              if (edits.get(r)?.has(c)) items.push({ id: "revert", label: tr("db.gridRevertCell"), action: () => setCell(r, c, rows[r][c]) });
              items.push({ id: "s1", sep: true });
            }
            items.push({ id: "copy", label: tr("db.gridCopyValue"), action: () => void navigator.clipboard.writeText(v ?? "NULL") });
            return items;
          })()}
        />
      )}
    </div>
  );
});

/** Modal ALTER TABLE ADD COLUMN / CREATE INDEX — sinh SQL rồi đưa cho exec chạy. */
/** Kiểu dữ liệu gợi ý theo từng hệ — chọn từ Picker thay vì gõ tay. */
const COL_TYPES: Record<Driver, string[]> = {
  mysql: ["BIGINT", "INT", "SMALLINT", "TINYINT", "DECIMAL(10,2)", "FLOAT", "DOUBLE",
    "VARCHAR(255)", "VARCHAR(100)", "VARCHAR(50)", "TEXT", "LONGTEXT", "DATE", "DATETIME",
    "TIMESTAMP", "TIME", "BOOLEAN", "JSON", "BLOB"],
  postgres: ["BIGINT", "INTEGER", "SMALLINT", "NUMERIC(10,2)", "REAL", "DOUBLE PRECISION",
    "VARCHAR(255)", "VARCHAR(100)", "VARCHAR(50)", "TEXT", "DATE", "TIMESTAMP", "TIMESTAMPTZ",
    "TIME", "BOOLEAN", "JSONB", "UUID", "SERIAL", "BIGSERIAL", "BYTEA"],
  sqlite: ["INTEGER", "REAL", "TEXT", "BLOB", "NUMERIC", "BOOLEAN", "DATE", "DATETIME", "VARCHAR(255)"],
  // Cassandra (CQL) — DdlModal không dùng cho Cassandra nhưng cần đủ khoá.
  cassandra: ["text", "int", "bigint", "uuid", "timeuuid", "timestamp", "boolean", "double", "blob", "list<text>", "set<text>", "map<text,text>"],
};

function DdlModal({ kind, conn, table, onClose, onRun }: {
  kind: "col" | "idx";
  conn: Conn;
  table: TableInfo;
  onClose: () => void;
  onRun: (sql: string) => void;
}) {
  const tr = useT();
  const [name, setName] = useState(kind === "idx" ? `idx_${table.name}` : "");
  const [type, setType] = useState(conn.driver === "sqlite" ? "TEXT" : "VARCHAR(255)");
  const [notNull, setNotNull] = useState(false);
  const [def, setDef] = useState("");
  const [cols, setCols] = useState("");
  const [uniq, setUniq] = useState(false);

  const qi = (s: string) => (conn.driver === "mysql" ? `\`${s}\`` : `"${s}"`);
  const ref = conn.driver === "mysql"
    ? (table.schema ? `${qi(table.schema)}.${qi(table.name)}` : qi(table.name))
    : conn.driver === "postgres" && table.schema && table.schema !== "public"
      ? `${qi(table.schema)}.${qi(table.name)}`
      : qi(table.name);

  const colList = cols.split(",").map((c) => c.trim()).filter(Boolean);
  const sql = kind === "col"
    ? `ALTER TABLE ${ref} ADD COLUMN ${qi(name.trim())} ${type.trim()}${notNull ? " NOT NULL" : ""}${def.trim() ? ` DEFAULT ${def.trim()}` : ""};`
    : `CREATE ${uniq ? "UNIQUE " : ""}INDEX ${qi(name.trim())} ON ${ref} (${colList.map(qi).join(", ")});`;
  const valid = name.trim() && (kind === "col" ? type.trim() : colList.length > 0);

  return (
    <Modal title={kind === "col" ? `➕ ${tr("db.addColumn2")} — ${table.name}` : `➕ ${tr("db.addIndex2")} — ${table.name}`} width={560} onClose={onClose}>
      <div className="form account-form">
        {kind === "col" ? (
          <>
            <div className="form-row">
              <label className="grow">{tr("db.columnName")}<input autoFocus className="mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="created_at" /></label>
              <div className="field grow" style={{ flex: 1 }}>
                <span className="field-cap">{tr("db.dataType")}</span>
                <div className="picker-field">
                  <Picker
                    label={<span className="ellipsis mono">{type}</span>}
                    items={COL_TYPES[conn.driver].map((t) => ({ id: t, label: t, selected: t === type }))}
                    onPick={setType}
                  />
                </div>
              </div>
            </div>
            <div className="form-row">
              <label className="grow">{tr("db.defaultValueOptional")}<input className="mono" value={def} onChange={(e) => setDef(e.target.value)} placeholder="NULL / 0 / CURRENT_TIMESTAMP" /></label>
            </div>
            <label className="check"><input type="checkbox" checked={notNull} onChange={(e) => setNotNull(e.target.checked)} /> NOT NULL</label>
          </>
        ) : (
          <>
            <div className="form-row">
              <label className="grow">{tr("db.indexName")}<input autoFocus className="mono" value={name} onChange={(e) => setName(e.target.value)} /></label>
            </div>
            <label>{tr("db.columnsCommaSeparated")}<input className="mono" value={cols} onChange={(e) => setCols(e.target.value)} placeholder="user_id, created_at" /></label>
            <label className="check"><input type="checkbox" checked={uniq} onChange={(e) => setUniq(e.target.checked)} /> UNIQUE</label>
          </>
        )}
        <div className="field">
          <span className="field-cap">{tr("db.sqlToRun")}</span>
          <pre className="sql-preview mono">{sql}</pre>
        </div>
        <div className="toolbar">
          <span className="grow" />
          <button onClick={onClose}>{tr("db.cancel")}</button>
          <button className="primary" disabled={!valid} onClick={() => { onRun(sql); onClose(); }}>{tr("db.run2")}</button>
        </div>
      </div>
    </Modal>
  );
}

/** Định dạng số byte → KB/MB/GB. */
function fmtBytes(v: string | null | undefined): string {
  const n = Number(v);
  if (v == null || v === "" || !Number.isFinite(n)) return "";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let x = n;
  let i = 0;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return `${x >= 100 || i === 0 ? x.toFixed(0) : x.toFixed(1)} ${u[i]}`;
}

/**
 * Thông tin cơ bản của bảng đang chọn (click đơn trong cây) — kiểu khung "Object info" của Navicat.
 * Double-click / Enter trên bảng mới chạy SELECT.
 */
function TableInfoPanel({ conn, dbId, table, onOpen, onStructure, onClose }: {
  conn: Conn; dbId: string; table: TableInfo; onOpen: () => void; onStructure: () => void; onClose: () => void;
}) {
  const tr = useT();
  const [rows, setRows] = useState<[string, string][] | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    setRows(null);
    setErr("");
    const esc = (s: string) => s.replace(/'/g, "''");
    const q = (sql: string) => invoke<QueryOut>("db_query", { id: dbId, sql, limit: 5 });
    (async () => {
      const out: [string, string][] = [];
      const push = (k: string, v: string | null | undefined) => { if (v != null && v !== "") out.push([k, v]); };
      push(tr("db.infoType"), table.kind === "view" ? "VIEW" : "TABLE");
      try {
        if (conn.driver === "mysql") {
          const r = (await q(`SELECT ENGINE, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH, AUTO_INCREMENT, CREATE_TIME, UPDATE_TIME, TABLE_COLLATION, TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA='${esc(table.schema)}' AND TABLE_NAME='${esc(table.name)}'`)).rows[0];
          if (r) {
            push(tr("db.infoEngine"), r[0]);
            push(tr("db.infoRowsApprox"), r[1]);
            push(tr("db.infoDataSize"), fmtBytes(r[2]));
            push(tr("db.infoIndexSize"), fmtBytes(r[3]));
            push(tr("db.infoAutoIncrement"), r[4]);
            push(tr("db.infoCreated"), r[5]);
            push(tr("db.infoUpdated"), r[6]);
            push(tr("db.infoCollation"), r[7]);
            push(tr("db.infoComment"), r[8]);
          }
        } else if (conn.driver === "postgres") {
          const r = (await q(`SELECT c.reltuples::bigint, pg_size_pretty(pg_relation_size(c.oid)), pg_size_pretty(pg_indexes_size(c.oid)), pg_size_pretty(pg_total_relation_size(c.oid)), obj_description(c.oid, 'pg_class') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname='${esc(table.schema)}' AND c.relname='${esc(table.name)}'`)).rows[0];
          if (r) {
            push(tr("db.infoRowsApprox"), r[0] != null && Number(r[0]) >= 0 ? r[0] : "?");
            push(tr("db.infoDataSize"), r[1]);
            push(tr("db.infoIndexSize"), r[2]);
            push(tr("db.infoTotalSize"), r[3]);
            push(tr("db.infoComment"), r[4]);
          }
        } else if (conn.driver === "sqlite") {
          const r = (await q(`SELECT count(*) FROM "${table.name.replace(/"/g, '""')}"`)).rows[0];
          if (r) push(tr("db.infoRows"), r[0]);
        }
      } catch (e) {
        if (alive) setErr(errText(e));
      }
      // Cột + khoá chính (mọi loại DB).
      try {
        const cols = (await invoke<string[]>("db_table_columns", { id: dbId, schema: table.schema, table: table.name })).map((s) => s.split("\u001f"));
        push(tr("db.infoColumns"), String(cols.length));
        const pk = cols.filter((c) =>
          conn.driver === "sqlite" ? !!c[4] && c[4] !== "0"
          : conn.driver === "cassandra" ? c[2] === "partition_key" || c[2] === "clustering"
          : c[4] === "PRI").map((c) => c[0]);
        push(tr("db.infoPrimaryKey"), pk.length ? pk.join(", ") : tr("db.infoNone"));
      } catch { /* bỏ qua — vẫn hiện phần đã có */ }
      if (alive) setRows(out);
    })();
    return () => { alive = false; };
  }, [conn.driver, dbId, table.schema, table.name, table.kind]);

  return (
    <div className="db-table-info">
      <div className="db-table-info-head">
        <span className="tree-icon">{table.kind === "view" ? "👁" : <TableIcon />}</span>
        <b className="grow ellipsis" title={`${table.schema}.${table.name}`}>{table.name}</b>
        <button className="icon-btn" title={tr("db.close")} onClick={onClose}>×</button>
      </div>
      {err && <div className="error-box small">{err}</div>}
      {!rows ? (
        <div className="muted small pad">{tr("db.loading")}</div>
      ) : (
        <dl className="db-table-info-list">
          {rows.map(([k, v]) => (
            <div key={k} className="db-table-info-row"><dt>{k}</dt><dd title={v}>{v}</dd></div>
          ))}
        </dl>
      )}
      <div className="db-table-info-actions">
        <button className="primary" onClick={onOpen} title={tr("db.tableOpenHint")}>▶ {tr("db.openData")}</button>
        <button onClick={onStructure}>{tr("db.structure")}</button>
      </div>
    </div>
  );
}

interface ColDef { name: string; type: string; nullable: string; def: string; key: string }

/** Xem cấu trúc bảng (cột, kiểu, null, default, khoá) — nút thêm cột ngay tại đây. */
function TableStructModal({ dbId, table, onClose, onAddColumn }: {
  dbId: string; table: TableInfo; onClose: () => void; onAddColumn: () => void;
}) {
  const tr = useT();
  const [cols, setCols] = useState<ColDef[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let alive = true;
    call<string[]>("db_table_columns", { id: dbId, schema: table.schema, table: table.name })
      .then((rows) => alive && setCols(rows.map((s) => {
        const [name, type, nullable, def, key] = s.split("\u001f");
        return { name, type, nullable, def, key };
      })))
      .catch((e) => alive && setErr(errText(e)));
    return () => { alive = false; };
  }, [dbId, table.schema, table.name]);

  return (
    <Modal title={`✏ Edit table — ${table.schema}.${table.name}`} width={760} onClose={onClose}>
      <div className="form account-form">
        {err && <div className="error-box">⚠ {err}</div>}
        {!cols ? <div className="muted small">{tr("db.loading")}</div> : (
          <div className="grid-wrap" style={{ maxHeight: "50vh" }}>
            <table className="grid mono">
              <thead><tr><th>{tr("db.column")}</th><th>{tr("db.type2")}</th><th>Null</th><th>Key</th><th>Default</th></tr></thead>
              <tbody>
                {cols.map((c) => (
                  <tr key={c.name}>
                    <td>{c.name}</td><td className="muted">{c.type}</td>
                    <td className="muted">{c.nullable === "NO" || c.nullable === "1" ? "NOT NULL" : ""}</td>
                    <td>{c.key === "PRI" || c.key === "1" ? "🔑 PRI" : c.key}</td>
                    <td className="muted ellipsis">{c.def}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="toolbar">
          <button onClick={onAddColumn}>＋ {tr("db.addColumn2")}</button>
          <span className="grow" />
          <button onClick={onClose}>{tr("db.close")}</button>
        </div>
      </div>
    </Modal>
  );
}

/** Tạo bảng mới (nhập định nghĩa cột). */
function NewTableModal({ conn, schema, onClose, onRun }: {
  conn: Conn; schema: string; onClose: () => void; onRun: (sql: string) => void;
}) {
  const tr = useT();
  const [name, setName] = useState("");
  const [cols, setCols] = useState("id BIGINT PRIMARY KEY AUTO_INCREMENT,\nname VARCHAR(255) NOT NULL");
  const qi = (s: string) => (conn.driver === "mysql" ? `\`${s}\`` : `"${s}"`);
  const ref = schema && conn.driver !== "sqlite" ? `${qi(schema)}.${qi(name.trim() || "new_table")}` : qi(name.trim() || "new_table");
  const sql = `CREATE TABLE ${ref} (\n  ${cols.split("\n").map((l) => l.trim()).filter(Boolean).join(",\n  ")}\n);`;
  return (
    <Modal title={tr("db.newTable2")} width={620} onClose={onClose}>
      <div className="form account-form">
        <label>{tr("db.tableName")}<input autoFocus className="mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="orders" /></label>
        <label>{tr("db.columnDefinitionsOnePerLine")}
          <textarea className="mono" style={{ minHeight: 110 }} value={cols} onChange={(e) => setCols(e.target.value)} spellCheck={false} />
        </label>
        <div className="field"><span className="field-cap">{tr("db.sqlToRun")}</span><pre className="sql-preview mono">{sql}</pre></div>
        <div className="toolbar">
          <span className="grow" />
          <button onClick={onClose}>{tr("db.cancel")}</button>
          <button className="primary" disabled={!name.trim()} onClick={() => { onRun(sql); onClose(); }}>{tr("db.createTable")}</button>
        </div>
      </div>
    </Modal>
  );
}

/** Modal soạn routine (procedure/function/event): textarea SQL + nút chạy.
 * Chạy như MỘT câu (không tách ';') nên thân BEGIN…END giữ nguyên. */
function RoutineModal({ info, driver, running, onClose, onRun }: {
  info: { db: string; name: string; kind: RoutineKind; mode: "new" | "edit"; sql: string };
  driver: Driver; running: boolean; onClose: () => void; onRun: (sql: string) => void;
}) {
  const tr = useT();
  const [sql, setSql] = useState(info.sql);
  const kindLabel = info.kind === "event" ? tr("db.event") : info.kind === "function" ? tr("db.function") : tr("db.procedure");
  const title = info.mode === "new"
    ? tr("db.newIn", { kindLabel, db: info.db })
    : tr("db.edit2", { kindLabel, name: info.name });
  void driver;
  return (
    <Modal title={title} width={720} onClose={onClose}>
      <div className="form account-form">
        {info.kind === "event" && (
          <div className="muted small">{tr("db.eventSchedulerMustBeOnSet")}</div>
        )}
        <textarea
          autoFocus
          className="db-editor mono"
          style={{ minHeight: 320, width: "100%" }}
          spellCheck={false}
          value={sql}
          onChange={(e) => setSql(e.target.value)}
        />
        <div className="toolbar">
          <span className="muted small">{info.mode === "edit" ? tr("db.savingDropsRecreatesIt") : tr("db.runsAsASingleStatement")}</span>
          <span className="grow" />
          <button onClick={onClose}>{tr("db.cancel")}</button>
          <button className="primary" disabled={running || !sql.trim()} onClick={() => onRun(sql)}>{running ? tr("db.running") : tr("db.run")}</button>
        </div>
      </div>
    </Modal>
  );
}

const EVENT_UNITS = ["SECOND", "MINUTE", "HOUR", "DAY", "WEEK", "MONTH", "YEAR"];

/** Giá trị khởi tạo form Event (khi sửa event cũ, đọc từ information_schema.EVENTS). */
interface EventInit {
  name: string; body: string; mode: "every" | "at"; at: string;
  every: string; unit: string; starts: string; ends: string;
  preserve: boolean; status: string; comment: string;
}

/** Modal Event (MySQL) kiểu Navicat: form cấu hình lịch → sinh CREATE EVENT.
 * `init` != null = sửa event cũ (điền sẵn); onRun trả kèm tên gốc để DROP trước khi tạo lại. */
function EventModal({ db, mode: emode, init, running, onClose, onRun, onRawEdit }: {
  db: string; mode: "new" | "edit"; init?: EventInit; running: boolean;
  onClose: () => void; onRun: (sql: string, origName?: string) => void; onRawEdit: (sql: string) => void;
}) {
  const tr = useT();
  const bq = (s: string) => s.replace(/`/g, "``");
  const [name, setName] = useState(init?.name ?? "new_event");
  const [mode, setMode] = useState<"every" | "at">(init?.mode ?? "every");
  const [every, setEvery] = useState(init?.every ?? "1");
  const [unit, setUnit] = useState(init?.unit ?? "DAY");
  const [starts, setStarts] = useState(init?.starts ?? "CURRENT_TIMESTAMP");
  const [ends, setEnds] = useState(init?.ends ?? "");
  const [at, setAt] = useState(init?.at ?? "CURRENT_TIMESTAMP");
  const [preserve, setPreserve] = useState(init?.preserve ?? true);
  const [status, setStatus] = useState(init?.status ?? "ENABLE");
  const [comment, setComment] = useState(init?.comment ?? "");
  const [body, setBody] = useState(init?.body ?? `-- ${t("db.tplRunOnSchedule")}\nSELECT 1;`);

  const nm = name.trim() || "new_event";
  // Giá trị lịch: để nguyên CURRENT_TIMESTAMP / biểu thức, còn lại bọc nháy nếu người dùng nhập ngày giờ thường.
  const lit = (v: string) => {
    const s = v.trim();
    if (!s) return "";
    if (/^(current_timestamp|now\(\))/i.test(s) || /[+(]/.test(s) || /^'.*'$/.test(s)) return s;
    return `'${s.replace(/'/g, "''")}'`;
  };
  const schedule = mode === "at"
    ? `AT ${lit(at) || "CURRENT_TIMESTAMP"}`
    : `EVERY ${(every.trim() || "1")} ${unit}` +
      (starts.trim() ? ` STARTS ${lit(starts)}` : "") +
      (ends.trim() ? ` ENDS ${lit(ends)}` : "");
  const sql =
    `CREATE EVENT \`${bq(db)}\`.\`${bq(nm)}\`\n` +
    `ON SCHEDULE ${schedule}\n` +
    `ON COMPLETION ${preserve ? "PRESERVE" : "NOT PRESERVE"}\n` +
    `${status}\n` +
    (comment.trim() ? `COMMENT '${comment.replace(/'/g, "''")}'\n` : "") +
    `DO\n${body.trim() || "SELECT 1;"}`;

  const title = emode === "edit"
    ? tr("db.editEvent", { p: init?.name ?? name })
    : tr("db.newEventIn", { db });
  return (
    <Modal title={title} width={720} onClose={onClose}>
      <div className="form account-form">
        <div className="muted small">{tr("db.eventSchedulerMustBeOnSet")}</div>
        <label>{tr("db.eventName")}
          <input autoFocus className="mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="my_event" />
        </label>
        <div className="form-row">
          <div className="field grow">
            <span className="field-cap">{tr("db.schedule")}</span>
            <div className="picker-field">
              <Picker
                label={<span className="ellipsis">{mode === "every" ? tr("db.everyRecurring") : tr("db.atOneTime")}</span>}
                items={[
                  { id: "every", label: tr("db.everyRecurring"), selected: mode === "every" },
                  { id: "at", label: tr("db.atOneTime"), selected: mode === "at" },
                ]}
                onPick={(m) => setMode(m as "every" | "at")}
              />
            </div>
          </div>
          <div className="field grow">
            <span className="field-cap">{tr("db.status")}</span>
            <div className="picker-field">
              <Picker
                label={<span className="ellipsis">{status}</span>}
                items={["ENABLE", "DISABLE", "DISABLE ON SLAVE"].map((s) => ({ id: s, label: s, selected: s === status }))}
                onPick={setStatus}
              />
            </div>
          </div>
        </div>
        {mode === "every" ? (
          <>
            <div className="form-row">
              <label style={{ width: 120 }}>{tr("db.every")}
                <input className="mono" type="number" min={1} value={every} onChange={(e) => setEvery(e.target.value)} />
              </label>
              <div className="field grow">
                <span className="field-cap">{tr("db.unit")}</span>
                <div className="picker-field">
                  <Picker label={<span className="ellipsis">{unit}</span>} items={EVENT_UNITS.map((u) => ({ id: u, label: u, selected: u === unit }))} onPick={setUnit} />
                </div>
              </div>
            </div>
            <div className="form-row">
              <label className="grow">{tr("db.starts")}
                <input className="mono" value={starts} onChange={(e) => setStarts(e.target.value)} placeholder="CURRENT_TIMESTAMP / 2026-01-01 00:00:00" />
              </label>
              <label className="grow">{tr("db.endsOptional")}
                <input className="mono" value={ends} onChange={(e) => setEnds(e.target.value)} placeholder={tr("db.emptyNoEnd")} />
              </label>
            </div>
          </>
        ) : (
          <label>{tr("db.executeAt")}
            <input className="mono" value={at} onChange={(e) => setAt(e.target.value)} placeholder="CURRENT_TIMESTAMP + INTERVAL 1 HOUR" />
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={preserve} onChange={(e) => setPreserve(e.target.checked)} />
          {tr("db.keepEventAfterItFinishesOn")}
        </label>
        <label>{tr("db.commentOptional")}
          <input value={comment} onChange={(e) => setComment(e.target.value)} />
        </label>
        <div className="field">
          <span className="field-cap">{tr("db.bodyDo")}</span>
          <textarea className="db-editor mono" style={{ minHeight: 120, width: "100%" }} spellCheck={false} value={body} onChange={(e) => setBody(e.target.value)} />
        </div>
        <div className="field"><span className="field-cap">{tr("db.sqlToRun")}</span><pre className="sql-preview mono">{sql}</pre></div>
        <div className="toolbar">
          <button onClick={() => onRawEdit(sql)} title={tr("db.switchToRawSqlEditor")}>{tr("db.editSql")}</button>
          {emode === "edit" && <span className="muted small">{tr("db.savingDropsRecreatesIt")}</span>}
          <span className="grow" />
          <button onClick={onClose}>{tr("db.cancel")}</button>
          <button className="primary" disabled={running || !name.trim()} onClick={() => onRun(sql, init?.name)}>{running ? tr("db.running") : emode === "edit" ? tr("db.save2") : tr("db.create")}</button>
        </div>
      </div>
    </Modal>
  );
}

/** Modal tạo database mới (MySQL) / schema mới (Postgres) — sinh SQL rồi đưa exec chạy. */
/** Hai Picker Charset + Collation, nạp danh sách thật từ server (SHOW CHARACTER SET / SHOW COLLATION);
 * collation lọc theo charset đang chọn; chọn charset thì tự điền collation mặc định của nó. */
function CharsetCollationFields({ dbId, charset, setCharset, collation, setCollation }: {
  dbId: string | null; charset: string; setCharset: (s: string) => void; collation: string; setCollation: (s: string) => void;
}) {
  const tr = useT();
  const [charsets, setCharsets] = useState<{ name: string; def: string }[]>([]);
  const [collMap, setCollMap] = useState<Record<string, string[]>>({});
  useEffect(() => {
    if (!dbId) return;
    let alive = true;
    (async () => {
      try {
        const [cs, co] = await Promise.all([
          invoke<QueryOut>("db_query", { id: dbId, sql: "SHOW CHARACTER SET", limit: 1000 }),
          invoke<QueryOut>("db_query", { id: dbId, sql: "SHOW COLLATION", limit: 10000 }),
        ]);
        if (!alive) return;
        setCharsets(cs.rows.map((r) => ({ name: r[0] ?? "", def: r[2] ?? "" })).filter((x) => x.name));
        const map: Record<string, string[]> = {};
        for (const r of co.rows) { const c = r[0], ch = r[1]; if (c && ch) (map[ch] ??= []).push(c); }
        setCollMap(map);
      } catch { /* không nạp được → Picker rỗng, vẫn chạy với mặc định server */ }
    })();
    return () => { alive = false; };
  }, [dbId]);
  const collOpts = collMap[charset] ?? (collation ? [collation] : []);
  return (
    <div className="form-row">
      <div className="field grow">
        <span className="field-cap">{tr("db.charset")}</span>
        <div className="picker-field">
          <Picker
            label={<span className="ellipsis">{charset || tr("db.serverDefault")}</span>}
            items={charsets.map((c) => ({ id: c.name, label: c.name, selected: c.name === charset }))}
            onPick={(cs) => { setCharset(cs); const d = charsets.find((x) => x.name === cs)?.def; setCollation(d || ""); }}
            filterPlaceholder={tr("db.filterCharset")}
          />
        </div>
      </div>
      <div className="field grow">
        <span className="field-cap">{tr("db.collation")}</span>
        <div className="picker-field">
          <Picker
            label={<span className="ellipsis">{collation || tr("db.default")}</span>}
            items={collOpts.map((c) => ({ id: c, label: c, selected: c === collation }))}
            onPick={(c) => setCollation(c)}
            filterPlaceholder={tr("db.filterCollation")}
          />
        </div>
      </div>
    </div>
  );
}

function NewDbModal({ conn, dbId, onClose, onRun }: { conn: Conn; dbId: string | null; onClose: () => void; onRun: (sql: string) => void }) {
  const tr = useT();
  const mysql = conn.driver === "mysql";
  const pg = conn.driver === "postgres";
  const [name, setName] = useState("");
  const [charset, setCharset] = useState(mysql ? "utf8mb4" : "");
  const [collation, setCollation] = useState("");
  const nm = name.trim() || (pg ? "new_schema" : "new_db");
  const sql = pg
    ? `CREATE SCHEMA "${nm.replace(/"/g, '""')}";`
    : `CREATE DATABASE \`${nm.replace(/`/g, "``")}\`` +
      (charset.trim() ? ` CHARACTER SET ${charset.trim()}` : "") +
      (collation.trim() ? ` COLLATE ${collation.trim()}` : "") + ";";
  return (
    <Modal title={pg ? tr("db.newSchema2") : tr("db.newDatabase2")} width={560} onClose={onClose}>
      <div className="form account-form">
        <label>{pg ? tr("db.schemaName") : tr("db.databaseName")}
          <input autoFocus className="mono" value={name} onChange={(e) => setName(e.target.value)} placeholder={pg ? "reporting" : "myapp"} />
        </label>
        {mysql && (
          <CharsetCollationFields dbId={dbId} charset={charset} setCharset={setCharset} collation={collation} setCollation={setCollation} />
        )}
        <div className="field"><span className="field-cap">{tr("db.sqlToRun")}</span><pre className="sql-preview mono">{sql}</pre></div>
        <div className="toolbar">
          <span className="grow" />
          <button onClick={onClose}>{tr("db.cancel")}</button>
          <button className="primary" disabled={!name.trim()} onClick={() => { onRun(sql); onClose(); }}>{tr("db.create2")}</button>
        </div>
      </div>
    </Modal>
  );
}

/** Modal sửa charset/collation của một database (MySQL). */
function AlterDbModal({ conn, db, dbId, onClose, onRun }: { conn: Conn; db: string; dbId: string | null; onClose: () => void; onRun: (sql: string) => void }) {
  const tr = useT();
  const [charset, setCharset] = useState("utf8mb4");
  const [collation, setCollation] = useState("");
  const sql = `ALTER DATABASE \`${db.replace(/`/g, "``")}\`` +
    (charset.trim() ? ` CHARACTER SET ${charset.trim()}` : "") +
    (collation.trim() ? ` COLLATE ${collation.trim()}` : "") + ";";
  void conn;
  return (
    <Modal title={tr("db.editDatabase", { db })} width={560} onClose={onClose}>
      <div className="form account-form">
        <CharsetCollationFields dbId={dbId} charset={charset} setCharset={setCharset} collation={collation} setCollation={setCollation} />
        <div className="muted small">{tr("db.setsDefaultCharsetCollationForNew")}</div>
        <div className="field"><span className="field-cap">{tr("db.sqlToRun")}</span><pre className="sql-preview mono">{sql}</pre></div>
        <div className="toolbar">
          <span className="grow" />
          <button onClick={onClose}>{tr("db.cancel")}</button>
          <button className="primary" onClick={() => { onRun(sql); onClose(); }}>{tr("db.run2")}</button>
        </div>
      </div>
    </Modal>
  );
}

/* ── Struct sync: so sánh cấu trúc 2 database, sinh SQL đồng bộ ── */

interface ScCol { name: string; type: string; nn: boolean; def: string; key: string }

function parseStruct(rows: string[]): Record<string, ScCol[]> {
  const out: Record<string, ScCol[]> = {};
  for (const s of rows) {
    const [table, name, type, nl, def, key] = s.split("\u001f");
    (out[table] ??= []).push({ name, type, nn: nl === "NO" || nl === "1", def, key });
  }
  return out;
}

/** Kế hoạch đồng bộ cho Postgres/SQLite (và khi hai đầu khác loại) — dựng từ metadata cột (db_struct). */
function planGenericSync(conn: Conn, dstSchema: string, src: Record<string, ScCol[]>, dst: Record<string, ScCol[]>, dropExtra: boolean): { plan: SyncPlan; notes: string[] } {
  const qi = (x: string) => (conn.driver === "mysql" ? `\`${x}\`` : `"${x}"`);
  const ref = (tb: string) => (dstSchema && conn.driver !== "sqlite" ? `${qi(dstSchema)}.${qi(tb)}` : qi(tb));
  const norm = (x: string) => x.trim().toLowerCase().replace(/\s+/g, " ");
  const colDef = (c: ScCol) => `${qi(c.name)} ${c.type}${c.nn ? " NOT NULL" : ""}${c.def ? ` DEFAULT ${c.def}` : ""}`;
  const tables: SyncTable[] = [];
  const notes: string[] = [];
  for (const [tbl, scols] of Object.entries(src)) {
    const dcols = dst[tbl];
    const items: SyncItem[] = [];
    const id = (k: string, n = "") => `${tbl}|${k}|${n}`;
    if (!dcols) {
      const lines = scols.map((c) => `  ${colDef(c)}`);
      const pks = scols.filter((c) => c.key === "PRI").map((c) => qi(c.name));
      if (pks.length) lines.push(`  PRIMARY KEY (${pks.join(", ")})`);
      items.push({ id: id("create"), kind: "create", action: "add", name: "", detail: `${scols.length} columns`, parts: [{ phase: 2, order: 0, stmt: `CREATE TABLE ${ref(tbl)} (\n${lines.join(",\n")}\n);` }] });
      tables.push({ table: tbl, ref: ref(tbl), isNew: true, items, dstCols: [] });
      continue;
    }
    for (const sc of scols) {
      const dc = dcols.find((c) => c.name === sc.name);
      if (!dc) {
        items.push({ id: id("col", sc.name), kind: "column", action: "add", name: sc.name, detail: colDef(sc), parts: [{ phase: 3, order: 1, stmt: `ALTER TABLE ${ref(tbl)} ADD COLUMN ${colDef(sc)};` }] });
        continue;
      }
      const typeDiff = norm(sc.type) !== norm(dc.type);
      const nullDiff = sc.nn !== dc.nn;
      const defDiff = norm(sc.def) !== norm(dc.def);
      if (!typeDiff && !nullDiff && !defDiff) continue;
      const stmts: string[] = [];
      if (conn.driver === "mysql") stmts.push(`ALTER TABLE ${ref(tbl)} MODIFY COLUMN ${colDef(sc)};`);
      else if (conn.driver === "postgres") {
        if (typeDiff) stmts.push(`ALTER TABLE ${ref(tbl)} ALTER COLUMN ${qi(sc.name)} TYPE ${sc.type};`);
        if (nullDiff) stmts.push(`ALTER TABLE ${ref(tbl)} ALTER COLUMN ${qi(sc.name)} ${sc.nn ? "SET NOT NULL" : "DROP NOT NULL"};`);
        if (defDiff) stmts.push(`ALTER TABLE ${ref(tbl)} ALTER COLUMN ${qi(sc.name)} ${sc.def ? `SET DEFAULT ${sc.def}` : "DROP DEFAULT"};`);
      } else {
        notes.push(t("db.sqliteCanTAlterColumnSkipped", { tbl, name: sc.name }));
        continue;
      }
      items.push({ id: id("col", sc.name), kind: "column", action: "modify", name: sc.name, detail: `${colDef(dc)}\n→ ${colDef(sc)}`, parts: stmts.map((st, i) => ({ phase: 3 as const, order: 1 + i / 10, stmt: st })) });
    }
    if (dropExtra) for (const dc of dcols) if (!scols.some((c) => c.name === dc.name)) {
      items.push({ id: id("col", dc.name), kind: "column", action: "drop", name: dc.name, detail: colDef(dc), parts: [{ phase: 3, order: 2, stmt: `ALTER TABLE ${ref(tbl)} DROP COLUMN ${qi(dc.name)};` }] });
    }
    if (items.length) tables.push({ table: tbl, ref: ref(tbl), isNew: false, items, dstCols: dcols.map((c) => c.name) });
  }
  return { plan: { tables, viewsSkipped: [], onlyInTarget: Object.keys(dst).filter((tb) => !src[tb]) }, notes };
}

/** SHOW CREATE TABLE cho nhiều bảng (MySQL/MariaDB), chạy song song 4 luồng. */
async function showCreateAll(id: string, schema: string, tables: string[], onEach?: (table: string) => void): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const queue = [...tables];
  const q = (x: string) => `\`${x.replace(/`/g, "``")}\``;
  const worker = async () => {
    for (let tb = queue.shift(); tb !== undefined; tb = queue.shift()) {
      const r = await call<QueryOut>("db_query", { id, sql: `SHOW CREATE TABLE ${q(schema)}.${q(tb)}`, limit: 1 });
      out[tb] = r.rows[0]?.[1] ?? "";
      onEach?.(tb);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, tables.length) }, worker));
  return out;
}

/** Một đầu (nguồn/đích) của Struct sync: chọn server (kết nối) → chọn database trong đó. */
function SyncEnd({ cap, conns, connId, setConnId, dbs, loading, db, setDb }: {
  cap: string; conns: Conn[]; connId: string; setConnId: (id: string) => void;
  dbs: string[]; loading: boolean; db: string; setDb: (d: string) => void;
}) {
  const tr = useT();
  const c = conns.find((x) => x.id === connId);
  return (
    <div className="field grow" style={{ flex: 1 }}>
      <span className="field-cap">{cap}</span>
      <div className="picker-field">
        <Picker
          label={<span className="ellipsis">{c ? c.name : tr("db.pickServer")}{c && c.env === "prod" ? " (PROD)" : ""}</span>}
          items={conns.map((x) => ({ id: x.id, label: `${x.name} · ${DRIVERS[x.driver].name.split(" ")[0]}`, hint: x.env, selected: x.id === connId }))}
          onPick={setConnId}
        />
      </div>
      <div className="picker-field" style={{ marginTop: 6 }}>
        <Picker
          label={<span className="ellipsis">{loading ? tr("db.loadingDatabases") : db || tr("db.pickDatabase")}</span>}
          items={dbs.map((d) => ({ id: d, label: d, selected: d === db }))}
          onPick={setDb}
          filterPlaceholder={tr("db.filterDatabases")}
        />
      </div>
    </div>
  );
}

/** Struct sync kiểu Navicat: chọn server nguồn + database, server đích + database (có thể khác server). */
function StructSyncModal({ current, conns, onClose, onReloadSession }: {
  current: { conn: Conn; dbId: string };
  conns: Conn[];
  onClose: () => void;
  onReloadSession: () => void;
}) {
  const tr = useT();
  const [srcConn, setSrcConn] = useState(current.conn.id);
  const [dstConn, setDstConn] = useState(current.conn.id);
  const [srcDbs, setSrcDbs] = useState<string[]>([]);
  const [dstDbs, setDstDbs] = useState<string[]>([]);
  const [srcLoad, setSrcLoad] = useState(false);
  const [dstLoad, setDstLoad] = useState(false);
  const [srcDb, setSrcDb] = useState("");
  const [dstDb, setDstDb] = useState("");
  const [dropExtra, setDropExtra] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  const [sql, setSql] = useState("");
  const [notes, setNotes] = useState<string[]>([]);
  /** Kế hoạch đồng bộ (bảng → các mục thay đổi chọn được) + các mục đã chọn + bảng đang mở rộng. */
  const [plan, setPlan] = useState<SyncPlan | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [openTables, setOpenTables] = useState<Set<string>>(new Set());
  /** Bước của wizard: 1 so sánh → 2 chọn thay đổi → 3 SQL & chạy (có thể quay lại). */
  const [step, setStep] = useState<1 | 2 | 3>(1);
  /** Tiến trình việc nặng (đọc cấu trúc / chạy script). */
  const [progress, setProgress] = useState<{ label: string; done: number; total: number } | null>(null);
  // Cache kết nối mở tạm cho các server KHÁC session hiện tại — đóng khi tắt modal.
  const cache = useRef<Map<string, { dbId: string; tunnelId: string | null }>>(new Map());

  const connOf = (id: string) => conns.find((c) => c.id === id);

  /** Lấy dbId của một kết nối: dùng lại session nếu trùng, nếu không thì mở tạm (cần mật khẩu đã lưu). */
  const openFor = async (connId: string): Promise<string> => {
    if (connId === current.conn.id) return current.dbId;
    const cached = cache.current.get(connId);
    if (cached) return cached.dbId;
    const c = connOf(connId);
    if (!c) throw new Error(tr("db.connectionDoesNotExist"));
    const pw = sessionPasswords.get(connId) ?? (await call<string | null>("db_get_password", { id: connId }).catch(() => null)) ?? "";
    if (c.driver !== "sqlite" && !pw) throw new Error(tr("db.connectionHasNoSavedPasswordOpen", { name: c.name }));
    const { id, tunnelId } = await dbConnectMaybeTunnel(c, pw);
    cache.current.set(connId, { dbId: id, tunnelId });
    return id;
  };

  const loadDbs = async (connId: string, forSrc: boolean) => {
    (forSrc ? setSrcLoad : setDstLoad)(true);
    setErr("");
    try {
      const id = await openFor(connId);
      const list = await call<string[]>("db_databases", { id });
      if (forSrc) { setSrcDbs(list); setSrcDb((cur) => (cur && list.includes(cur) ? cur : list[0] ?? "")); }
      else { setDstDbs(list); setDstDb((cur) => (cur && list.includes(cur) ? cur : list[0] ?? "")); }
    } catch (e) {
      setErr(errText(e));
      if (forSrc) setSrcDbs([]); else setDstDbs([]);
    } finally {
      (forSrc ? setSrcLoad : setDstLoad)(false);
    }
  };

  useEffect(() => { void loadDbs(srcConn, true); /* eslint-disable-next-line */ }, [srcConn]);
  // Đổi server/database nguồn-đích → kết quả so sánh cũ không còn đúng → về bước 1.
  useEffect(() => { setPlan(null); setSql(""); setNotes([]); setStep(1); }, [srcConn, dstConn, srcDb, dstDb]);
  useEffect(() => { void loadDbs(dstConn, false); /* eslint-disable-next-line */ }, [dstConn]);

  const closeAll = () => {
    for (const { dbId, tunnelId } of cache.current.values()) {
      void call("db_disconnect", { id: dbId }).catch(() => {});
      if (tunnelId) void invoke("ssh_tunnel_close", { id: tunnelId }).catch(() => {});
    }
    cache.current.clear();
    onClose();
  };

  /** Bước 1: đọc cấu trúc 2 đầu → lập kế hoạch (danh sách bảng/trường cần thay đổi). CHƯA sinh SQL. */
  const runCompare = async () => {
    if (!srcDb || !dstDb) return;
    setBusy(true); setErr(""); setOk(""); setSql(""); setNotes([]); setPlan(null); setPicked(new Set()); setOpenTables(new Set());
    setProgress({ label: tr("db.syncReadingStructure"), done: 0, total: 0 });
    try {
      const sId = await openFor(srcConn);
      const dId = await openFor(dstConn);
      const [s, d] = await Promise.all([
        call<string[]>("db_struct", { id: sId, schema: srcDb }),
        call<string[]>("db_struct", { id: dId, schema: dstDb }),
      ]);
      const srcS = parseStruct(s);
      const dstS = parseStruct(d);
      let p: SyncPlan;
      const extra: string[] = [];
      if (connOf(srcConn)?.driver === "mysql" && connOf(dstConn)?.driver === "mysql") {
        // MySQL/MariaDB: so sánh theo SHOW CREATE TABLE → đủ AUTO_INCREMENT, ON UPDATE, COMMENT, CHARSET/COLLATE,
        // index, khoá ngoại, tuỳ chọn bảng.
        const srcTables = Object.keys(srcS);
        const dstTables = Object.keys(dstS);
        const dstNeeded = dstTables.filter((tb) => srcTables.includes(tb));
        const total = srcTables.length + dstNeeded.length;
        let done = 0;
        const tick = (tb: string) => { done++; setProgress({ label: tr("db.syncReadingTable", { table: tb }), done, total }); };
        const [sd, dd] = await Promise.all([showCreateAll(sId, srcDb, srcTables, tick), showCreateAll(dId, dstDb, dstNeeded, tick)]);
        for (const tb of dstTables) if (!(tb in dd)) dd[tb] = ""; // bảng chỉ có ở đích (để báo)
        p = planMysqlSync(sd, dd, dstDb, dropExtra);
        if (p.viewsSkipped.length) extra.push(tr("db.viewsNotSynced", { names: p.viewsSkipped.join(", ") }));
      } else {
        const g = planGenericSync(connOf(dstConn)!, dstDb, srcS, dstS, dropExtra);
        p = g.plan;
        extra.push(...g.notes);
      }
      const notes = [...extra, ...p.onlyInTarget.map((tbl) => tr("db.onlyInTargetTableNotAuto", { tbl }))];
      setPlan(p);
      setPicked(new Set(p.tables.flatMap((tb) => tb.items.map((it) => it.id)))); // mặc định chọn hết
      setNotes(p.tables.length ? notes : [tr("db.bothSidesAreIdenticalNothingTo"), ...notes]);
      if (p.tables.length) setStep(2);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  /** Bước 2: sinh SQL CHỈ từ các mục đã chọn (vẫn theo 5 pha an toàn cho khoá ngoại). */
  const genSql = () => {
    if (!plan || !picked.size) return;
    setSql(assembleSync(plan, picked));
   
    setOk("");
    setErr("");
    setStep(3);
  };

  const togglePick = (ids: string[], on: boolean) => {
    setPicked((prev) => {
      const n = new Set(prev);
      for (const id of ids) { if (on) n.add(id); else n.delete(id); }
      return n;
    });
  };
  const toggleOpen = (table: string) =>
    setOpenTables((prev) => { const n = new Set(prev); if (n.has(table)) n.delete(table); else n.add(table); return n; });

  /** Bước 3: chạy script lên đích — từng câu, có tiến trình; lỗi thì dừng và báo đúng câu. */
  const runScript = async () => {
    const dc = connOf(dstConn)!;
    const confirmed = await confirmDialog({
      title: dc.env === "prod" ? tr("db.syncToProd") : tr("db.runSyncScript"),
      message: tr("db.runTheStructureSyncScriptOn", { name: dc.name, dstDb }),
      confirmLabel: tr("db.run2"),
      danger: dc.env === "prod",
    });
    if (!confirmed) return;
    const stmts = splitStatements(sql);
    setBusy(true); setErr(""); setOk("");
    let i = 0;
    try {
      const dId = await openFor(dstConn);
      for (; i < stmts.length; i++) {
        setProgress({ label: stmts[i].replace(/--[^\n]*\n/g, "").replace(/\s+/g, " ").trim().slice(0, 160), done: i, total: stmts.length });
        await call("db_query", { id: dId, sql: stmts[i], limit: 1 });
      }
      setOk(tr("db.ranStatementsOn", { stmtsLength: stmts.length, name: dc.name, dstDb }));
      if (dstConn === current.conn.id) onReloadSession();
    } catch (e) {
      setErr(`${tr("db.syncFailedAt", { i: i + 1, n: stmts.length, msg: errText(e) })}\n\n${stmts[i] ?? ""}`);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <Modal title={tr("db.structSyncSyncStructureBetweenDatabases")} width={880} onClose={closeAll}>
      <div className="form account-form">
        {/* Thanh bước: bấm vào bước đã qua để quay lại */}
        <div className="wizard-steps">
          {([1, 2, 3] as const).map((n) => {
            const reachable = n === 1 || (n === 2 && !!plan && plan.tables.length > 0) || (n === 3 && !!sql);
            return (
              <button
                key={n}
                className={`wizard-step${step === n ? " on" : ""}${n < step ? " done" : ""}`}
                disabled={busy || !reachable || n === step}
                onClick={() => setStep(n)}
              >
                <span className="wizard-num">{n < step ? "✓" : n}</span>
                {n === 1 ? tr("db.syncStepCompare") : n === 2 ? tr("db.syncStepPick") : tr("db.syncStepRun")}
              </button>
            );
          })}
        </div>

        {step === 1 && (
          <>
            <div className="form-row" style={{ alignItems: "stretch" }}>
              <SyncEnd cap={tr("db.sourceReference")} conns={conns} connId={srcConn} setConnId={setSrcConn} dbs={srcDbs} loading={srcLoad} db={srcDb} setDb={setSrcDb} />
              <span style={{ alignSelf: "center", fontSize: 18 }}>→</span>
              <SyncEnd cap={tr("db.targetWillChange")} conns={conns} connId={dstConn} setConnId={setDstConn} dbs={dstDbs} loading={dstLoad} db={dstDb} setDb={setDstDb} />
            </div>
            <label className="check">
              <input type="checkbox" checked={dropExtra} onChange={(e) => { setDropExtra(e.target.checked); setPlan(null); setSql(""); setNotes([]); }} />
              {tr("db.dropExtraColumnsOnTargetDrop")}
            </label>
          </>
        )}

        {step === 2 && plan && (
          <>
            <div className="muted small">{tr("db.syncPickIntro", { src: srcDb, dst: dstDb })}</div>
            <SyncPicker plan={plan} picked={picked} open={openTables} onToggle={togglePick} onToggleOpen={toggleOpen} />
          </>
        )}

        {step === 3 && (
          <div className="field">
            <span className="field-cap">{tr("db.syncSqlEditableBeforeRunning")}</span>
            <textarea className="mono" style={{ minHeight: 280 }} value={sql} onChange={(e) => setSql(e.target.value)} spellCheck={false} />
          </div>
        )}

        {progress && (
          <div className="sync-progress">
            <div className="update-bar"><div style={{ width: progress.total ? `${Math.min(100, (progress.done / progress.total) * 100)}%` : "30%" }} /></div>
            <div className="muted small ellipsis" title={progress.label}>
              {progress.total ? `${progress.done}/${progress.total} · ` : ""}{progress.label}
            </div>
          </div>
        )}
        {err && <div className="error-box pre">⚠ {err}</div>}
        {ok && <div className="muted small" style={{ color: "var(--ok)" }}>{ok}</div>}
        {notes.length > 0 && step !== 3 && <div className="muted small">{notes.map((n, i) => <div key={i}>• {n}</div>)}</div>}
        {step === 1 && !plan && !busy && !err && !notes.length && <div className="muted small">{tr("db.pickServerDatabaseForSourceAnd")}</div>}

        {/* Nút điều hướng */}
        <div className="toolbar">
          {step > 1 && <button disabled={busy} onClick={() => { setErr(""); setOk(""); setStep((step - 1) as 1 | 2); }}>← {tr("db.syncBack")}</button>}
          <span className="grow" />
          {step === 1 && (
            <>
              {plan && plan.tables.length > 0 && <button disabled={busy} onClick={() => void runCompare()}>{tr("db.syncCompareAgain")}</button>}
              {plan && plan.tables.length > 0
                ? <button className="primary" disabled={busy} onClick={() => setStep(2)}>{tr("db.syncNext")} →</button>
                : <button className="primary" disabled={busy || !srcDb || !dstDb} onClick={() => void runCompare()}>{busy ? tr("db.working") : `${tr("db.compare")} →`}</button>}
            </>
          )}
          {step === 2 && <button className="primary" disabled={busy || !picked.size} onClick={genSql}>{tr("db.syncGenerateSql", { n: picked.size })} →</button>}
          {step === 3 && <button className="primary danger" disabled={busy || !sql.trim()} onClick={() => void runScript()}>{busy ? tr("db.working") : tr("db.sync")}</button>}
        </div>
      </div>
    </Modal>
  );
}

/** Ô tick có trạng thái "một phần" (indeterminate). */
function TriCheck({ checked, indeterminate, onChange }: { checked: boolean; indeterminate: boolean; onChange: (on: boolean) => void }) {
  return (
    <input
      type="checkbox"
      checked={checked}
      ref={(el) => { if (el) el.indeterminate = indeterminate; }}
      onChange={(e) => onChange(e.target.checked)}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

/** Danh sách thay đổi của Struct sync: tick theo bảng (tri-state) hoặc từng cột / index / khoá ngoại. */
function SyncPicker({ plan, picked, open, onToggle, onToggleOpen }: {
  plan: SyncPlan; picked: Set<string>; open: Set<string>;
  onToggle: (ids: string[], on: boolean) => void; onToggleOpen: (table: string) => void;
}) {
  const tr = useT();
  const all = plan.tables.flatMap((tb) => tb.items.map((it) => it.id));
  const nOn = all.filter((id) => picked.has(id)).length;
  const label = (it: SyncItem) =>
    it.kind === "create" ? tr("db.syncItemCreate", { detail: it.detail })
    : it.kind === "column" ? tr("db.syncItemColumn", { name: it.name })
    : it.kind === "key" ? tr("db.syncItemKey", { name: it.name })
    : it.kind === "fk" ? tr("db.syncItemFk", { name: it.name })
    : tr("db.syncItemOptions");
  const summary = (tb: SyncTable) => {
    const c = (k: SyncKind) => tb.items.filter((it) => it.kind === k).length;
    return [
      c("column") && tr("db.syncSumCols", { n: c("column") }),
      c("key") && tr("db.syncSumKeys", { n: c("key") }),
      c("fk") && tr("db.syncSumFks", { n: c("fk") }),
      c("options") && tr("db.syncItemOptions"),
    ].filter(Boolean).join(" · ");
  };
  return (
    <div className="sync-pick">
      <label className="sync-pick-head">
        <TriCheck checked={nOn === all.length} indeterminate={nOn > 0 && nOn < all.length} onChange={(on) => onToggle(all, on)} />
        <span className="grow">{tr("db.syncPickAll", { tables: plan.tables.length, items: all.length })}</span>
        <span className="muted small">{tr("db.syncPicked", { n: nOn })}</span>
      </label>
      <div className="sync-pick-list">
        {plan.tables.map((tb) => {
          const ids = tb.items.map((it) => it.id);
          const on = ids.filter((id) => picked.has(id)).length;
          const expanded = open.has(tb.table);
          return (
            <div key={tb.table}>
              <div className="sync-pick-table" onClick={() => onToggleOpen(tb.table)}>
                <span className="tree-caret">{expanded ? "▾" : "▸"}</span>
                <TriCheck checked={on === ids.length} indeterminate={on > 0 && on < ids.length} onChange={(v) => onToggle(ids, v)} />
                <b className="ellipsis">{tb.table}</b>
                <span className={`sync-badge ${tb.isNew ? "new" : "alter"}`}>{tb.isNew ? "NEW" : "ALTER"}</span>
                <span className="grow muted small ellipsis">{summary(tb)}</span>
              </div>
              {expanded && tb.items.map((it) => (
                <label key={it.id} className="sync-pick-item" title={it.detail}>
                  <input type="checkbox" checked={picked.has(it.id)} onChange={(e) => onToggle([it.id], e.target.checked)} />
                  <span className={`sync-act ${it.action}`}>{it.action === "add" ? "+" : it.action === "drop" ? "−" : "~"}</span>
                  <span className="sync-item-name">{label(it)}</span>
                  <code className="grow muted ellipsis">{it.detail.split("\n→ ").pop()}</code>
                </label>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const toTsv = (o: QueryOut) =>
  [o.columns, ...o.rows.map((r) => r.map((v) => (v ?? "").replace(/[\t\n]/g, " ")))].map((r) => r.join("\t")).join("\n");

function TabView({ tab }: { tab: Tab }) {
  return <Session tab={tab} />;
}

/** Modal cấu hình kết nối — mở toàn app, không phải tab. */
function ConnFormHost() {
  const req = useFormReq();
  if (!req) return null;
  return <ConnForm connId={req.connId} folderId={req.folderId} onClose={closeForm} />;
}

const dbApp: AppModule = {
  View: () => (
    <>
      <TabbedLayout
        appId="db"
        Sidebar={Sidebar}
        TabView={TabView}
        empty={
          <div className="welcome">
            <h1>🗄 Database</h1>
            <p className="muted">PostgreSQL · MySQL/MariaDB · SQLite</p>
            <button className="primary" onClick={() => openForm()}>＋ {t("db.newConnection")}</button>
          </div>
        }
      />
      <ConnFormHost />
    </>
  ),
  commands: () => [
    { id: "db.new", group: "Database", title: t("db.newDatabaseConnection"), run: () => openForm() },
    ...useConns.getState().conns.map((c) => ({
      id: `db.open.${c.id}`,
      group: "Database",
      title: `${t("db.openConnection")} ${c.name}`,
      run: () => openSession(c),
    })),
  ],
};

export default dbApp;
