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
import { getLang, t, useT } from "../../store/lang";

async function pickDbKey(set: (p: string) => void) {
  const f = await openDialog({ multiple: false, title: t("Choose SSH private key", "Chọn private key cho SSH") });
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
  if (!isTauri()) throw new Error(t("Must run inside the app (npm run app:dev) — the browser can't connect to a DB.", "Cần chạy trong app (npm run app:dev) — trình duyệt không kết nối DB được."));
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
  const [sel, setSel] = useState<string | null>(null);

  const move = (c: Conn, folderId: string) => useConns.getState().save({ ...c, folderId });

  const connMenu = (c: Conn): CtxItem[] => [
    { id: "open", label: tr("Open / connect", "Mở / kết nối"), action: () => openSession(c) },
    { id: "edit", label: tr("Edit config…", "Sửa cấu hình…"), action: () => openForm(c.id) },
    ...(c.driver === "mysql" || c.driver === "postgres"
      ? [{
          id: "newdb",
          label: c.driver === "postgres" ? tr("New schema (run SQL)…", "Schema mới (chạy SQL)…") : tr("New database (run SQL)…", "Database mới (chạy SQL)…"),
          action: () => { openSession(c); requestNewDb(c.id); },
        }]
      : []),
    {
      id: "dup",
      label: tr("Duplicate connection…", "Nhân bản kết nối…"),
      action: () => {
        const copy: Conn = { ...c, id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, name: `${c.name} (copy)` };
        useConns.getState().save(copy);
        openForm(copy.id);
      },
    },
    { id: "s1", sep: true },
    // Chuyển vào thư mục.
    ...folders.filter((f) => f.id !== c.folderId).map((f) => ({ id: `mv-${f.id}`, label: `${tr("Move to", "Chuyển vào")} 🗂 ${f.name}`, action: () => move(c, f.id) })),
    ...(c.folderId ? [{ id: "mv-root", label: tr("Move out of folder", "Đưa ra ngoài thư mục"), action: () => move(c, "") }] : []),
    { id: "s2", sep: true },
    { id: "forget", label: tr("Forget saved password", "Quên mật khẩu đã lưu"), action: () => void call("db_forget_password", { id: c.id }).catch(() => {}) },
    {
      id: "del",
      label: tr("Delete connection", "Xoá kết nối"),
      danger: true,
      action: () => void confirmDialog({ message: tr(`Delete connection “${c.name}”? The saved password is also removed.`, `Xoá kết nối “${c.name}”? Mật khẩu đã lưu cũng bị xoá.`) }).then((ok) => {
        if (!ok) return;
        void call("db_forget_password", { id: c.id }).catch(() => {});
        useConns.getState().remove(c.id);
      }),
    },
  ];

  const folderMenu = (f: { id: string; name: string }): CtxItem[] => [
    { id: "add", label: tr("New connection in folder…", "Kết nối mới trong thư mục…"), action: () => openForm(undefined, f.id) },
    { id: "rename", label: tr("Rename folder…", "Đổi tên thư mục…"), action: () => setEditingFolder(f.id) },
    { id: "s1", sep: true },
    { id: "del", label: tr("Delete folder (connections move out)", "Xoá thư mục (kết nối chuyển ra ngoài)"), danger: true, action: () => void confirmDialog({ message: tr(`Delete folder “${f.name}”? Connections inside move out.`, `Xoá thư mục “${f.name}”? Kết nối bên trong sẽ chuyển ra ngoài.`) }).then((ok) => ok && removeDbFolder(f.id)) },
  ];

  const connRow = (c: Conn, inFolder: boolean) => (
    <div
      key={c.id}
      className={`side-item ${c.env === "prod" ? "prod" : ""} ${sel === c.id ? "sel" : ""} ${dragId === c.id ? "dragging" : ""}`}
      style={inFolder ? { paddingLeft: 24 } : undefined}
      draggable
      onDragStart={(e) => { setDragId(c.id); e.dataTransfer.effectAllowed = "move"; }}
      onDragEnd={() => setDragId(null)}
      onDragOver={(e) => { if (dragId) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (dragId !== c.id) e.currentTarget.classList.add("drop-before"); } }}
      onDragLeave={(e) => e.currentTarget.classList.remove("drop-before")}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); e.currentTarget.classList.remove("drop-before"); dropOn(c.id, c.folderId ?? ""); }}
      onClick={() => setSel(c.id)}
      onDoubleClick={() => openSession(c)}
      onContextMenu={(e) => { e.preventDefault(); setSel(c.id); setMenu({ x: e.clientX, y: e.clientY, items: connMenu(c) }); }}
      title={`${tr("Double-click to open", "Double-click để mở")} · ${describe(c)}`}
    >
      <span className="grow ellipsis">{c.name}</span>
      <span className={`env-tag ${c.env}`}>{c.env.toUpperCase()}</span>
      <span className="muted small">{DRIVERS[c.driver].name.split(" ")[0]}</span>
      <button className="icon-btn small" title={tr("Edit", "Sửa")} onClick={(e) => { e.stopPropagation(); openForm(c.id); }}>✏</button>
    </div>
  );

  const rootConns = conns.filter((c) => !c.folderId || !folders.some((f) => f.id === c.folderId));

  return (
    <div
      className="side-list"
      onDragOver={(e) => { if (dragId) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; } }}
      onDrop={(e) => { if (dragId) { e.preventDefault(); dropOn(null, ""); } }}
    >
      <div className="side-head">
        <span>{tr("CONNECTIONS", "KẾT NỐI")}</span>
        <span className="side-actions">
          <button className="icon-btn" title={tr("New connection", "Kết nối mới")} onClick={() => openForm()}>＋</button>
          <button className="icon-btn" title={tr("New folder", "Thư mục mới")} onClick={() => setEditingFolder(addDbFolder())}>🗂</button>
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
              <button className="icon-btn" title={tr("New connection in folder", "Kết nối mới vào thư mục")} onClick={() => openForm(undefined, f.id)}>＋</button>
              <button className="icon-btn" title={tr("Rename", "Đổi tên")} onClick={() => setEditingFolder(f.id)}>✎</button>
              <button className="icon-btn" title={tr("Delete folder", "Xoá thư mục")} onClick={() => void confirmDialog({ message: tr(`Delete folder “${f.name}”? Connections inside move out.`, `Xoá thư mục “${f.name}”? Kết nối bên trong sẽ chuyển ra ngoài.`) }).then((ok) => ok && removeDbFolder(f.id))}>×</button>
            </span>
          </div>
          {f.open && conns.filter((c) => c.folderId === f.id).map((c) => connRow(c, true))}
        </div>
      ))}
      {rootConns.map((c) => connRow(c, false))}

      {!conns.length && !folders.length && <div className="muted small pad">{tr("No connections yet — click ＋ to add.", "Chưa có kết nối nào — bấm ＋ để thêm.")}</div>}
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
    setStatus({ ok: true, text: c.ssh?.enabled ? tr("Opening SSH tunnel & testing…", "Đang mở SSH tunnel & thử kết nối…") : tr("Testing connection…", "Đang thử kết nối…") });
    try {
      const { id, tunnelId } = await dbConnectMaybeTunnel(c, password);
      await call("db_disconnect", { id });
      if (tunnelId) await invoke("ssh_tunnel_close", { id: tunnelId }).catch(() => {});
      setStatus({ ok: true, text: tr("✓ Connected successfully", "✓ Kết nối thành công") });
    } catch (e) {
      setStatus({ ok: false, text: errText(e) });
    }
  };
  const submit = () => {
    if (!c.name.trim()) return setStatus({ ok: false, text: tr("Enter a connection name", "Nhập tên kết nối") });
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
    <Modal title={editing ? tr("✏ Edit connection", "✏ Sửa kết nối") : tr("＋ New connection", "＋ Kết nối mới")} width={620} onClose={onClose}>
      <div className="form account-form">
        <label>{tr("Name", "Tên")}<input value={c.name} onChange={(e) => set({ name: e.target.value })} placeholder="vd. HRM dev" autoFocus /></label>
        <div className="field">
          <span className="field-cap">{tr("Type", "Loại")}</span>
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
              <label className="grow">{tr("Password", "Mật khẩu")}
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </label>
            </div>
            <label className="check">
              <input type="checkbox" checked={c.savePw !== false} onChange={(e) => set({ savePw: e.target.checked })} />
              {tr("Save password", "Lưu mật khẩu")}
            </label>
            <label>
              {c.driver === "cassandra" ? "Keyspace" : "Database"}
              <input value={c.database} onChange={(e) => set({ database: e.target.value })}
                placeholder={c.driver === "cassandra" ? tr("empty = list all keyspaces", "để trống = liệt kê mọi keyspace") : undefined} />
            </label>
          </>
        )}
        <div className="field">
          <span className="field-cap">{tr("Environment", "Môi trường")}</span>
          <div className="picker-field">
            <Picker
              label={<span className="ellipsis">{c.env}</span>}
              items={[
                { id: "dev", label: "dev", selected: c.env === "dev" },
                { id: "staging", label: "staging", selected: c.env === "staging" },
                { id: "prod", label: tr("prod (red border, confirm before writes)", "prod (viền đỏ, hỏi trước khi ghi)"), selected: c.env === "prod" },
              ]}
              onPick={(id) => set({ env: id as Conn["env"] })}
            />
          </div>
        </div>
        <div className="field">
          <span className="field-cap">{tr("Folder", "Thư mục")}</span>
          <div className="picker-field">
            <Picker
              label={<span className="ellipsis">{folders.find((f) => f.id === c.folderId)?.name ?? tr("(No folder)", "(Ngoài thư mục)")}</span>}
              items={[{ id: "", label: tr("(No folder)", "(Ngoài thư mục)"), selected: !c.folderId }, ...folders.map((f) => ({ id: f.id, label: f.name, selected: c.folderId === f.id }))]}
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
              /> {tr("Connect via SSH tunnel", "Kết nối qua SSH tunnel")}
            </label>
            {c.ssh?.enabled && (
              <div className="ssh-fields">
                <div className="form-row">
                  <label className="grow">SSH Host<input className="mono" value={c.ssh.host} onChange={(e) => set({ ssh: { ...c.ssh!, host: e.target.value } })} placeholder="jump.example.com" /></label>
                  <label style={{ width: 90 }}>Port<input className="mono" type="number" value={c.ssh.port} onChange={(e) => set({ ssh: { ...c.ssh!, port: Number(e.target.value) || 22 } })} /></label>
                  <label className="grow">SSH User<input value={c.ssh.user} onChange={(e) => set({ ssh: { ...c.ssh!, user: e.target.value } })} placeholder="ubuntu" /></label>
                </div>
                <label>{tr("Private key (BatchMode — needs key/agent, no password prompt)", "Private key (BatchMode — cần key/agent, không hỏi mật khẩu)")}
                  <div className="form-row">
                    <input className="grow mono" value={c.ssh.keyPath} onChange={(e) => set({ ssh: { ...c.ssh!, keyPath: e.target.value } })} placeholder={tr("empty = default key / ssh-agent", "để trống = key mặc định / ssh-agent")} />
                    <button onClick={() => void pickDbKey((p) => set({ ssh: { ...c.ssh!, keyPath: p } }))}>{tr("Browse…", "Chọn…")}</button>
                  </div>
                </label>
                <div className="muted small">{tr("DB connects: 127.0.0.1 → (ssh -L) →", "DB sẽ nối: 127.0.0.1 → (ssh -L) →")} <span className="mono">{c.host || "host"}:{c.port ?? "port"}</span> {tr("via the SSH server above.", "qua SSH server trên.")}</div>
              </div>
            )}
          </>
        )}
        <div className="toolbar">
          <button onClick={test}>{tr("Test connection", "Thử kết nối")}</button>
          <span className="grow" />
          {editing && (
            <button onClick={() => void confirmDialog({ message: tr(`Delete connection “${c.name || "this"}”? The saved password is also removed.`, `Xoá kết nối “${c.name || "này"}”? Mật khẩu đã lưu cũng bị xoá.`) }).then((ok) => { if (!ok) return; void call("db_forget_password", { id: c.id }).catch(() => {}); remove(c.id); onClose(); })}>{tr("Delete", "Xoá")}</button>
          )}
          <button className="primary" onClick={submit}>{tr("Save & open", "Lưu & mở")}</button>
        </div>
        {status && <div className={status.ok ? "muted" : "error-box"}>{status.text}</div>}
      </div>
    </Modal>
  );
}

/* ── Phiên làm việc với một kết nối ────────────── */

const READ_ONLY = /^\s*(select|show|describe|desc|explain|with|pragma|values)\b/i;
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
  const [sug, setSug] = useState<{ items: Sug[]; x: number; y: number; start: number; end: number } | null>(null);
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
  /** Database/schema đang dùng để chạy query (prepend USE / SET search_path). */
  const [activeDb, setActiveDb] = useState("");
  /** Database đang được chọn (click đơn) — khác activeDb (db đang USE). */
  const [selDb, setSelDb] = useState<string | null>(null);
  /** Menu chuột phải trên một database (Open / Edit / New / Dump). */
  const [dbMenu, setDbMenu] = useState<{ x: number; y: number; db: string } | null>(null);
  /** Modal tạo database mới / sửa charset-collation database. */
  const [newDbOpen, setNewDbOpen] = useState(false);
  const [alterDb, setAlterDb] = useState<string | null>(null);
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

  if (!conn) return <div className="empty">Kết nối này đã bị xoá.</div>;
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
      log(`db: đã kết nối ${conn.name} (${describe(conn)})`);
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
      const [ts, cols] = await Promise.all([
        call<TableInfo[]>("db_tables", { id: idArg, schema: db }),
        call<string[]>("db_columns", { id: idArg, schema: db }).catch(() => [] as string[]),
      ]);
      setTablesByDb((m) => ({ ...m, [db]: ts }));
      setColsByDb((m) => ({
        ...m,
        [db]: cols.map((s) => { const [ , t, c] = s.split("\u001f"); return { table: t ?? "", column: c ?? "" }; }),
      }));
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

  // Chọn database/schema cho query: prepend USE (MySQL) / SET search_path (Postgres) vào MỖI câu,
  // vì mỗi câu chạy trên một kết nối riêng của pool → phải đặt context lại từng câu. run_on! chỉ giữ
  // kết quả câu cuối nên câu SELECT vẫn ra đúng, USE/SET không ảnh hưởng hiển thị.
  const withActiveDb = (stmt: string): string => {
    const db = activeDb.trim();
    if (!db) return stmt;
    if (conn.driver === "mysql") return `USE \`${db.replace(/`/g, "``")}\`;\n${stmt}`;
    if (conn.driver === "postgres") return `SET search_path TO "${db.replace(/"/g, '""')}";\n${stmt}`;
    return stmt; // sqlite (một db) / cassandra (bảng đã qualify ks.table)
  };

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
    let wrote = false;
    try {
      for (let i = 0; i < stmts.length; i++) {
        const qid = `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
        runId.current = qid;
        const out = await call<QueryOut>("db_query", { id: dbId, sql: withActiveDb(stmts[i]), limit: ROW_LIMIT, queryId: qid, timeoutSecs });
        outs.push(out);
        setResults([...outs]); // cập nhật dần để thấy từng bảng khi chạy nhiều câu
        if (isWrite(stmts[i])) wrote = true;
      }
    } catch (e) {
      // Báo rõ câu nào lỗi (kèm câu lệnh) khi chạy nhiều câu.
      const idx = outs.length; // số câu đã chạy thành công = chỉ số câu lỗi
      const where = stmts.length > 1 ? tr(`Statement ${idx + 1}/${stmts.length} failed:\n${stmts[idx]}\n\n`, `Câu ${idx + 1}/${stmts.length} lỗi:\n${stmts[idx]}\n\n`) : "";
      setError(where + errText(e));
    } finally {
      runId.current = null;
      if (wrote) for (const db of expanded) void loadTables(dbId, db);
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
      const ok = await confirmDialog({ message: tr("Run this routine DDL on PROD?", "Chạy câu DDL routine này trên PROD?") });
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
          ? `CREATE EVENT ${q}\nON SCHEDULE EVERY 1 DAY\nSTARTS CURRENT_TIMESTAMP\nON COMPLETION PRESERVE\nENABLE\nDO\n  -- câu lệnh chạy định kỳ\n  SELECT 1;`
          : kind === "function"
          ? `CREATE FUNCTION ${q}(arg1 INT)\nRETURNS INT\nDETERMINISTIC\nBEGIN\n  RETURN arg1;\nEND`
          : `CREATE PROCEDURE ${q}(IN arg1 INT)\nBEGIN\n  -- viết câu lệnh ở đây\n  SELECT arg1;\nEND`;
    } else {
      const q = `"${dq(db)}"."${name}"`;
      sql =
        kind === "function"
          ? `CREATE OR REPLACE FUNCTION ${q}(arg1 int)\nRETURNS int\nLANGUAGE sql AS $$\n  SELECT arg1;\n$$;`
          : `CREATE OR REPLACE PROCEDURE ${q}(arg1 int)\nLANGUAGE plpgsql AS $$\nBEGIN\n  -- câu lệnh\nEND;\n$$;`;
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
        if (!row) { setError(tr("Event not found.", "Không tìm thấy event.")); return; }
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
    void confirmDialog({ message: tr(`Delete ${r.kind} “${r.name}”?`, `Xoá ${r.kind} “${r.name}”?`) }).then((ok) => {
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
      const tables = tablesByDb[db] ?? (await call<TableInfo[]>("db_tables", { id: dbId, schema: db }));
      let content = `-- Dump database ${db} — ${new Date().toISOString()}\n-- ${tables.length} table(s)\n\n`;
      for (const t of tables) {
        if (t.kind === "view") continue; // bỏ view (dump cấu trúc bảng trước đã)
        content += (await buildTableDump(t, withData)) + "\n";
      }
      const path = await saveDialog({ defaultPath: `${db}.sql`, filters: [{ name: "SQL", extensions: ["sql"] }] });
      if (typeof path !== "string") return;
      await invoke("write_text_file", { path, content });
      log(`db: dump database ${db} → ${path}`);
    } catch (e) {
      setError(errText(e));
    } finally {
      setDumping(false);
    }
  };

  /** Mục menu chuột phải trên một DATABASE (Open / Edit / New / Dump). */
  const databaseMenu = (db: string): CtxItem[] => {
    const isSql = conn.driver === "mysql" || conn.driver === "postgres" || conn.driver === "sqlite";
    const items: CtxItem[] = [
      { id: "open", label: tr("Open (use for queries)", "Mở (USE để query)"), action: () => openDb(db) },
    ];
    if (opened.has(db)) {
      items.push(expanded.has(db)
        ? { id: "collapse", label: tr("Collapse (keep open)", "Tạm đóng (vẫn mở)"), action: () => toggleExpand(db) }
        : { id: "expand", label: tr("Expand", "Mở rộng"), action: () => toggleExpand(db) });
      items.push({ id: "closedb", label: tr("Close database (disconnect)", "Đóng kết nối database"), action: () => closeDb(db) });
    }
    if (conn.driver === "mysql") {
      items.push({ id: "edit", label: tr("Edit (charset/collation)…", "Sửa (charset/collation)…"), action: () => setAlterDb(db) });
    }
    if (conn.driver === "mysql" || conn.driver === "postgres") {
      items.push({ id: "new", label: conn.driver === "postgres" ? tr("New schema…", "Schema mới…") : tr("New database…", "Database mới…"), action: () => setNewDbOpen(true) });
    }
    // Tạo routine mới trong database này (procedure/function, và event với MySQL).
    if (conn.driver === "mysql" || conn.driver === "postgres") {
      items.push(
        { id: "sr", sep: true },
        { id: "newproc", label: tr("New procedure…", "Procedure mới…"), action: () => { openDb(db); newRoutine(db, "procedure"); } },
        { id: "newfunc", label: tr("New function…", "Function mới…"), action: () => { openDb(db); newRoutine(db, "function"); } },
      );
      if (conn.driver === "mysql") {
        items.push({ id: "newevent", label: tr("New event (schedule)…", "Event mới (lập lịch)…"), action: () => { openDb(db); newRoutine(db, "event"); } });
      }
    }
    if (isSql) {
      items.push(
        { id: "s1", sep: true },
        { id: "dumpStruct", label: tr("Dump SQL (structure)", "Dump SQL (cấu trúc)"), disabled: dumping, action: () => void dumpDatabase(db, false) },
        { id: "dumpAll", label: tr("Dump SQL (structure + data)", "Dump SQL (cấu trúc + dữ liệu)"), disabled: dumping, action: () => void dumpDatabase(db, true) },
      );
    }
    // Xoá database/schema/keyspace (DROP) — vĩnh viễn, hỏi xác nhận mạnh.
    if (conn.driver === "mysql" || conn.driver === "postgres" || conn.driver === "cassandra") {
      const dropLabel =
        conn.driver === "postgres" ? tr("Delete schema (DROP)…", "Xoá schema (DROP)…")
        : conn.driver === "cassandra" ? tr("Delete keyspace (DROP)…", "Xoá keyspace (DROP)…")
        : tr("Delete database (DROP)…", "Xoá database (DROP)…");
      const dropSql =
        conn.driver === "postgres" ? `DROP SCHEMA "${db.replace(/"/g, '""')}" CASCADE;`
        : conn.driver === "cassandra" ? `DROP KEYSPACE "${db.replace(/"/g, '""')}";`
        : `DROP DATABASE \`${db.replace(/`/g, "``")}\`;`;
      items.push(
        { id: "s3", sep: true },
        { id: "drop", label: dropLabel, danger: true, action: () => void confirmDialog({
          message: tr(
            `PERMANENTLY delete “${db}” and ALL tables/data inside it? This cannot be undone.`,
            `Xoá VĨNH VIỄN “${db}” và TOÀN BỘ bảng/dữ liệu bên trong? Không thể hoàn tác.`,
          ),
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
      { id: "refresh", label: tr("Refresh", "Tải lại"), action: () => dbIdRef.current && void loadTables(dbIdRef.current, db) },
      { id: "copy", label: tr("Copy name", "Copy tên"), action: () => void navigator.clipboard.writeText(db) },
    );
    return items;
  };

  /** Mục menu chuột phải trên bảng (kiểu Navicat). */
  const tableMenu = (t: TableInfo): CtxItem[] => {
    const ref = quote(conn, t);
    const truncSql = conn.driver === "sqlite" ? `DELETE FROM ${ref};` : `TRUNCATE TABLE ${ref};`;
    const ask = (msg: string, sql: string) => () =>
      void confirmDialog({ message: msg }).then((ok) => { if (ok) void exec(sql); });
    const copyItem: CtxItem = { id: "copy", label: tr("Copy table name", "Copy tên bảng"), action: () => void navigator.clipboard.writeText(t.name) };
    // Cassandra (CQL): bỏ các mục DDL/dump đặc thù SQL; giữ xem dữ liệu / cấu trúc / TRUNCATE / DROP.
    if (conn.driver === "cassandra") {
      return [
        { id: "open", label: tr("View data (SELECT *)", "Xem dữ liệu (SELECT *)"), action: () => openTable(t) },
        { id: "s1", sep: true },
        { id: "edit", label: tr("Edit table (structure)…", "Edit table (cấu trúc)…"), action: () => setStructT(t) },
        { id: "s2", sep: true },
        { id: "truncate", label: "Truncate…", danger: true, action: ask(tr(`TRUNCATE table “${t.name}”?`, `TRUNCATE bảng “${t.name}”?`), truncSql) },
        { id: "drop", label: tr("Delete table (DROP)…", "Delete table (DROP)…"), danger: true, action: ask(tr(`PERMANENTLY delete table “${t.name}” and all its data?`, `Xoá VĨNH VIỄN bảng “${t.name}” và toàn bộ dữ liệu?`), `DROP TABLE ${ref};`) },
        { id: "s4", sep: true },
        copyItem,
      ];
    }
    return [
      { id: "open", label: tr("View data (SELECT *)", "Xem dữ liệu (SELECT *)"), action: () => openTable(t) },
      { id: "s1", sep: true },
      { id: "edit", label: tr("Edit table (structure)…", "Edit table (cấu trúc)…"), action: () => setStructT(t) },
      { id: "new", label: tr("New table…", "Bảng mới…"), action: () => setNewTable({ schema: t.schema }) },
      { id: "col", label: tr("Add column…", "Thêm cột…"), action: () => setDdl({ kind: "col", t }) },
      { id: "idx", label: tr("Add index…", "Thêm index…"), action: () => setDdl({ kind: "idx", t }) },
      { id: "s2", sep: true },
      { id: "dumpStruct", label: tr("Dump SQL (structure)", "Dump SQL (cấu trúc)"), disabled: dumping, action: () => void dumpTable(t, false) },
      { id: "dumpAll", label: tr("Dump SQL (structure + data)", "Dump SQL (cấu trúc + dữ liệu)"), disabled: dumping, action: () => void dumpTable(t, true) },
      { id: "s3", sep: true },
      { id: "empty", label: tr("Empty (delete rows)…", "Empty (xoá dữ liệu)…"), danger: true, action: ask(tr(`Delete all data in “${t.name}”?`, `Xoá toàn bộ dữ liệu trong “${t.name}”?`), `DELETE FROM ${ref};`) },
      { id: "truncate", label: conn.driver === "sqlite" ? tr("Empty (SQLite has no TRUNCATE)…", "Empty (SQLite không có TRUNCATE)…") : "Truncate…", danger: true, action: ask(tr(`TRUNCATE table “${t.name}”?`, `TRUNCATE bảng “${t.name}”?`), truncSql) },
      { id: "drop", label: tr("Delete table (DROP)…", "Delete table (DROP)…"), danger: true, action: ask(tr(`PERMANENTLY delete table “${t.name}” and all its data?`, `Xoá VĨNH VIỄN bảng “${t.name}” và toàn bộ dữ liệu?`), `DROP TABLE ${ref};`) },
      { id: "s4", sep: true },
      copyItem,
    ];
  };

  const openTable = (t: TableInfo) => {
    const q = `SELECT * FROM ${quote(conn, t)} LIMIT 100;`;
    // Không xoá câu lệnh đang viết: chỉ điền khi ô còn trống, ngược lại chạy luôn vào bảng kết quả.
    if (!sql.trim()) setSql(q);
    void exec(q);
  };

  if (!dbId) {
    // Nền: màn hình chờ (spinner). Khi cần mật khẩu thì hiện MODAL nhập đè lên trên.
    const connectingScreen = (
      <div className="view">
        <div className="db-connecting">
          <span className="spinner" />
          <div>{tr("Connecting to", "Đang kết nối")} <b>{conn.name}</b>…</div>
          <div className="muted small">{DRIVERS[conn.driver].name} · {describe(conn)}</div>
        </div>
      </div>
    );
    if (connecting || !needPw) return connectingScreen;
    return (
      <>
        {connectingScreen}
        <Modal title={tr("🔑 Enter password", "🔑 Nhập mật khẩu")} width={480} onClose={() => useWorkbench.getState().closeTab(tab.id)}>
          <div className="form account-form">
            <div className="muted small">{conn.name} — {DRIVERS[conn.driver].name} · {describe(conn)}</div>
            <label>{tr("Password", "Mật khẩu")}
              <input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && connect()} />
            </label>
            <label className="check">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              {tr("Save password", "Lưu mật khẩu")}
            </label>
            {error && <div className="error-box">⚠ {error}</div>}
            <div className="toolbar">
              <button onClick={() => openForm(conn.id)}>{tr("Edit config", "Sửa cấu hình")}</button>
              <span className="grow" />
              <button onClick={() => useWorkbench.getState().closeTab(tab.id)}>{tr("Cancel", "Huỷ")}</button>
              <button className="primary" disabled={connecting} onClick={() => connect()}>{connecting ? tr("Connecting…", "Đang kết nối…") : tr("Connect", "Kết nối")}</button>
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

    // Giữ thứ tự ưu tiên (bảng → cột → database → từ khoá), chỉ lọc theo tiền tố.
    const matched = items.filter((s) => s.label.toLowerCase().startsWith(prefix)).slice(0, 12);
    if (!matched.length) return setSug(null);
    const { x, y } = caretXY(el, pos);
    setSug({ items: matched, x, y, start, end: pos });
    setSugIdx(0);
  };

  const acceptSug = (i: number) => {
    if (!sug) return;
    const el = editor.current;
    const it = sug.items[i];
    if (!el || !it) return setSug(null);
    const next = el.value.slice(0, sug.start) + it.label + el.value.slice(sug.end);
    const caret = sug.start + it.label.length;
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
      <div key={`${t.schema}.${t.name}`} className="side-item" style={{ paddingLeft: padLeft }}
        tabIndex={0}
        onClick={() => openTable(t)}
        onKeyDown={(e) => { if (e.key === "F2" && conn.driver !== "cassandra") { e.preventDefault(); setRenaming({ t, name: t.name }); } }}
        onContextMenu={(e) => { e.preventDefault(); setTblMenu({ x: e.clientX, y: e.clientY, t }); }}
        title={`${t.schema}.${t.name} — ${tr("F2 to rename, right-click for actions", "F2 đổi tên, chuột phải để thao tác")}`}>
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
          title={onNew ? tr("Right-click: new…", "Chuột phải: tạo mới…") : undefined}>
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
      title={`${r.name} — ${tr("double-click to view/edit, right-click for actions", "double-click để xem/sửa, chuột phải để thao tác")}`}>
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
    const rlabel: Record<RoutineKind, string> = { procedure: tr("Procedures", "Procedures"), function: tr("Functions", "Functions"), event: tr("Events", "Events") };
    return (
      <>
        {(!fl || tables.length > 0) && section(`${db}|tables`, pad, true, <TableIcon />, tr("Tables", "Tables"), tables.length, tables.map((t) => tableRow(t, ip)))}
        {views.length > 0 && section(`${db}|views`, pad, true, "👁", tr("Views", "Views"), views.length, views.map((t) => tableRow(t, ip)))}
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
          placeholder={singleDb ? tr(`Filter tables in ${singleDb}…`, `Lọc bảng trong ${singleDb}…`) : tr(`Filter in ${dbs.length} databases…`, `Lọc trong ${dbs.length} database…`)}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <div className="db-table-list">
          {singleDb ? (
            // Đã chỉ đích danh db trong cấu hình → hiện nhóm (Tables/Views/…), không có node database.
            loadingDbs.has(singleDb) && !tablesByDb[singleDb]
              ? <div className="muted small pad">{tr("loading…", "đang tải…")}</div>
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
                    title={`${db} — ${opened.has(db) ? tr("double-click to collapse/expand; right-click to close", "double-click để tạm đóng/mở; chuột phải để đóng kết nối") : tr("double-click to open & use", "double-click để mở & USE")}`}
                  >
                    {opened.has(db)
                      ? <span className="tree-caret" onClick={(e) => { e.stopPropagation(); toggleExpand(db); }} title={expanded.has(db) ? tr("Collapse", "Tạm đóng") : tr("Expand", "Mở rộng")}>{expanded.has(db) ? "▾" : "▸"}</span>
                      : <span className="tree-caret" />}
                    <span className="tree-icon"><DbIcon /></span>
                    <span className="grow ellipsis">{db}</span>
                    {db === activeDb && <span className="env-tag use" title={tr("Current query database", "Database đang chạy query")}>USE</span>}
                    {tablesByDb[db] && <span className="muted small">{tablesByDb[db].length}</span>}
                  </div>
                  {expanded.has(db) && (
                    loadingDbs.has(db) && !tablesByDb[db]
                      ? <div className="muted small pad" style={{ paddingLeft: 24 }}>{tr("loading…", "đang tải…")}</div>
                      : dbChildren(db, 22)
                  )}
                </div>
              ))}
              {!dbs.length && <div className="muted small pad">{tr("No databases.", "Không có database nào.")}</div>}
            </>
          )}
        </div>
      </div>
      <Splitter axis="x" onResize={(d) => setTablesW((w) => w + d)} onReset={() => setTablesW(220)} />
      <div className="view">
        <div className="toolbar db-toolbar">
          <span className="dot green" /> {describe(conn)}
          {dbs.length > 0 && conn.driver !== "sqlite" && (
            <span className="db-active" title={tr("Database used to run queries (USE / search_path)", "Database dùng để chạy query (USE / search_path)")}>
              <Picker
                label={<><span className="tree-icon"><DbIcon /></span> {activeDb || tr("(default)", "(mặc định)")}</>}
                items={dbs.map((d) => ({ id: d, label: d, selected: d === activeDb }))}
                onPick={(d) => { setSelDb(d); openDb(d); }}
                filterPlaceholder={tr("Filter databases…", "Lọc database…")}
              />
            </span>
          )}
          <span className="grow" />
          <Picker
            label={<>📑 {curQueryName || tr("Queries", "Query đã lưu")}{savedQueries.length ? ` (${savedQueries.length})` : ""}</>}
            title={tr("Saved queries for this connection — pick to load, right-click to rename/delete", "Query đã lưu của kết nối này — chọn để nạp, chuột phải để đổi tên/xoá")}
            items={savedQueries.length
              ? savedQueries.map((q) => ({ id: q.id, label: q.name, selected: q.name === curQueryName }))
              : [{ id: "__none__", label: tr("(no saved queries)", "(chưa có query nào)"), disabled: true }]}
            onPick={(id) => { const q = savedQueries.find((x) => x.id === id); if (q) { setSql(q.sql); setCurQueryName(q.name); } }}
            onItemContextMenu={(id, e) => { if (id === "__none__") return; setQMenu({ x: e.clientX, y: e.clientY, id }); }}
            filterPlaceholder={tr("Filter queries…", "Lọc query…")}
          />
          <button
            onClick={() => { if (!sql.trim()) return; setSaveName(curQueryName || deriveQueryName(sql)); }}
            disabled={!sql.trim()}
            title={tr("Save current SQL as a named query", "Lưu câu SQL hiện tại thành query có tên")}
          >💾 {tr("Save", "Lưu")}</button>
          {conn.driver !== "cassandra" && (
            <button onClick={() => setSyncOpen(true)} title={tr("Sync structure between databases (pick server then database)", "Đồng bộ cấu trúc giữa các database (chọn server rồi chọn database)")}>⇄ Struct sync</button>
          )}
          <label className="db-timeout" title={tr("Statement timeout in seconds (0 = unlimited)", "Giới hạn thời gian mỗi câu (giây, 0 = không giới hạn)")}>
            ⏱
            <input
              type="number"
              min={0}
              value={timeoutSecs}
              onChange={(e) => { const v = Math.max(0, Number(e.target.value) || 0); setTimeoutSecs(v); localStorage.setItem("db.timeoutSecs", String(v)); }}
            />s
          </label>
          {conn.driver !== "cassandra" && (
            <button disabled={running} onClick={runExplain} title={tr("Show execution plan of selected statement", "Xem kế hoạch thực thi câu lệnh đang chọn")}>EXPLAIN</button>
          )}
          {running
            ? <button className="danger" onClick={cancelRun} title={tr("Stop the running statement", "Dừng câu lệnh đang chạy")}>■ {tr("Cancel", "Hủy")}</button>
            : <button className="primary" onClick={runEditor} title={tr("Run (Ctrl+Enter / Ctrl+R) — select text to run only that part", "Chạy (Ctrl+Enter / Ctrl+R) — bôi đen để chạy riêng phần đó")}>{tr("▶ Run", "▶ Chạy")}</button>}
        </div>
        <textarea
          ref={editor}
          className="db-editor mono"
          value={sql}
          spellCheck={false}
          placeholder={tr("SELECT … — Ctrl+Enter or Ctrl+R to run (select to run part)", "SELECT … — Ctrl+Enter hoặc Ctrl+R để chạy (bôi đen để chạy một phần)")}
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
                <span className="grow ellipsis">{it.label}</span>
                {it.hint && <span className="muted small ellipsis">{it.hint}</span>}
              </div>
            ))}
          </div>
        )}
        {confirmSql && (
          <div className="error-box toolbar">
            {tr("⚠ This is a PROD connection and the statement writes data. Run for real?", "⚠ Đây là kết nối PROD và câu lệnh có ghi dữ liệu. Chạy thật?")}
            <span className="grow" />
            <button onClick={() => setConfirmSql(null)}>{tr("Cancel", "Huỷ")}</button>
            <button className="primary danger" onClick={() => exec(confirmSql, true)}>{tr("Run on PROD", "Chạy trên PROD")}</button>
          </div>
        )}
        {error && <div className="error-box">⚠ {error}</div>}
        {results.length > 1 ? (
          <div className="results-list">
            {results.map((o, i) => (
              <ResultGrid key={i} out={o} title={`${tr("Result", "Kết quả")} ${i + 1}/${results.length}`} />
            ))}
          </div>
        ) : results.length === 1 ? (
          <ResultGrid out={results[0]} />
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
            { id: "view", label: tr("View / edit definition…", "Xem / sửa định nghĩa…"), action: () => void openRoutine(routineMenu.r) },
            { id: "copy", label: tr("Copy name", "Copy tên"), action: () => void navigator.clipboard.writeText(routineMenu.r.name) },
            { id: "s1", sep: true },
            { id: "drop", label: tr("Delete (DROP)…", "Xoá (DROP)…"), danger: true, action: () => dropRoutine(routineMenu.r) },
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
              { id: "load", label: tr("Load into editor", "Nạp vào editor"), action: () => { setSql(q.sql); setCurQueryName(q.name); } },
              { id: "rename", label: tr("Rename…", "Đổi tên…"), action: () => setRenameQ({ id: q.id, name: q.name }) },
              { id: "s1", sep: true },
              { id: "del", label: tr("Delete query", "Xoá query"), danger: true, action: () => void confirmDialog({ message: tr(`Delete saved query “${q.name}”?`, `Xoá query đã lưu “${q.name}”?`) }).then((ok) => { if (ok) { removeQuery(q.id); if (curQueryName === q.name) setCurQueryName(""); } }) },
            ] as CtxItem[];
          })()}
        />
      )}
      {saveName !== null && (
        <Modal title={tr("💾 Save query", "💾 Lưu query")} width={440} onClose={() => setSaveName(null)}>
          <div className="form account-form">
            <label>{tr("Name", "Tên")}
              <input
                autoFocus
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && saveName.trim()) { saveQuery(connId, saveName.trim(), sql); setCurQueryName(saveName.trim()); setSaveName(null); } }}
                placeholder={tr("e.g. active users report", "vd. báo cáo user active")}
              />
            </label>
            {savedQueries.some((q) => q.name === saveName.trim()) && (
              <div className="muted small">{tr("A query with this name exists — it will be overwritten.", "Đã có query trùng tên — sẽ ghi đè.")}</div>
            )}
            <div className="toolbar">
              <span className="grow" />
              <button onClick={() => setSaveName(null)}>{tr("Cancel", "Huỷ")}</button>
              <button className="primary" disabled={!saveName.trim()} onClick={() => { saveQuery(connId, saveName.trim(), sql); setCurQueryName(saveName.trim()); setSaveName(null); }}>{tr("Save", "Lưu")}</button>
            </div>
          </div>
        </Modal>
      )}
      {renameQ && (
        <Modal title={tr("✎ Rename query", "✎ Đổi tên query")} width={440} onClose={() => setRenameQ(null)}>
          <div className="form account-form">
            <label>{tr("Name", "Tên")}
              <input
                autoFocus
                value={renameQ.name}
                onChange={(e) => setRenameQ({ ...renameQ, name: e.target.value })}
                onKeyDown={(e) => { if (e.key === "Enter" && renameQ.name.trim()) { const old = savedQueries.find((x) => x.id === renameQ.id); renameQuery(renameQ.id, renameQ.name.trim()); if (old && curQueryName === old.name) setCurQueryName(renameQ.name.trim()); setRenameQ(null); } }}
              />
            </label>
            <div className="toolbar">
              <span className="grow" />
              <button onClick={() => setRenameQ(null)}>{tr("Cancel", "Huỷ")}</button>
              <button className="primary" disabled={!renameQ.name.trim()} onClick={() => { const old = savedQueries.find((x) => x.id === renameQ.id); renameQuery(renameQ.id, renameQ.name.trim()); if (old && curQueryName === old.name) setCurQueryName(renameQ.name.trim()); setRenameQ(null); }}>{tr("Rename", "Đổi tên")}</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* Memo: bảng kết quả có thể rất lớn — không vẽ lại mỗi lần gõ phím trong ô SQL (out không đổi). */
const ResultGrid = memo(function ResultGrid({ out, title }: { out: QueryOut | null; title?: string }) {
  const lang = getLang();
  const rows = (vi: string, en: string) => (lang === "vi" ? vi : en);
  if (!out) return <div className="pane"><div className="empty">{rows("Kết quả hiện ở đây", "Results appear here")}</div></div>;
  const info = out.columns.length
    ? rows(`${out.rows.length}${out.truncated ? `+ (chỉ hiện ${ROW_LIMIT} dòng đầu)` : ""} dòng`, `${out.rows.length}${out.truncated ? `+ (first ${ROW_LIMIT} rows)` : ""} rows`)
    : rows(`${out.rowsAffected} dòng bị ảnh hưởng`, `${out.rowsAffected} rows affected`);
  return (
    <div className="pane result-pane">
      <div className="pane-title">
        {title && <b className="muted">{title} · </b>}{info} · {out.elapsedMs} ms <span className="grow" />
        {out.columns.length > 0 && (
          <button onClick={() => navigator.clipboard.writeText(toTsv(out))} title={rows("Dán thẳng vào Excel", "Paste into Excel")}>Copy (TSV)</button>
        )}
      </div>
      {out.columns.length > 0 ? (
        <div className="grid-wrap">
          <table className="grid mono">
            <thead>
              <tr><th>#</th>{out.columns.map((c, i) => <th key={i}>{c}</th>)}</tr>
            </thead>
            <tbody>
              {out.rows.map((r, i) => (
                <tr key={i}>
                  <td className="muted">{i + 1}</td>
                  {r.map((v, j) => (v === null ? <td key={j} className="null">NULL</td> : <td key={j} className="cell" title={v}>{v}</td>))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty">{rows("✓ Xong", "✓ Done")}</div>
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
    <Modal title={kind === "col" ? `➕ ${tr("Add column", "Thêm cột")} — ${table.name}` : `➕ ${tr("Add index", "Thêm index")} — ${table.name}`} width={560} onClose={onClose}>
      <div className="form account-form">
        {kind === "col" ? (
          <>
            <div className="form-row">
              <label className="grow">{tr("Column name", "Tên cột")}<input autoFocus className="mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="created_at" /></label>
              <div className="field grow" style={{ flex: 1 }}>
                <span className="field-cap">{tr("Data type", "Kiểu dữ liệu")}</span>
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
              <label className="grow">{tr("Default value (optional)", "Giá trị mặc định (tuỳ chọn)")}<input className="mono" value={def} onChange={(e) => setDef(e.target.value)} placeholder="NULL / 0 / CURRENT_TIMESTAMP" /></label>
            </div>
            <label className="check"><input type="checkbox" checked={notNull} onChange={(e) => setNotNull(e.target.checked)} /> NOT NULL</label>
          </>
        ) : (
          <>
            <div className="form-row">
              <label className="grow">{tr("Index name", "Tên index")}<input autoFocus className="mono" value={name} onChange={(e) => setName(e.target.value)} /></label>
            </div>
            <label>{tr("Columns (comma-separated)", "Cột (cách nhau dấu phẩy)")}<input className="mono" value={cols} onChange={(e) => setCols(e.target.value)} placeholder="user_id, created_at" /></label>
            <label className="check"><input type="checkbox" checked={uniq} onChange={(e) => setUniq(e.target.checked)} /> UNIQUE</label>
          </>
        )}
        <div className="field">
          <span className="field-cap">{tr("SQL to run", "SQL sẽ chạy")}</span>
          <pre className="sql-preview mono">{sql}</pre>
        </div>
        <div className="toolbar">
          <span className="grow" />
          <button onClick={onClose}>{tr("Cancel", "Huỷ")}</button>
          <button className="primary" disabled={!valid} onClick={() => { onRun(sql); onClose(); }}>{tr("Run", "Chạy")}</button>
        </div>
      </div>
    </Modal>
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
        {!cols ? <div className="muted small">{tr("loading…", "đang tải…")}</div> : (
          <div className="grid-wrap" style={{ maxHeight: "50vh" }}>
            <table className="grid mono">
              <thead><tr><th>{tr("Column", "Cột")}</th><th>{tr("Type", "Kiểu")}</th><th>Null</th><th>Key</th><th>Default</th></tr></thead>
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
          <button onClick={onAddColumn}>＋ {tr("Add column", "Thêm cột")}</button>
          <span className="grow" />
          <button onClick={onClose}>{tr("Close", "Đóng")}</button>
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
    <Modal title={tr("➕ New table", "➕ Bảng mới")} width={620} onClose={onClose}>
      <div className="form account-form">
        <label>{tr("Table name", "Tên bảng")}<input autoFocus className="mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="orders" /></label>
        <label>{tr("Column definitions (one per line)", "Định nghĩa cột (mỗi dòng một cột)")}
          <textarea className="mono" style={{ minHeight: 110 }} value={cols} onChange={(e) => setCols(e.target.value)} spellCheck={false} />
        </label>
        <div className="field"><span className="field-cap">{tr("SQL to run", "SQL sẽ chạy")}</span><pre className="sql-preview mono">{sql}</pre></div>
        <div className="toolbar">
          <span className="grow" />
          <button onClick={onClose}>{tr("Cancel", "Huỷ")}</button>
          <button className="primary" disabled={!name.trim()} onClick={() => { onRun(sql); onClose(); }}>{tr("Create table", "Tạo bảng")}</button>
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
  const kindLabel = info.kind === "event" ? tr("event", "event") : info.kind === "function" ? tr("function", "function") : tr("procedure", "procedure");
  const title = info.mode === "new"
    ? tr(`➕ New ${kindLabel} in ${info.db}`, `➕ ${kindLabel} mới trong ${info.db}`)
    : tr(`✎ Edit ${kindLabel} “${info.name}”`, `✎ Sửa ${kindLabel} “${info.name}”`);
  void driver;
  return (
    <Modal title={title} width={720} onClose={onClose}>
      <div className="form account-form" style={{ maxWidth: "none" }}>
        {info.kind === "event" && (
          <div className="muted small">{tr("Event scheduler must be ON: SET GLOBAL event_scheduler = ON;", "Bộ lập lịch phải bật: SET GLOBAL event_scheduler = ON;")}</div>
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
          <span className="muted small">{info.mode === "edit" ? tr("Saving drops & recreates it.", "Lưu sẽ xoá rồi tạo lại.") : tr("Runs as a single statement.", "Chạy như một câu lệnh.")}</span>
          <span className="grow" />
          <button onClick={onClose}>{tr("Cancel", "Huỷ")}</button>
          <button className="primary" disabled={running || !sql.trim()} onClick={() => onRun(sql)}>{running ? tr("Running…", "Đang chạy…") : tr("▶ Run", "▶ Chạy")}</button>
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
  const [body, setBody] = useState(init?.body ?? "-- câu lệnh chạy định kỳ\nSELECT 1;");

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
    ? tr(`⏰ Edit event “${init?.name ?? name}”`, `⏰ Sửa event “${init?.name ?? name}”`)
    : tr(`⏰ New event in ${db}`, `⏰ Event mới trong ${db}`);
  return (
    <Modal title={title} width={720} onClose={onClose}>
      <div className="form account-form" style={{ maxWidth: "none" }}>
        <div className="muted small">{tr("Event scheduler must be ON: SET GLOBAL event_scheduler = ON;", "Bộ lập lịch phải bật: SET GLOBAL event_scheduler = ON;")}</div>
        <label>{tr("Event name", "Tên event")}
          <input autoFocus className="mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="my_event" />
        </label>
        <div className="form-row">
          <div className="field grow">
            <span className="field-cap">{tr("Schedule", "Lịch chạy")}</span>
            <div className="picker-field">
              <Picker
                label={<span className="ellipsis">{mode === "every" ? tr("Every (recurring)", "Lặp lại (EVERY)") : tr("At (one time)", "Một lần (AT)")}</span>}
                items={[
                  { id: "every", label: tr("Every (recurring)", "Lặp lại (EVERY)"), selected: mode === "every" },
                  { id: "at", label: tr("At (one time)", "Một lần (AT)"), selected: mode === "at" },
                ]}
                onPick={(m) => setMode(m as "every" | "at")}
              />
            </div>
          </div>
          <div className="field grow">
            <span className="field-cap">{tr("Status", "Trạng thái")}</span>
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
              <label style={{ width: 120 }}>{tr("Every", "Mỗi")}
                <input className="mono" type="number" min={1} value={every} onChange={(e) => setEvery(e.target.value)} />
              </label>
              <div className="field grow">
                <span className="field-cap">{tr("Unit", "Đơn vị")}</span>
                <div className="picker-field">
                  <Picker label={<span className="ellipsis">{unit}</span>} items={EVENT_UNITS.map((u) => ({ id: u, label: u, selected: u === unit }))} onPick={setUnit} />
                </div>
              </div>
            </div>
            <div className="form-row">
              <label className="grow">{tr("Starts", "Bắt đầu")}
                <input className="mono" value={starts} onChange={(e) => setStarts(e.target.value)} placeholder="CURRENT_TIMESTAMP / 2026-01-01 00:00:00" />
              </label>
              <label className="grow">{tr("Ends (optional)", "Kết thúc (tuỳ chọn)")}
                <input className="mono" value={ends} onChange={(e) => setEnds(e.target.value)} placeholder={tr("empty = no end", "trống = không kết thúc")} />
              </label>
            </div>
          </>
        ) : (
          <label>{tr("Execute at", "Chạy lúc")}
            <input className="mono" value={at} onChange={(e) => setAt(e.target.value)} placeholder="CURRENT_TIMESTAMP + INTERVAL 1 HOUR" />
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={preserve} onChange={(e) => setPreserve(e.target.checked)} />
          {tr("Keep event after it finishes (ON COMPLETION PRESERVE)", "Giữ event sau khi chạy xong (ON COMPLETION PRESERVE)")}
        </label>
        <label>{tr("Comment (optional)", "Ghi chú (tuỳ chọn)")}
          <input value={comment} onChange={(e) => setComment(e.target.value)} />
        </label>
        <div className="field">
          <span className="field-cap">{tr("Body (DO)", "Thân lệnh (DO)")}</span>
          <textarea className="db-editor mono" style={{ minHeight: 120, width: "100%" }} spellCheck={false} value={body} onChange={(e) => setBody(e.target.value)} />
        </div>
        <div className="field"><span className="field-cap">{tr("SQL to run", "SQL sẽ chạy")}</span><pre className="sql-preview mono">{sql}</pre></div>
        <div className="toolbar">
          <button onClick={() => onRawEdit(sql)} title={tr("Switch to raw SQL editor", "Chuyển sang soạn SQL thô")}>{tr("Edit SQL…", "Sửa SQL…")}</button>
          {emode === "edit" && <span className="muted small">{tr("Saving drops & recreates it.", "Lưu sẽ xoá rồi tạo lại.")}</span>}
          <span className="grow" />
          <button onClick={onClose}>{tr("Cancel", "Huỷ")}</button>
          <button className="primary" disabled={running || !name.trim()} onClick={() => onRun(sql, init?.name)}>{running ? tr("Running…", "Đang chạy…") : emode === "edit" ? tr("▶ Save", "▶ Lưu") : tr("▶ Create", "▶ Tạo")}</button>
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
        <span className="field-cap">{tr("Charset", "Charset")}</span>
        <div className="picker-field">
          <Picker
            label={<span className="ellipsis">{charset || tr("(server default)", "(mặc định server)")}</span>}
            items={charsets.map((c) => ({ id: c.name, label: c.name, selected: c.name === charset }))}
            onPick={(cs) => { setCharset(cs); const d = charsets.find((x) => x.name === cs)?.def; setCollation(d || ""); }}
            filterPlaceholder={tr("Filter charset…", "Lọc charset…")}
          />
        </div>
      </div>
      <div className="field grow">
        <span className="field-cap">{tr("Collation", "Collation")}</span>
        <div className="picker-field">
          <Picker
            label={<span className="ellipsis">{collation || tr("(default)", "(mặc định)")}</span>}
            items={collOpts.map((c) => ({ id: c, label: c, selected: c === collation }))}
            onPick={(c) => setCollation(c)}
            filterPlaceholder={tr("Filter collation…", "Lọc collation…")}
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
    <Modal title={pg ? tr("➕ New schema", "➕ Schema mới") : tr("➕ New database", "➕ Database mới")} width={560} onClose={onClose}>
      <div className="form account-form">
        <label>{pg ? tr("Schema name", "Tên schema") : tr("Database name", "Tên database")}
          <input autoFocus className="mono" value={name} onChange={(e) => setName(e.target.value)} placeholder={pg ? "reporting" : "myapp"} />
        </label>
        {mysql && (
          <CharsetCollationFields dbId={dbId} charset={charset} setCharset={setCharset} collation={collation} setCollation={setCollation} />
        )}
        <div className="field"><span className="field-cap">{tr("SQL to run", "SQL sẽ chạy")}</span><pre className="sql-preview mono">{sql}</pre></div>
        <div className="toolbar">
          <span className="grow" />
          <button onClick={onClose}>{tr("Cancel", "Huỷ")}</button>
          <button className="primary" disabled={!name.trim()} onClick={() => { onRun(sql); onClose(); }}>{tr("Create", "Tạo")}</button>
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
    <Modal title={tr(`✎ Edit database “${db}”`, `✎ Sửa database “${db}”`)} width={560} onClose={onClose}>
      <div className="form account-form">
        <CharsetCollationFields dbId={dbId} charset={charset} setCharset={setCharset} collation={collation} setCollation={setCollation} />
        <div className="muted small">{tr("Sets default charset/collation for NEW tables; existing tables keep theirs.", "Đặt charset/collation mặc định cho bảng MỚI; bảng cũ giữ nguyên.")}</div>
        <div className="field"><span className="field-cap">{tr("SQL to run", "SQL sẽ chạy")}</span><pre className="sql-preview mono">{sql}</pre></div>
        <div className="toolbar">
          <span className="grow" />
          <button onClick={onClose}>{tr("Cancel", "Huỷ")}</button>
          <button className="primary" onClick={() => { onRun(sql); onClose(); }}>{tr("Run", "Chạy")}</button>
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

function buildSyncSql(conn: Conn, dstSchema: string, src: Record<string, ScCol[]>, dst: Record<string, ScCol[]>, dropExtra: boolean) {
  const qi = (s: string) => (conn.driver === "mysql" ? `\`${s}\`` : `"${s}"`);
  const ref = (t: string) =>
    dstSchema && conn.driver !== "sqlite" ? `${qi(dstSchema)}.${qi(t)}` : qi(t);
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const stmts: string[] = [];
  const notes: string[] = [];
  const colDef = (c: ScCol) => `${qi(c.name)} ${c.type}${c.nn ? " NOT NULL" : ""}${c.def ? ` DEFAULT ${c.def}` : ""}`;

  for (const [tbl, scols] of Object.entries(src)) {
    const dcols = dst[tbl];
    if (!dcols) {
      const lines = scols.map((c) => `  ${colDef(c)}`);
      const pks = scols.filter((c) => c.key === "PRI").map((c) => qi(c.name));
      if (pks.length) lines.push(`  PRIMARY KEY (${pks.join(", ")})`);
      stmts.push(`CREATE TABLE ${ref(tbl)} (\n${lines.join(",\n")}\n);`);
      continue;
    }
    for (const sc of scols) {
      const dc = dcols.find((c) => c.name === sc.name);
      if (!dc) {
        stmts.push(`ALTER TABLE ${ref(tbl)} ADD COLUMN ${colDef(sc)};`);
        continue;
      }
      const typeDiff = norm(sc.type) !== norm(dc.type);
      const nullDiff = sc.nn !== dc.nn;
      const defDiff = norm(sc.def) !== norm(dc.def);
      if (!typeDiff && !nullDiff && !defDiff) continue;
      if (conn.driver === "mysql") {
        stmts.push(`ALTER TABLE ${ref(tbl)} MODIFY COLUMN ${colDef(sc)};`);
      } else if (conn.driver === "postgres") {
        if (typeDiff) stmts.push(`ALTER TABLE ${ref(tbl)} ALTER COLUMN ${qi(sc.name)} TYPE ${sc.type};`);
        if (nullDiff) stmts.push(`ALTER TABLE ${ref(tbl)} ALTER COLUMN ${qi(sc.name)} ${sc.nn ? "SET NOT NULL" : "DROP NOT NULL"};`);
        if (defDiff) stmts.push(`ALTER TABLE ${ref(tbl)} ALTER COLUMN ${qi(sc.name)} ${sc.def ? `SET DEFAULT ${sc.def}` : "DROP DEFAULT"};`);
      } else {
        notes.push(t(`SQLite can't alter column ${tbl}.${sc.name} — skipped.`, `SQLite không sửa được cột ${tbl}.${sc.name} — bỏ qua.`));
      }
    }
    if (dropExtra) {
      for (const dc of dcols) if (!scols.some((c) => c.name === dc.name)) {
        stmts.push(`ALTER TABLE ${ref(tbl)} DROP COLUMN ${qi(dc.name)};`);
      }
    }
  }
  for (const tbl of Object.keys(dst)) if (!src[tbl]) notes.push(t(`Only in target: table ${tbl} (not auto-dropped).`, `Chỉ có ở đích: bảng ${tbl} (không xoá tự động).`));

  return { sql: stmts.join("\n"), notes };
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
          label={<span className="ellipsis">{c ? c.name : tr("— pick server —", "— chọn server —")}{c && c.env === "prod" ? " (PROD)" : ""}</span>}
          items={conns.map((x) => ({ id: x.id, label: `${x.name} · ${DRIVERS[x.driver].name.split(" ")[0]}`, hint: x.env, selected: x.id === connId }))}
          onPick={setConnId}
        />
      </div>
      <div className="picker-field" style={{ marginTop: 6 }}>
        <Picker
          label={<span className="ellipsis">{loading ? tr("loading databases…", "đang tải database…") : db || tr("— pick database —", "— chọn database —")}</span>}
          items={dbs.map((d) => ({ id: d, label: d, selected: d === db }))}
          onPick={setDb}
          filterPlaceholder={tr("Filter databases…", "Lọc database…")}
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
  // Cache kết nối mở tạm cho các server KHÁC session hiện tại — đóng khi tắt modal.
  const cache = useRef<Map<string, { dbId: string; tunnelId: string | null }>>(new Map());

  const connOf = (id: string) => conns.find((c) => c.id === id);

  /** Lấy dbId của một kết nối: dùng lại session nếu trùng, nếu không thì mở tạm (cần mật khẩu đã lưu). */
  const openFor = async (connId: string): Promise<string> => {
    if (connId === current.conn.id) return current.dbId;
    const cached = cache.current.get(connId);
    if (cached) return cached.dbId;
    const c = connOf(connId);
    if (!c) throw new Error(tr("Connection does not exist", "Kết nối không tồn tại"));
    const pw = sessionPasswords.get(connId) ?? (await call<string | null>("db_get_password", { id: connId }).catch(() => null)) ?? "";
    if (c.driver !== "sqlite" && !pw) throw new Error(tr(`Connection “${c.name}” has no saved password — open it once (tick Save password) then retry.`, `Kết nối “${c.name}” chưa có mật khẩu lưu — mở nó một lần (và tick Lưu mật khẩu) rồi thử lại.`));
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
  useEffect(() => { void loadDbs(dstConn, false); /* eslint-disable-next-line */ }, [dstConn]);

  const closeAll = () => {
    for (const { dbId, tunnelId } of cache.current.values()) {
      void call("db_disconnect", { id: dbId }).catch(() => {});
      if (tunnelId) void invoke("ssh_tunnel_close", { id: tunnelId }).catch(() => {});
    }
    cache.current.clear();
    onClose();
  };

  const runCompare = async () => {
    if (!srcDb || !dstDb) return;
    setBusy(true); setErr(""); setOk(""); setSql(""); setNotes([]);
    try {
      const sId = await openFor(srcConn);
      const dId = await openFor(dstConn);
      const [s, d] = await Promise.all([
        call<string[]>("db_struct", { id: sId, schema: srcDb }),
        call<string[]>("db_struct", { id: dId, schema: dstDb }),
      ]);
      const { sql, notes } = buildSyncSql(connOf(dstConn)!, dstDb, parseStruct(s), parseStruct(d), dropExtra);
      setSql(sql);
      setNotes(sql.trim() ? notes : [tr("Both sides are identical — nothing to sync.", "Hai bên giống nhau — không cần đồng bộ."), ...notes]);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const runScript = async () => {
    const dc = connOf(dstConn)!;
    const confirmed = await confirmDialog({
      title: dc.env === "prod" ? tr("⚠ Sync to PROD", "⚠ Đồng bộ lên PROD") : tr("Run sync script", "Chạy script đồng bộ"),
      message: tr(`Run the structure sync script on ${dc.name} / ${dstDb}?`, `Chạy script đồng bộ cấu trúc lên ${dc.name} / ${dstDb}?`),
      confirmLabel: tr("Run", "Chạy"),
      danger: dc.env === "prod",
    });
    if (!confirmed) return;
    setBusy(true); setErr(""); setOk("");
    try {
      const dId = await openFor(dstConn);
      const stmts = splitStatements(sql);
      for (const s of stmts) await call("db_query", { id: dId, sql: s, limit: 1 });
      setOk(tr(`✓ Ran ${stmts.length} statements on ${dc.name} / ${dstDb}`, `✓ Đã chạy ${stmts.length} câu lệnh lên ${dc.name} / ${dstDb}`));
      if (dstConn === current.conn.id) onReloadSession();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={tr("⇄ Struct sync — sync structure between databases", "⇄ Struct sync — đồng bộ cấu trúc giữa các database")} width={820} onClose={closeAll}>
      <div className="form account-form">
        <div className="form-row" style={{ alignItems: "stretch" }}>
          <SyncEnd cap={tr("Source (reference)", "Nguồn (chuẩn)")} conns={conns} connId={srcConn} setConnId={setSrcConn} dbs={srcDbs} loading={srcLoad} db={srcDb} setDb={setSrcDb} />
          <span style={{ alignSelf: "center", fontSize: 18 }}>→</span>
          <SyncEnd cap={tr("Target (will change)", "Đích (sẽ sửa)")} conns={conns} connId={dstConn} setConnId={setDstConn} dbs={dstDbs} loading={dstLoad} db={dstDb} setDb={setDstDb} />
        </div>
        <label className="check"><input type="checkbox" checked={dropExtra} onChange={(e) => setDropExtra(e.target.checked)} /> {tr("Drop extra columns on target (DROP COLUMN)", "Xoá cột thừa ở đích (DROP COLUMN)")}</label>
        <div className="toolbar">
          <button onClick={() => void runCompare()} disabled={busy || !srcDb || !dstDb}>{busy ? tr("Working…", "Đang xử lý…") : tr("Compare", "So sánh")}</button>
          <span className="grow" />
          <button className="primary" disabled={busy || !sql.trim()} onClick={() => void runScript()}>{tr("Sync", "Đồng bộ")}</button>
        </div>
        {err && <div className="error-box">⚠ {err}</div>}
        {ok && <div className="muted small" style={{ color: "var(--ok)" }}>{ok}</div>}
        {notes.length > 0 && <div className="muted small">{notes.map((n, i) => <div key={i}>• {n}</div>)}</div>}
        {sql && (
          <div className="field">
            <span className="field-cap">{tr("Sync SQL (editable before running)", "SQL đồng bộ (sửa được trước khi chạy)")}</span>
            <textarea className="mono" style={{ minHeight: 200 }} value={sql} onChange={(e) => setSql(e.target.value)} spellCheck={false} />
          </div>
        )}
        {!sql && !busy && !err && <div className="muted small">{tr("Pick server + database for source and target, then Compare.", "Chọn server + database cho nguồn và đích rồi bấm So sánh.")}</div>}
      </div>
    </Modal>
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
            <button className="primary" onClick={() => openForm()}>＋ {t("New connection", "Kết nối mới")}</button>
          </div>
        }
      />
      <ConnFormHost />
    </>
  ),
  commands: () => [
    { id: "db.new", group: "Database", title: t("New database connection", "Kết nối database mới"), run: () => openForm() },
    ...useConns.getState().conns.map((c) => ({
      id: `db.open.${c.id}`,
      group: "Database",
      title: `${t("Open connection:", "Mở kết nối:")} ${c.name}`,
      run: () => openSession(c),
    })),
  ],
};

export default dbApp;
