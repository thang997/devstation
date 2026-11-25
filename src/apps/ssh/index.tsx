import { Swap } from "../../shell/Swap";
import { copyText } from "../../shell/clipboard";
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  ChevronDown, ChevronRight, Container, Copy, CornerDownRight, FileUp, Folder, FolderOpen, FolderPlus, Hash, History, Image, KeyRound, List, Lock,
  Monitor, Pencil, Play, Plus, RefreshCw, Save, Search, Server, Settings, Square, SquareTerminal, Target, Trash2, TriangleAlert, Waypoints, X, Zap,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { AppModule, Tab } from "../types";
import { useWorkbench } from "../../store/workbench";
import { TabbedLayout } from "../../shell/TabbedLayout";
import { Modal } from "../../shell/Modal";
import { Picker, type PickerItem } from "../../shell/Picker";
import { Loading, Spinner } from "../../shell/Loading";
import { ContextMenu, type CtxItem } from "../../shell/ContextMenu";
import { confirmDialog } from "../../shell/confirm";
import { CmdHistoryModal } from "./CmdHistory";
import { addCommand } from "./cmdHistoryStore";
import { listNav, rowKey } from "../../shell/listNav";
import { t, useT } from "../../store/lang";
import { Splitter, useSplitSize } from "../../shell/Resizable";
import { SftpPanel } from "./SftpPanel";
import { SshStats } from "./SshStats";
import { ssh, dockerFs, errText, type ConnectCfg, type DockerContainer } from "./api";
import { jumpCfgFor, removeHost, saveHost, setHosts, uid, useHosts, type SavedHost } from "./hosts";
import { addFolder, removeFolder, renameFolder, toggleFolder, tunnelFolders, useFolders } from "./folders";
import {
  newTunnel, onTunnelEvent, removeTunnel, saveTunnel, setTunnels, startAutostartTunnels, startTunnel, stopTunnel, syncRunningTunnels,
  tunnelDesc, useTunnelRuntime, useTunnels, type SavedTunnel,
} from "./tunnels";

// xterm (~280 KB) chỉ cần khi mở tab terminal → tải lười; nạp sẵn lúc rảnh để lần kết nối đầu không phải chờ.
const loadTerminal = () => import("./Terminal");
const SshTerminal = lazy(() => loadTerminal().then((m) => ({ default: m.SshTerminal })));
if (typeof window !== "undefined") {
  const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 1500));
  idle(() => void loadTerminal().catch(() => {}));
}

// Mở app SSH (tải module trong cửa sổ này) → biết tunnel nào đang chạy rồi tự mở các tunnel đánh dấu ⚡.
// Tunnel đi theo cửa sổ SSH: đóng cửa sổ là Rust tắt hết (owners.rs), KHÔNG chạy nền.
void syncRunningTunnels().then(() => startAutostartTunnels());

const newHost = (folderId = ""): SavedHost => ({ id: uid("h"), name: "", host: "", port: 22, user: "", keyPath: "", prod: false, folderId });

/** Mở MỘT tab phiên mới cho host (cho phép nhiều tab cùng host — đánh số #2, #3… để phân biệt). */
function connect(h: SavedHost) {
  const wb = useWorkbench.getState();
  const n = wb.apps.ssh.tabs.filter((t) => t.payload?.hostId === h.id).length;
  wb.openTab({
    id: `ssh:term:${uid("x")}`,
    appId: "ssh",
    title: `${h.name || h.host}${n ? ` #${n + 1}` : ""}`,
    payload: { hostId: h.id, host: h.host, port: h.port, user: h.user, keyPath: h.keyPath, name: h.name, prod: h.prod },
    danger: h.prod,
  });
  wb.log(`ssh ${h.user}@${h.host}:${h.port}`);
}

/** Thông tin host tối thiểu để mở tab exec vào container. */
interface ExecBase { hostId: string; host: string; port: number; user: string; keyPath: string; name: string; prod: boolean; }

/** Lệnh mở shell tương tác trong container: ưu tiên bash, không có thì sh. */
// User không thuộc nhóm docker mà có sudo → chạy qua sudo (mật khẩu sudo gõ ngay trong terminal).
const DOCKER_SUDO_PRE = `if ! command docker ps -q >/dev/null 2>&1 && command -v sudo >/dev/null 2>&1; then docker() { sudo docker "$@"; }; fi; `;
const dockerExecCmd = (c: string) => `${DOCKER_SUDO_PRE}docker exec -it ${c} sh -lc 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'`;

/** Mở một tab terminal exec thẳng vào container Docker (ssh -tt → docker exec -it). */
function connectExec(base: ExecBase, container: string) {
  const wb = useWorkbench.getState();
  wb.openTab({
    id: `ssh:exec:${uid("x")}`,
    appId: "ssh",
    title: container,
    payload: { ...base, container, command: dockerExecCmd(container), tty: true, exec: true },
    danger: base.prod,
  });
  wb.log(`docker exec ${container} @ ${base.host}`);
}

/* Modal host có thể mở từ sidebar (khi hiện) hoặc từ dropdown (khi sidebar ẩn) → dùng store nhỏ. */
let hostFormReq: { host: SavedHost; seq: number } | null = null;
let hostFormSeq = 0;
const hostFormSubs = new Set<() => void>();
function openHostForm(host: SavedHost) {
  hostFormReq = { host, seq: ++hostFormSeq };
  hostFormSubs.forEach((f) => f());
}
function closeHostForm() {
  hostFormReq = null;
  hostFormSubs.forEach((f) => f());
}
const subHostForm = (cb: () => void) => { hostFormSubs.add(cb); return () => { hostFormSubs.delete(cb); }; };
const snapHostForm = () => hostFormReq;
function useHostFormReq() {
  return useSyncExternalStore(subHostForm, snapHostForm);
}

/* ── Sidebar: hosts + tunnels ── */

const INDENT = { paddingLeft: 24 };

/** Hành động của hàng host — truyền qua ref ổn định để `HostRow` (memo) không vẽ lại khi Sidebar đổi state
 *  (gõ tìm, chọn, kéo, trạng thái tunnel…). Chỉ hàng có prop thay đổi mới vẽ lại. */
interface HostRowApi {
  select: (id: string) => void;
  rename: (id: string | null) => void;
  menu: (e: React.MouseEvent, h: SavedHost) => void;
  dragStart: (id: string | null) => void;
  /** Id đang kéo (đọc từ ref — hàng không phụ thuộc state kéo). */
  dragging: () => string | null;
  drop: (targetId: string | null, folderId: string) => void;
}

const HostRow = memo(function HostRow({ h, inFolder, sel, dragging, renaming, jumpName, api }: {
  h: SavedHost; inFolder: boolean; sel: boolean; dragging: boolean; renaming: boolean;
  /** Tên jump host (nếu có) — tra sẵn ở Sidebar. */
  jumpName?: string;
  api: { current: HostRowApi };
}) {
  const tr = useT();
  const style = inFolder ? INDENT : undefined;
  if (renaming) return (
    <div className="side-item ssh-host" style={style} onClick={(e) => e.stopPropagation()}>
      <Server className="muted" />
      <input
        autoFocus
        className="tree-rename grow"
        defaultValue={h.name || h.host}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => { saveHost({ ...h, name: e.target.value.trim() || h.host }); api.current.rename(null); }}
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") api.current.rename(null); }}
      />
    </div>
  );
  return (
    <div
      className={`side-item ssh-host ${h.prod ? "prod" : ""} ${sel ? "sel" : ""} ${dragging ? "dragging" : ""}`}
      style={style}
      draggable
      tabIndex={0}
      onDragStart={(e) => { api.current.dragStart(h.id); e.dataTransfer.effectAllowed = "move"; }}
      onDragEnd={() => api.current.dragStart(null)}
      onDragOver={(e) => { const d = api.current.dragging(); if (d) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (d !== h.id) e.currentTarget.classList.add("drop-before"); } }}
      onDragLeave={(e) => e.currentTarget.classList.remove("drop-before")}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); e.currentTarget.classList.remove("drop-before"); api.current.drop(h.id, h.folderId ?? ""); }}
      onClick={() => api.current.select(h.id)}
      onDoubleClick={() => connect(h)}
      onKeyDown={(e) => rowKey(e, {
        Enter: () => connect(h),
        F2: () => api.current.rename(h.id),
        Delete: () => void confirmDialog({ message: tr("ssh.deleteHost2", { p: h.name || h.host }) }).then((ok) => ok && removeHost(h.id)),
      })}
      onContextMenu={(e) => api.current.menu(e, h)}
      title={`${tr("ssh.doubleClickToConnect")} ${h.user}@${h.host}${h.prod ? " (PROD)" : ""} · ${tr("ssh.f2ToRename")}`}
    >
      <Server className="muted" />
      <span className="grow ellipsis">{h.name || h.host}</span>
      {jumpName !== undefined && <span className="muted small" title={tr("ssh.viaJump", { name: jumpName })}><CornerDownRight /></span>}
      {h.prod && <span className="prod-tag">PROD</span>}
      <span className="muted small ellipsis">{h.user}@{h.host}</span>
      <span className="row-actions" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn" title={tr("ssh.edit")} onClick={() => openHostForm(h)}><Pencil /></button>
        <button className="icon-btn danger" title={tr("ssh.delete")} onClick={() => void confirmDialog({ message: tr("ssh.deleteHost2", { p: h.name || h.host }) }).then((ok) => ok && removeHost(h.id))}><Trash2 /></button>
      </span>
    </div>
  );
});

/** Hành động của hàng tunnel — ref ổn định cho `TunRow` (memo): event `ssh-tunnel` chỉ vẽ lại hàng đổi trạng thái. */
interface TunRowApi {
  select: (id: string) => void;
  rename: (id: string | null) => void;
  edit: (tn: SavedTunnel) => void;
  menu: (e: React.MouseEvent, tn: SavedTunnel) => void;
  dragStart: (id: string | null) => void;
  dragging: () => string | null;
  drop: (targetId: string | null, folderId: string) => void;
}

const TunRow = memo(function TunRow({ tn, inFolder, sel, dragging, renaming, st, msg, api }: {
  tn: SavedTunnel; inFolder: boolean; sel: boolean; dragging: boolean; renaming: boolean;
  st: string; msg: string;
  api: { current: TunRowApi };
}) {
  const tr = useT();
  const on = st === "running" || st === "starting";
  const style = inFolder ? INDENT : undefined;
  if (renaming) return (
    <div className="side-item ssh-tunnel" style={style}>
      <span className={`dot tun-${st}`} />
      <input
        autoFocus
        className="tree-rename grow"
        defaultValue={tn.name}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => { const name = e.target.value.trim(); if (name && name !== tn.name) saveTunnel({ ...tn, name }); api.current.rename(null); }}
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") api.current.rename(null); }}
      />
    </div>
  );
  return (
    <div
      tabIndex={0}
      onKeyDown={(e) => rowKey(e, {
        Enter: () => api.current.edit(tn),
        F2: () => api.current.rename(tn.id),
        Delete: () => void confirmDialog({ message: tr("ssh.deleteTunnel", { name: tn.name }) }).then((ok) => ok && removeTunnel(tn.id)),
      })}
      className={`side-item ssh-tunnel ${sel ? "sel" : ""} ${dragging ? "dragging" : ""}`}
      onClick={() => api.current.select(tn.id)}
      onDoubleClick={() => api.current.edit(tn)}
      style={style}
      title={`${msg || tunnelDesc(tn)} · ${tr("ssh.doubleClickToEditTunnel")} · ${tr("ssh.f2ToRename")}`}
      draggable
      onDragStart={(e) => { api.current.dragStart(tn.id); e.dataTransfer.effectAllowed = "move"; }}
      onDragEnd={() => api.current.dragStart(null)}
      onDragOver={(e) => { const d = api.current.dragging(); if (d) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (d !== tn.id) e.currentTarget.classList.add("drop-before"); } }}
      onDragLeave={(e) => e.currentTarget.classList.remove("drop-before")}
      onDrop={(e) => { if (!api.current.dragging()) return; e.preventDefault(); e.stopPropagation(); e.currentTarget.classList.remove("drop-before"); api.current.drop(tn.id, tn.folderId ?? ""); }}
      onContextMenu={(e) => api.current.menu(e, tn)}
    >
      <button
        className="icon-btn tun-toggle"
        onDoubleClick={(e) => e.stopPropagation()}
        title={on ? tr("ssh.stopTunnel") : tr("ssh.openTunnel")}
        onClick={() => (on ? void stopTunnel(tn.id) : void startTunnel(tn.id))}
      >
        {on ? <Square /> : <Play />}
      </button>
      <span className={`dot tun-${st}`} />
      <span className="grow ellipsis">{tn.name}</span>
      {st === "error" && <span className="tun-err-ic danger-text" title={msg || tr("ssh.sshExitedCheckKeyPort")}><TriangleAlert /></span>}
      {tn.autostart && <span className="tun-autostart" title={tr("ssh.autoStartOnAppLaunch")}><Zap /></span>}
      <span className="muted small ellipsis">{tunnelDesc(tn)}</span>
      <span className="row-actions" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        <button className="icon-btn" title={tr("ssh.edit")} onClick={() => api.current.edit(tn)}><Pencil /></button>
        <button className="icon-btn danger" title={tr("ssh.delete")} onClick={() => void confirmDialog({ message: tr("ssh.deleteTunnel", { name: tn.name }) }).then((ok) => ok && removeTunnel(tn.id))}><Trash2 /></button>
      </span>
    </div>
  );
});

function Sidebar() {
  const tr = useT();
  const hosts = useHosts();
  const folders = useFolders();
  const tunnels = useTunnels();
  const runtime = useTunnelRuntime();
  const [tunModal, setTunModal] = useState<SavedTunnel | null>(null);
  const [editingFolder, setEditingFolder] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: CtxItem[] } | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  // Ref song song với state kéo: hàng memo đọc ref qua api (state chỉ để tô lớp "dragging").
  const dragRef = useRef<string | null>(null);
  const startDrag = (id: string | null) => { dragRef.current = id; setDragId(id); };
  /** Kéo-thả sắp lại vị trí host: chèn `dragId` vào trước `targetId` (null = cuối), đổi folderId. */
  const dropHost = (targetId: string | null, folderId: string) => {
    const dragging = dragRef.current;
    if (!dragging) return;
    const list = [...hosts];
    const di = list.findIndex((h) => h.id === dragging);
    if (di < 0) return;
    const [moved] = list.splice(di, 1);
    moved.folderId = folderId;
    let ti = targetId ? list.findIndex((h) => h.id === targetId) : list.length;
    if (ti < 0) ti = list.length;
    list.splice(ti, 0, moved);
    setHosts(list);
    startDrag(null);
  };
  /* ── Tunnel: thư mục riêng (tunnelFolders), kéo-thả sắp vị trí / chuyển thư mục ── */
  const tFolders = tunnelFolders.use();
  const [tunDrag, setTunDrag] = useState<string | null>(null);
  const tunDragRef = useRef<string | null>(null);
  const startTunDrag = (id: string | null) => { tunDragRef.current = id; setTunDrag(id); };
  const [editingTunFolder, setEditingTunFolder] = useState<string | null>(null);
  const [renamingTun, setRenamingTun] = useState<string | null>(null);
  const isOn = (id: string) => { const st = runtime[id]?.status; return st === "running" || st === "starting"; };
  const dropTunnel = (targetId: string | null, folderId: string) => {
    const dragging = tunDragRef.current;
    if (!dragging) return;
    const list = [...tunnels];
    const di = list.findIndex((x) => x.id === dragging);
    if (di < 0) return;
    const [moved] = list.splice(di, 1);
    let ti = targetId ? list.findIndex((x) => x.id === targetId) : list.length;
    if (ti < 0) ti = list.length;
    list.splice(ti, 0, { ...moved, folderId });
    setTunnels(list);
    startTunDrag(null);
  };
  const deleteTunFolder = (f: { id: string; name: string }) =>
    void confirmDialog({ message: tr("ssh.deleteTunnelFolderConfirm", { name: f.name }) }).then((ok) => ok && tunnelFolders.remove(f.id));
  const tunFolderMenu = (f: { id: string; name: string }): CtxItem[] => {
    const inside = tunnels.filter((tn) => tn.folderId === f.id);
    return [
      { id: "add", icon: <Plus />, label: tr("ssh.addTunnelToFolder"), action: () => setTunModal(newTunnel(f.id)) },
      { id: "start", icon: <Play />, label: tr("ssh.startAllTunnels"), disabled: !inside.some((tn) => !isOn(tn.id)), action: () => inside.forEach((tn) => { if (!isOn(tn.id)) void startTunnel(tn.id); }) },
      { id: "stop", icon: <Square />, label: tr("ssh.stopAllTunnels"), disabled: !inside.some((tn) => isOn(tn.id)), action: () => inside.forEach((tn) => { if (isOn(tn.id)) void stopTunnel(tn.id); }) },
      { id: "s0", sep: true },
      { id: "rename", icon: <Pencil />, label: tr("ssh.renameFolder"), action: () => setEditingTunFolder(f.id) },
      { id: "s1", sep: true },
      { id: "del", icon: <Trash2 />, label: tr("ssh.deleteFolderTunnelsMoveOut"), danger: true, action: () => deleteTunFolder(f) },
    ];
  };
  const tunMenu = (tn: SavedTunnel): CtxItem[] => [
    isOn(tn.id)
      ? { id: "stop", icon: <Square />, label: tr("ssh.stopTunnel"), action: () => void stopTunnel(tn.id) }
      : { id: "start", icon: <Play />, label: tr("ssh.openTunnel"), action: () => void startTunnel(tn.id) },
    { id: "rename", icon: <Pencil />, label: tr("ssh.renameF2"), action: () => setRenamingTun(tn.id) },
    { id: "edit", icon: <Settings />, label: tr("ssh.edit"), action: () => setTunModal(tn) },
    { id: "dup", icon: <Copy />, label: tr("ssh.duplicateTunnel"), action: () => setTunModal({ ...tn, id: uid("t"), name: `${tn.name} (copy)`, autostart: false }) },
    { id: "s1", sep: true },
    { id: "del", icon: <Trash2 />, label: tr("ssh.delete"), danger: true, action: () => void confirmDialog({ message: tr("ssh.deleteTunnel", { name: tn.name }) }).then((ok) => ok && removeTunnel(tn.id)) },
  ];
  // Menu dựng lúc mở (chuột phải), không dựng sẵn cho từng hàng.
  const tunApi = useRef<TunRowApi>(null as unknown as TunRowApi);
  tunApi.current = {
    select: setSel,
    rename: setRenamingTun,
    edit: setTunModal,
    menu: (e, tn) => { setSel(tn.id); openMenu(e, tunMenu(tn)); },
    dragStart: startTunDrag,
    dragging: () => tunDragRef.current,
    drop: dropTunnel,
  };
  const tunRow = (tn: SavedTunnel, inFolder: boolean) => {
    const rt = runtime[tn.id];
    return (
      <TunRow
        key={tn.id}
        tn={tn}
        inFolder={inFolder}
        sel={sel === tn.id}
        dragging={tunDrag === tn.id}
        renaming={renamingTun === tn.id}
        st={rt?.status ?? "stopped"}
        msg={rt?.msg ?? ""}
        api={tunApi}
      />
    );
  };
  const tFolderIds = useMemo(() => new Set(tFolders.map((f) => f.id)), [tFolders]);
  // Gom tunnel theo thư mục một lần cho mỗi lần danh sách đổi (không lọc lại theo từng thư mục mỗi render).
  const tunByFolder = useMemo(() => {
    const m = new Map<string, SavedTunnel[]>();
    for (const tn of tunnels) {
      const k = tn.folderId && tFolderIds.has(tn.folderId) ? tn.folderId : "";
      const arr = m.get(k);
      if (arr) arr.push(tn); else m.set(k, [tn]);
    }
    return m;
  }, [tunnels, tFolderIds]);
  const rootTunnels = tunByFolder.get("") ?? [];
  const runningCount = tunnels.filter((tn) => isOn(tn.id)).length;
  /** Chuột phải chỗ trống của sidebar: thao tác theo tab đang mở. */
  const emptyMenu = (): CtxItem[] =>
    sideTab === "hosts"
      ? [
          { id: "newHost", icon: <Plus />, label: tr("ssh.addHost"), action: () => openHostForm(newHost()) },
          { id: "newFolder", icon: <FolderPlus />, label: tr("ssh.newFolder"), action: () => setEditingFolder(addFolder()) },
        ]
      : [
          { id: "newTunnel", icon: <Plus />, label: tr("ssh.addTunnel"), action: () => setTunModal(newTunnel()) },
          { id: "newFolder", icon: <FolderPlus />, label: tr("ssh.newFolder"), action: () => setEditingTunFolder(tunnelFolders.add()) },
          { id: "s1", sep: true },
          { id: "startAll", icon: <Play />, label: tr("ssh.startAllTunnelsAll"), disabled: !tunnels.some((tn) => !isOn(tn.id)), action: () => tunnels.forEach((tn) => { if (!isOn(tn.id)) void startTunnel(tn.id); }) },
          { id: "stopAll", icon: <Square />, label: tr("ssh.stopAllTunnelsAll"), disabled: !runningCount, action: () => tunnels.forEach((tn) => { if (isOn(tn.id)) void stopTunnel(tn.id); }) },
        ];
  // Mở app SSH luôn vào tab Hosts (không nhớ tab lần trước — trước đây hay mở nhầm vào Tunnels).
  const [sideTab, setSideTab] = useState<"hosts" | "tunnels">("hosts");
  const pickSideTab = setSideTab;

  const [q, setQ] = useState("");
  const ql = q.trim().toLowerCase();
  const searching = ql.length > 0;
  const matched = useMemo(
    () => (ql ? hosts.filter((h) => `${h.name} ${h.host} ${h.user}`.toLowerCase().includes(ql)) : hosts),
    [hosts, ql],
  );

  const openMenu = (e: React.MouseEvent, items: CtxItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };
  const folderMenu = (f: { id: string; name: string }): CtxItem[] => [
    { id: "add", icon: <Plus />, label: tr("ssh.addHostToFolder"), action: () => openHostForm(newHost(f.id)) },
    { id: "rename", icon: <Pencil />, label: tr("ssh.renameFolder"), action: () => setEditingFolder(f.id) },
    { id: "s1", sep: true },
    { id: "del", icon: <Trash2 />, label: tr("ssh.deleteFolderHostsMoveOut"), danger: true, action: () => void confirmDialog({ message: tr("ssh.deleteFolderHostsInsideMoveOut", { name: f.name }) }).then((ok) => ok && removeFolder(f.id)) },
  ];
  const hostMenu = (h: SavedHost): CtxItem[] => [
    { id: "conn", icon: <Monitor />, label: tr("ssh.connect"), action: () => connect(h) },
    { id: "rename", icon: <Pencil />, label: tr("ssh.renameF2"), action: () => setRenaming(h.id) },
    { id: "edit", icon: <Settings />, label: tr("ssh.editHost"), action: () => openHostForm(h) },
    { id: "dup", icon: <Copy />, label: tr("ssh.duplicateHost"), action: () => openHostForm({ ...h, id: uid("h"), name: `${h.name || h.host} (copy)` }) },
    { id: "s1", sep: true },
    { id: "forget", icon: <KeyRound />, label: tr("ssh.forgetSavedPassword"), action: () => void ssh.forgetPassword(h.user, h.host, h.port) },
    { id: "del", icon: <Trash2 />, label: tr("ssh.deleteHost"), danger: true, action: () => void confirmDialog({ message: tr("ssh.deleteHost2", { p: h.name || h.host }) }).then((ok) => ok && removeHost(h.id)) },
  ];

  const hostApi = useRef<HostRowApi>(null as unknown as HostRowApi);
  hostApi.current = {
    select: setSel,
    rename: setRenaming,
    menu: (e, h) => { setSel(h.id); openMenu(e, hostMenu(h)); },
    dragStart: startDrag,
    dragging: () => dragRef.current,
    drop: dropHost,
  };
  // Tra jump host bằng Map (thay vì find trong từng hàng → O(n²) với nhiều host).
  const hostById = useMemo(() => new Map(hosts.map((h) => [h.id, h])), [hosts]);
  const hostRow = (h: SavedHost, inFolder: boolean) => {
    const j = h.jumpHostId ? hostById.get(h.jumpHostId) : undefined;
    return (
      <HostRow
        key={h.id}
        h={h}
        inFolder={inFolder}
        sel={sel === h.id}
        dragging={dragId === h.id}
        renaming={renaming === h.id}
        jumpName={j ? j.name || j.host : undefined}
        api={hostApi}
      />
    );
  };

  const folderIds = useMemo(() => new Set(folders.map((f) => f.id)), [folders]);
  const hostsByFolder = useMemo(() => {
    const m = new Map<string, SavedHost[]>();
    for (const h of hosts) {
      const k = h.folderId && folderIds.has(h.folderId) ? h.folderId : "";
      const arr = m.get(k);
      if (arr) arr.push(h); else m.set(k, [h]);
    }
    return m;
  }, [hosts, folderIds]);
  const rootHosts = hostsByFolder.get("") ?? [];

  return (
    <div
      className="side-list fill"
      onKeyDown={(e) => {
        // ↑/↓/Home/End giữa hàng host/tunnel/thư mục. Chỉ "chọn" (click) hàng host/tunnel —
        // click thư mục là gập/mở nên không tự click khi đi qua.
        if (listNav(e, { row: ".side-item.ssh-host[tabindex], .side-item.ssh-tunnel[tabindex], .tree-row" })) {
          const a = document.activeElement as HTMLElement | null;
          if (a?.matches(".side-item")) a.click();
        }
      }}
      onContextMenu={(e) => openMenu(e, emptyMenu())}
      onDragOver={(e) => { if (dragId || tunDrag) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; } }}
      onDrop={(e) => { if (dragId) { e.preventDefault(); dropHost(null, ""); } else if (tunDrag) { e.preventDefault(); dropTunnel(null, ""); } }}
    >
      {/* Hai tab riêng: HOSTS | TUNNELS (nhớ tab đang chọn). */}
      <div className="subtabs ssh-side-tabs">
        <button className={sideTab === "hosts" ? "on" : ""} onClick={() => pickSideTab("hosts")}>
          <Monitor />Hosts{hosts.length > 0 && <span className="badge">{hosts.length}</span>}
        </button>
        <button className={sideTab === "tunnels" ? "on" : ""} onClick={() => pickSideTab("tunnels")} title={tr("ssh.tunnelsRunningCount", { running: runningCount, total: tunnels.length })}>
          <Waypoints />Tunnels{tunnels.length > 0 && <span className={`badge ${runningCount ? "tun-badge-on" : ""}`}>{runningCount ? `${runningCount}/${tunnels.length}` : tunnels.length}</span>}
        </button>
      </div>
      {sideTab === "hosts" && (<>
      <div className="side-head">
        <span>HOSTS</span>
        <span className="side-actions">
          <button className="icon-btn" title={tr("ssh.addHost")} onClick={() => openHostForm(newHost())}><Plus /></button>
          <button className="icon-btn" title={tr("ssh.newFolder")} onClick={() => setEditingFolder(addFolder())}><FolderPlus /></button>
        </span>
      </div>
      {hosts.length > 0 && (
        <div className="side-search-row">
          <span className="side-search-ic"><Search /></span>
          <input className="side-search" placeholder={tr("ssh.searchHostNameIpUser")} value={q} onChange={(e) => setQ(e.target.value)} />
          {q && <button className="icon-btn" title={tr("ssh.clearSearch")} onClick={() => setQ("")}><X /></button>}
        </div>
      )}
      {hosts.length === 0 && folders.length === 0 && <div className="muted small pad">{tr("ssh.noHostsClickToAdd")}</div>}

      {/* Đang tìm: hiện phẳng mọi host khớp (bỏ qua nhóm/thu gọn). Không tìm: giữ cây thư mục. */}
      {searching ? (
        matched.length ? (
          matched.map((h) => hostRow(h, false))
        ) : (
          <div className="muted small pad">{t("ssh.noHostMatches", { q })}</div>
        )
      ) : (
        <>
          {folders.map((f) => (
            <div key={f.id}>
              <div
            className="tree-row"
            tabIndex={0}
            onClick={() => toggleFolder(f.id)}
            onKeyDown={(e) => rowKey(e, {
              Enter: () => toggleFolder(f.id),
              " ": () => toggleFolder(f.id),
              ArrowLeft: () => { if (f.open) toggleFolder(f.id); },
              ArrowRight: () => { if (!f.open) toggleFolder(f.id); },
              F2: () => setEditingFolder(f.id),
            })}
            onDragOver={(e) => { if (dragId) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; e.currentTarget.classList.add("drop-into"); } }}
            onDragLeave={(e) => e.currentTarget.classList.remove("drop-into")}
            onDrop={(e) => { e.preventDefault(); e.stopPropagation(); e.currentTarget.classList.remove("drop-into"); dropHost(null, f.id); }}
            onContextMenu={(e) => openMenu(e, folderMenu(f))}
          >
                <span className="tree-caret">{f.open ? <ChevronDown /> : <ChevronRight />}</span>
                <span className="tree-icon">{f.open ? <FolderOpen /> : <Folder />}</span>
                {editingFolder === f.id ? (
                  <input
                    autoFocus
                    className="tree-rename"
                    defaultValue={f.name}
                    onFocus={(e) => e.currentTarget.select()}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => { renameFolder(f.id, e.target.value.trim() || f.name); setEditingFolder(null); }}
                    onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") setEditingFolder(null); }}
                  />
                ) : (
                  <span className="grow ellipsis">{f.name}</span>
                )}
                <span className="row-actions" onClick={(e) => e.stopPropagation()}>
                  <button className="icon-btn" title={tr("ssh.addHostToFolder2")} onClick={() => openHostForm(newHost(f.id))}><Plus /></button>
                  <button className="icon-btn" title={tr("ssh.rename")} onClick={() => setEditingFolder(f.id)}><Pencil /></button>
                  <button className="icon-btn danger" title={tr("ssh.deleteFolderHostsMoveOut")} onClick={() => void confirmDialog({ message: tr("ssh.deleteFolderHostsInsideMoveOut", { name: f.name }) }).then((ok) => ok && removeFolder(f.id))}><Trash2 /></button>
                </span>
              </div>
              {f.open && (hostsByFolder.get(f.id) ?? []).map((h) => hostRow(h, true))}
            </div>
          ))}
          {rootHosts.map((h) => hostRow(h, false))}
        </>
      )}
      </>)}

      {sideTab === "tunnels" && (<>
      <div className="side-head">
        <span>TUNNELS</span>
        <span className="side-actions">
          <button className="icon-btn" title={tr("ssh.addTunnel")} onClick={() => setTunModal(newTunnel())}><Plus /></button>
          <button className="icon-btn" title={tr("ssh.newFolder")} onClick={() => setEditingTunFolder(tunnelFolders.add())}><FolderPlus /></button>
        </span>
      </div>
      {tunnels.length === 0 && tFolders.length === 0 && <div className="muted small pad">{tr("ssh.noTunnelsPortForward")}</div>}
      {tFolders.map((f) => {
        const inside = tunByFolder.get(f.id) ?? [];
        const running = inside.filter((tn) => isOn(tn.id)).length;
        return (
          <div key={f.id}>
            <div
              className="tree-row"
              tabIndex={0}
              onClick={() => tunnelFolders.toggle(f.id)}
              onKeyDown={(e) => rowKey(e, {
                Enter: () => tunnelFolders.toggle(f.id),
                " ": () => tunnelFolders.toggle(f.id),
                ArrowLeft: () => { if (f.open) tunnelFolders.toggle(f.id); },
                ArrowRight: () => { if (!f.open) tunnelFolders.toggle(f.id); },
                F2: () => setEditingTunFolder(f.id),
              })}
              onDragOver={(e) => { if (tunDrag) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; e.currentTarget.classList.add("drop-into"); } }}
              onDragLeave={(e) => e.currentTarget.classList.remove("drop-into")}
              onDrop={(e) => { if (!tunDrag) return; e.preventDefault(); e.stopPropagation(); e.currentTarget.classList.remove("drop-into"); dropTunnel(null, f.id); }}
              onContextMenu={(e) => openMenu(e, tunFolderMenu(f))}
            >
              <span className="tree-caret">{f.open ? <ChevronDown /> : <ChevronRight />}</span>
              <span className="tree-icon">{f.open ? <FolderOpen /> : <Folder />}</span>
              {editingTunFolder === f.id ? (
                <input
                  autoFocus
                  className="tree-rename"
                  defaultValue={f.name}
                  onFocus={(e) => e.currentTarget.select()}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={(e) => { tunnelFolders.rename(f.id, e.target.value.trim() || f.name); setEditingTunFolder(null); }}
                  onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") setEditingTunFolder(null); }}
                />
              ) : (
                <span className="grow ellipsis">{f.name}</span>
              )}
              {inside.length > 0 && <span className={`muted small ${running ? "tun-count-on" : ""}`} title={tr("ssh.tunnelsRunningCount", { running, total: inside.length })}>{running}/{inside.length}</span>}
              <span className="row-actions" onClick={(e) => e.stopPropagation()}>
                <button className="icon-btn" title={tr("ssh.addTunnelToFolder")} onClick={() => setTunModal(newTunnel(f.id))}><Plus /></button>
                <button className="icon-btn" title={tr("ssh.rename")} onClick={() => setEditingTunFolder(f.id)}><Pencil /></button>
                <button className="icon-btn danger" title={tr("ssh.deleteFolderTunnelsMoveOut")} onClick={() => deleteTunFolder(f)}><Trash2 /></button>
              </span>
            </div>
            {f.open && inside.map((tn) => tunRow(tn, true))}
          </div>
        );
      })}
      {rootTunnels.map((tn) => tunRow(tn, false))}
      </>)}

      {tunModal && <TunnelModal tunnel={tunModal} onClose={() => setTunModal(null)} />}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

/* ── Chọn file key ── */

async function pickKey(set: (p: string) => void) {
  const f = await openDialog({ multiple: false, title: t("ssh.choosePrivateKey") });
  if (typeof f === "string") set(f);
}

/* ── Ô cổng: giữ chuỗi người dùng gõ, kiểm 1–65535 (không âm thầm lùi về 22/0) ── */

/** Parse chuỗi cổng; trống + `emptyDefault` → dùng mặc định; sai → null. */
function parsePort(text: string, emptyDefault?: number): number | null {
  const s = text.trim();
  if (!s) return emptyDefault ?? null;
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= 65535 ? n : null;
}

function PortInput({ label, text, setText, bad, width, placeholder }: {
  label: React.ReactNode; text: string; setText: (v: string) => void; bad: boolean; width: number; placeholder?: string;
}) {
  const tr = useT();
  return (
    <label style={{ width }}>{label}
      <input className={`mono ${bad ? "invalid" : ""}`} type="number" min={1} max={65535} value={text} placeholder={placeholder}
        aria-invalid={bad} onChange={(e) => setText(e.target.value)} />
      {bad && <span className="field-error danger-text small">{tr("ssh.portInvalid")}</span>}
    </label>
  );
}

/* ── Modal thêm/sửa host ── */

function HostModal({ host, onClose }: { host: SavedHost; onClose: () => void }) {
  const tr = useT();
  const [h, setH] = useState<SavedHost>(host);
  const folders = useFolders();
  const allHosts = useHosts();
  const jumpChoices = allHosts.filter((x) => x.id !== h.id);
  const jumpHost = allHosts.find((x) => x.id === h.jumpHostId && x.id !== h.id);
  const [hasPw, setHasPw] = useState(false);
  const set = (p: Partial<SavedHost>) => setH((x) => ({ ...x, ...p }));
  // Host mới: để trống ô Port → 22; host đã có: trống = lỗi.
  const [isNew] = useState(() => !allHosts.some((x) => x.id === host.id));
  const [portText, setPortText] = useState(isNew && host.port === 22 ? "" : String(host.port || ""));
  const port = parsePort(portText, isNew ? 22 : undefined);
  const setPort = (v: string) => { setPortText(v); const n = parsePort(v, isNew ? 22 : undefined); if (n != null) set({ port: n }); };
  // Host này đã lưu mật khẩu trong Windows Credential Manager chưa (để hiện trạng thái / nút quên).
  useEffect(() => {
    let alive = true;
    if (h.host.trim() && h.user.trim())
      ssh.hasPassword(h.user.trim(), h.host.trim(), h.port).then((v) => alive && setHasPw(v)).catch(() => {});
    else setHasPw(false);
    return () => { alive = false; };
  }, [h.host, h.user, h.port]);
  const forget = () => void ssh.forgetPassword(h.user.trim(), h.host.trim(), h.port).then(() => setHasPw(false));
  const save = () => {
    if (!h.host.trim() || !h.user.trim() || port == null) return;
    saveHost({ ...h, port, name: h.name.trim() || h.host.trim() });
    onClose();
  };
  return (
    <Modal title={<><Monitor /> {tr("ssh.sshHost")}</>} width={560} onClose={onClose}>
      <div className="form account-form">
        <label>{tr("ssh.displayName")}<input autoFocus value={h.name} placeholder="vd. prod-web" onChange={(e) => set({ name: e.target.value })} /></label>
        <div className="form-row">
          <label className="grow">Host / IP<input className="mono" value={h.host} placeholder="10.0.0.5" onChange={(e) => set({ host: e.target.value })} /></label>
          <PortInput label="Port" width={90} text={portText} setText={setPort} bad={port == null} placeholder={isNew ? "22" : undefined} />
        </div>
        <label>User<input value={h.user} placeholder="ubuntu" onChange={(e) => set({ user: e.target.value })} /></label>
        <label>{tr("ssh.privateKeyOptional")}
          <div className="form-row">
            <input className="grow mono" value={h.keyPath} placeholder={tr("ssh.emptyDefaultKeySshAgent")} onChange={(e) => set({ keyPath: e.target.value })} />
            <button onClick={() => void pickKey((p) => set({ keyPath: p }))}><FileUp />{tr("ssh.browse")}</button>
          </div>
        </label>
        <div className="field">
          <span className="field-cap">{tr("ssh.jumpHost")}</span>
          <div className="picker-field">
            <Picker
              label={<span className="ellipsis">{jumpHost ? <><CornerDownRight /> {`${jumpHost.name || jumpHost.host} (${jumpHost.user}@${jumpHost.host}:${jumpHost.port})`}</> : tr("ssh.jumpNone")}</span>}
              items={[
                { id: "", label: tr("ssh.jumpNone"), selected: !jumpHost },
                // Host không thư mục ở trên cùng (không gập), rồi từng thư mục theo thứ tự sidebar — mặc định gập hết.
                ...[...jumpChoices.filter((x) => !folders.some((f) => f.id === x.folderId)),
                  ...folders.flatMap((f) => jumpChoices.filter((x) => x.folderId === f.id))]
                  .map((x) => ({
                    id: x.id,
                    label: x.name || x.host,
                    hint: `${x.user}@${x.host}:${x.port}`,
                    selected: x.id === h.jumpHostId,
                    group: folders.find((f) => f.id === x.folderId)?.name,
                  })),
              ]}
              collapsibleGroups
              onPick={(id) => set({ jumpHostId: id || undefined })}
              filterPlaceholder={tr("ssh.searchHostNameIpUser")}
            />
          </div>
          <span className="muted small">{tr("ssh.jumpHint")}</span>
        </div>
        <div className="field">
          <span className="field-cap">{tr("ssh.folder")}</span>
          <div className="picker-field">
            <Picker
              label={<span className="ellipsis">{folders.find((f) => f.id === h.folderId)?.name ?? tr("ssh.noFolder")}</span>}
              items={[{ id: "", label: tr("ssh.noFolder"), selected: !h.folderId }, ...folders.map((f) => ({ id: f.id, label: f.name, selected: h.folderId === f.id }))]}
              onPick={(id) => set({ folderId: id })}
            />
          </div>
        </div>
        <label className="check"><input type="checkbox" checked={h.prod} onChange={(e) => set({ prod: e.target.checked })} /> {tr("ssh.markProdRedBorderBeCareful")}</label>
        {hasPw ? (
          <div className="form-row" style={{ alignItems: "center" }}>
            <span className="muted small grow"><KeyRound /> {tr("ssh.passwordSavedForThisHostAuto")}</span>
            <button onClick={forget}><KeyRound />{tr("ssh.forgetPassword")}</button>
          </div>
        ) : (
          <div className="muted small">
            <Lock /> {tr("ssh.noSavedPasswordTypeItCorrectly")}
          </div>
        )}
        <div className="toolbar">
          <span className="grow" />
          <button onClick={onClose}><X />{tr("ssh.cancel")}</button>
          <button className="primary" disabled={!h.host.trim() || !h.user.trim() || port == null} onClick={save}><Save />{tr("ssh.save")}</button>
        </div>
      </div>
    </Modal>
  );
}

/* ── Modal thêm/sửa tunnel ── */

function TunnelModal({ tunnel, onClose }: { tunnel: SavedTunnel; onClose: () => void }) {
  const tr = useT();
  const [t, setT] = useState<SavedTunnel>(tunnel);
  const tFolders = tunnelFolders.use();
  const set = (p: Partial<SavedTunnel>) => setT((x) => ({ ...x, ...p }));
  // Tunnel mới: ô Port SSH trống → 22. Cổng local/đích luôn bắt buộc 1–65535.
  const allTunnels = useTunnels();
  const [isNew] = useState(() => !allTunnels.some((x) => x.id === tunnel.id));
  const [portText, setPortText] = useState(isNew && tunnel.port === 22 ? "" : String(tunnel.port || ""));
  const [localText, setLocalText] = useState(tunnel.localPort ? String(tunnel.localPort) : "");
  const [remoteText, setRemoteText] = useState(tunnel.remotePort ? String(tunnel.remotePort) : "");
  const port = parsePort(portText, isNew ? 22 : undefined);
  const localPort = parsePort(localText);
  const remotePort = parsePort(remoteText);
  const portsOk = port != null && localPort != null && (t.kind === "D" || remotePort != null);
  const setPort = (v: string) => { setPortText(v); const n = parsePort(v, isNew ? 22 : undefined); if (n != null) set({ port: n }); };
  const setLocal = (v: string) => { setLocalText(v); const n = parsePort(v); if (n != null) set({ localPort: n }); };
  const setRemote = (v: string) => { setRemoteText(v); const n = parsePort(v); if (n != null) set({ remotePort: n }); };
  const KIND_LABEL: Record<SavedTunnel["kind"], string> = {
    L: tr("ssh.localLLocalPortTargetVia"),
    R: tr("ssh.remoteRServerPortTargetVia"),
    D: "Dynamic (-D): SOCKS proxy",
  };
  const save = () => {
    if (!t.host.trim() || !t.user.trim() || !portsOk) return;
    const next: SavedTunnel = { ...t, port: port!, localPort: localPort!, ...(t.kind !== "D" ? { remotePort: remotePort! } : {}) };
    saveTunnel({ ...next, name: t.name.trim() || tunnelDesc(next) });
    onClose();
  };
  return (
    <Modal title={<><Waypoints /> {tr("ssh.tunnelPortForward")}</>} width={620} onClose={onClose}>
      <div className="form account-form">
        <label>{tr("ssh.name")}<input autoFocus value={t.name} onChange={(e) => set({ name: e.target.value })} /></label>
        {tFolders.length > 0 && (
          <div className="field">
            <span className="field-cap">{tr("ssh.folder")}</span>
            <div className="picker-field">
              <Picker
                label={<span className="ellipsis">{tFolders.find((f) => f.id === t.folderId)?.name ?? tr("ssh.noFolder")}</span>}
                items={[{ id: "", label: tr("ssh.noFolder"), selected: !t.folderId }, ...tFolders.map((f) => ({ id: f.id, label: f.name, selected: t.folderId === f.id }))]}
                onPick={(id) => set({ folderId: id })}
              />
            </div>
          </div>
        )}
        <div className="field">
          <span className="field-cap">{tr("ssh.kind")}</span>
          <div className="picker-field">
            <Picker
              label={<span className="ellipsis">{KIND_LABEL[t.kind]}</span>}
              items={(["L", "R", "D"] as const).map((k) => ({ id: k, label: KIND_LABEL[k], selected: t.kind === k }))}
              onPick={(id) => set({ kind: id as SavedTunnel["kind"] })}
            />
          </div>
        </div>
        <div className="form-row">
          <label className="grow">Server host<input className="mono" value={t.host} placeholder="10.0.0.5" onChange={(e) => set({ host: e.target.value })} /></label>
          <PortInput label="Port" width={90} text={portText} setText={setPort} bad={port == null} placeholder={isNew ? "22" : undefined} />
          <label className="grow">User<input value={t.user} onChange={(e) => set({ user: e.target.value })} /></label>
        </div>
        <label>{tr("ssh.privateKeyOptionalTunnelsShouldUse")}
          <div className="form-row">
            <input className="grow mono" value={t.keyPath} placeholder={tr("ssh.emptyDefaultKeySshAgent")} onChange={(e) => set({ keyPath: e.target.value })} />
            <button onClick={() => void pickKey((p) => set({ keyPath: p }))}><FileUp />{tr("ssh.browse")}</button>
          </div>
        </label>
        <div className="form-row">
          <PortInput label={t.kind === "D" ? tr("ssh.socksPort") : tr("ssh.localPort")} width={150} text={localText} setText={setLocal} bad={localPort == null} />
          {t.kind !== "D" && (
            <>
              <label className="grow">{tr("ssh.targetHost")}<input className="mono" value={t.remoteHost} placeholder="localhost" onChange={(e) => set({ remoteHost: e.target.value })} /></label>
              <PortInput label={tr("ssh.targetPort")} width={120} text={remoteText} setText={setRemote} bad={remotePort == null} />
            </>
          )}
        </div>
        <label className="check"><input type="checkbox" checked={!!t.autostart} onChange={(e) => set({ autostart: e.target.checked })} /> {tr("ssh.autoStartThisTunnelOnApp")}</label>

        {/* Sơ đồ đường đi: hiện rõ cổng LOCAL và luồng dữ liệu theo từng kiểu. */}
        <div className="tun-flow">
          {t.kind === "L" && (<>
            <span className="tun-node you"><Monitor /> 127.0.0.1:{t.localPort}</span>
            <span className="tun-arrow">→</span>
            <span className="tun-node srv">{t.host || "server"}:{t.port}</span>
            <span className="tun-arrow">→</span>
            <span className="tun-node tgt"><Target /> {t.remoteHost || "localhost"}:{t.remotePort}</span>
          </>)}
          {t.kind === "R" && (<>
            <span className="tun-node srv">{t.host || "server"}:{t.localPort}</span>
            <span className="tun-arrow">→</span>
            <span className="tun-node you"><Monitor /> {tr("ssh.yourMachine")}</span>
            <span className="tun-arrow">→</span>
            <span className="tun-node tgt"><Target /> {t.remoteHost || "localhost"}:{t.remotePort}</span>
          </>)}
          {t.kind === "D" && (<>
            <span className="tun-node you"><Monitor /> SOCKS 127.0.0.1:{t.localPort}</span>
            <span className="tun-arrow">→</span>
            <span className="tun-node srv">{t.host || "server"}:{t.port}</span>
            <span className="tun-arrow">→</span>
            <span className="tun-node tgt">{tr("ssh.anyDestination")}</span>
          </>)}
        </div>
        <div className="muted small">
          {t.kind === "L" && tr("ssh.connectTo127001", { localPort: t.localPort, p: t.remoteHost || "localhost", remotePort: t.remotePort })}
          {t.kind === "R" && tr("ssh.onTheServer12700", { localPort: t.localPort, p: t.remoteHost || "localhost", remotePort: t.remotePort })}
          {t.kind === "D" && tr("ssh.setSocks5Proxy12700", { localPort: t.localPort })}
        </div>
        <div className="muted small">{tr("ssh.tunnelRunsWith")} <span className="mono">ssh -N {t.kind === "D" ? "-D" : t.kind === "L" ? "-L" : "-R"}</span> {tr("ssh.inBatchmodeNeedsKeyAgentNo")}</div>
        <div className="toolbar">
          <span className="grow" />
          <button onClick={onClose}><X />{tr("ssh.cancel")}</button>
          <button className="primary" disabled={!t.host.trim() || !t.user.trim() || !portsOk} onClick={save}><Save />{tr("ssh.save")}</button>
        </div>
      </div>
    </Modal>
  );
}

/* ── Modal Docker: liệt kê container + exec vào ── */

function DockerModal({ cfg, base, onClose }: { cfg: ConnectCfg; base: ExecBase; onClose: () => void }) {
  const tr = useT();
  const [list, setList] = useState<DockerContainer[] | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; items: CtxItem[] } | null>(null);
  const load = () => {
    setLoading(true);
    setErr("");
    ssh
      .dockerPs(cfg)
      .then((v) => { setList(v); setLoading(false); })
      .catch((e) => { setErr(errText(e)); setLoading(false); });
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, []);
  const exec = (c: DockerContainer) => { connectExec(base, c.name || c.id); onClose(); };
  const rowMenu = (c: DockerContainer): CtxItem[] => [
    { id: "exec", icon: <Play />, label: tr("ssh.execShellIntoContainer"), action: () => exec(c) },
    { id: "s1", sep: true },
    { id: "copy", icon: <Copy />, label: tr("ssh.copyName"), action: () => void copyText(c.name || c.id) },
    { id: "copyid", icon: <Hash />, label: tr("ssh.copyId"), action: () => void copyText(c.id) },
    { id: "copyimg", icon: <Image />, label: tr("ssh.copyImage"), action: () => void copyText(c.image) },
  ];
  return (
    <Modal title={<><Container /> {tr("ssh.dockerContainers")}</>} width={760} onClose={onClose}>
      {/* minHeight cố định để khi Refresh (list → spinner) modal không bị co lại. */}
      <div className="form docker-modal-body">
        <div className="toolbar">
          <span className="mono muted small grow ellipsis">{base.name || cfg.host} · {cfg.user}@{cfg.host}:{cfg.port}</span>
          {base.prod ? <span className="prod-tag">PROD</span> : null}
          <button onClick={load} disabled={loading}><Swap on={loading} a={<><Spinner /> {tr("ssh.loading")}</>} b={<><RefreshCw /> {tr("ssh.refresh")}</>} /></button>
        </div>
        {loading && (
          <Loading label={<>{tr("ssh.reading")} <span className="mono">docker ps</span>…</>} />
        )}
        {!loading && err && <div className="error-box pre">{err}</div>}
        {!loading && !err && list && list.length === 0 && (
          <div className="muted pad">{tr("ssh.noRunningContainersDockerPsEmpty")}</div>
        )}
        {!loading && !err && list && list.length > 0 && (() => {
          const ql = q.trim().toLowerCase();
          const shown = ql
            ? list.filter((c) => `${c.name} ${c.image} ${c.ports} ${c.id}`.toLowerCase().includes(ql))
            : list;
          return (
          <>
          <div className="side-search-row">
            <span className="side-search-ic"><Search /></span>
            <input
              autoFocus
              className="side-search"
              placeholder={tr("ssh.filterByNameImagePort")}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            {q && <button className="icon-btn" title={tr("ssh.clear")} onClick={() => setQ("")}><X /></button>}
            <span className="muted small" style={{ whiteSpace: "nowrap" }}>{shown.length}/{list.length}</span>
          </div>
          {shown.length === 0 ? (
            <div className="muted pad">{tr("ssh.noContainerMatches")} “{q}”.</div>
          ) : (
          <div className="docker-list">
            {shown.map((c) => (
              <div
                key={c.id}
                className="docker-row"
                onDoubleClick={() => exec(c)}
                onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, items: rowMenu(c) }); }}
                title={tr("ssh.doubleClickToExecIntoThis")}
              >
                <span className="docker-ic"><Container /></span>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="ellipsis"><b>{c.name || c.id.slice(0, 12)}</b> <span className="muted small">{c.image}</span></div>
                  <div className="muted small ellipsis">{c.status}{c.ports ? ` · ${c.ports}` : ""}</div>
                </div>
                <button className="primary" onClick={() => exec(c)} title={tr("ssh.openAShellInsideThisContainer")}><SquareTerminal />Exec</button>
              </div>
            ))}
          </div>
          )}
          </>
          );
        })()}
        <div className="muted small">
          {tr("ssh.execOpensATerminalTabRunning")} <span className="mono">ssh -tt → docker exec -it &lt;name&gt; bash/sh</span>.
        </div>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </Modal>
  );
}

/* ── Tab terminal ── */

const FILES_DEFAULT = 360;
const FILES_MIN = 260;
const FILES_MAX = 720;

function TabView({ tab }: { tab: Tab }) {
  const tr = useT();
  const p = tab.payload;
  const hosts = useHosts();
  const folders = useFolders();
  // Mã trạng thái từ terminal: connecting | connected | closed | error.
  const [status, setStatus] = useState("connecting");
  const statusText =
    status === "connected" ? tr("ssh.connected")
    : status === "connecting" ? tr("ssh.connecting")
    : status === "closed" ? tr("ssh.closed")
    : status === "error" ? tr("ssh.error")
    : status === "timeout" ? tr("ssh.timedOut")
    : status;
  const statusDot = status === "connected" ? "green" : status === "error" || status === "timeout" ? "red" : status === "connecting" ? "yellow" : "grey";
  // Lịch sử lệnh: khoá theo host (tab exec thêm #container); nút ⏱ ở toolbar mở modal.
  const [histOpen, setHistOpen] = useState(false);
  const histKey = `${String(p.user)}@${String(p.host)}:${String(p.port || 22)}${p.exec ? `#${String(p.container ?? "")}` : ""}`;
  const onCommand = useCallback((cmd: string) => addCommand(histKey, cmd), [histKey]);
  // Quá CONNECT_TIMEOUT_S giây không kết nối được: chuyển tới tab này rồi hỏi có đóng tab không.
  const onTimeout = useCallback((reason: string) => {
    const wb = useWorkbench.getState();
    wb.focusTab(tab.id);
    const host = `${String(p.user)}@${String(p.host)}:${String(p.port || 22)}`;
    void confirmDialog({
      title: tr("ssh.connectTimeoutTitle"),
      message: reason ? tr("ssh.connectFailClose", { host, reason }) : tr("ssh.connectTimeoutClose", { host, s: 5 }), // s = CONNECT_TIMEOUT_S trong Terminal.tsx (không import để giữ terminal tải lười)
      confirmLabel: tr("ssh.closeTab"),
    }).then((ok) => { if (ok) useWorkbench.getState().closeTab(tab.id); });
  }, [tab.id, tr]); // eslint-disable-line react-hooks/exhaustive-deps
  // SFTP mở sẵn mỗi khi vào phiên (bên trái terminal).
  const [filesOpen, setFilesOpen] = useState(true);
  const [filesW, setFilesW] = useSplitSize("ssh-files", FILES_DEFAULT, FILES_MIN, FILES_MAX);
  const [cd, setCd] = useState<{ arg: string; seq: number } | null>(null);
  const [dockerOpen, setDockerOpen] = useState(false);
  const cdSeq = useRef(0);
  const hostId = String(p.hostId ?? "");
  const curHost = hosts.find((h) => h.id === hostId);
  // Jump host tra theo host đã lưu lúc mở tab (sửa jump host thì mở lại tab để áp dụng).
  const jump = jumpCfgFor(curHost, hosts);
  // cfg/driver giữ nguyên object giữa các lần vẽ (đổi trạng thái, cd, sửa danh sách host…) → SftpPanel/SshStats/Terminal (memo) không vẽ lại.
  const cfg: ConnectCfg = useMemo(
    () => ({ host: String(p.host), port: Number(p.port) || 22, user: String(p.user), keyPath: String(p.keyPath ?? ""), jump }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [p.host, p.port, p.user, p.keyPath, jump?.host, jump?.port, jump?.user, jump?.keyPath],
  );
  // Tab exec vào container: chạy `docker exec -it` qua ssh -tt. Giao diện tối giản (chỉ terminal).
  const isExec = !!p.exec;
  const execCfg: ConnectCfg = useMemo(
    () => (isExec ? { ...cfg, command: String(p.command ?? ""), tty: p.tty !== false } : cfg),
    [cfg, isExec, p.command, p.tty],
  );
  const drv = useMemo(() => (isExec ? dockerFs(cfg, String(p.container ?? "")) : undefined), [cfg, isExec, p.container]);
  const onCd = useCallback((arg: string) => { cdSeq.current += 1; setCd({ arg, seq: cdSeq.current }); }, []);
  const base: ExecBase = { hostId, host: cfg.host, port: cfg.port, user: cfg.user, keyPath: cfg.keyPath, name: curHost?.name || String(p.name ?? ""), prod: !!p.prod };
  // Dropdown chọn host (sidebar đã thu lại khi đang trong phiên).
  const hostItems: PickerItem[] = [
    ...hosts.map((h) => ({
      id: h.id,
      label: h.name || h.host,
      group: folders.find((f) => f.id === h.folderId)?.name || undefined,
      hint: `${h.user}@${h.host}:${h.port}`,
      selected: h.id === hostId,
      icon: h.prod ? <span className="prod-tag">PROD</span> : undefined,
    })),
    { id: "\u0000new", label: tr("ssh.newHost"), icon: <Plus /> },
    { id: "\u0000list", label: tr("ssh.showFullHostList"), icon: <List /> },
  ];
  const onPickHost = (id: string) => {
    if (id === "\u0000new") return openHostForm(newHost(curHost?.folderId ?? ""));
    if (id === "\u0000list") return useWorkbench.getState().setSidebar("ssh", true);
    const h = hosts.find((x) => x.id === id);
    if (h) connect(h); // mở tab mới (cho phép nhiều tab/host); chuyển tab dùng thanh tab
  };
  // ── Tab exec container: terminal + panel file DUYỆT TRONG CONTAINER (qua docker exec), không stats. ──
  // Tiêu đề panel file giữ nguyên element giữa các lần vẽ (SftpPanel memo).
  const execTitle = useMemo(() => <><Container /> {String(p.container ?? "")}</>, [p.container]);
  if (isExec) {
    const container = String(p.container ?? "");
    return (
      <div className="view ssh-view">
        <div className="toolbar">
          <button
            className={`icon-btn ${filesOpen ? "on" : ""}`}
            title={tr("ssh.toggleContainerFiles")}
            onClick={() => setFilesOpen((v) => !v)}
          >
            <Folder />
          </button>
          <button className="icon-btn" title={tr("ssh.cmdHistTitle")} onClick={() => setHistOpen(true)}><History /></button>
          <span className="branch-glyph"><Container /></span>
          <b>{container}</b>
          <span className="mono muted small">{tr("ssh.in")} {base.name || cfg.host}</span>
          {p.prod ? <span className="prod-tag">PROD</span> : null}
          <span className="muted small">· {statusText}</span>
          <span className={`dot status-dot ${statusDot}`} />
          <span className="grow" />
        </div>
        <div className="ssh-body">
          <div
            className="ssh-files-wrap"
            style={{ width: filesW, flex: "0 0 auto", display: filesOpen ? "flex" : "none" }}
          >
            <SftpPanel cfg={cfg} driver={drv} title={execTitle} noUpload />
          </div>
          {filesOpen && (
            <Splitter axis="x" live="prev" min={FILES_MIN} max={FILES_MAX} onResize={(d) => setFilesW((w) => w + d)} onReset={() => setFilesW(FILES_DEFAULT)} />
          )}
          <div className="ssh-term-wrap">
            <Suspense fallback={null}><SshTerminal cfg={execCfg} onStatus={setStatus} onTimeout={onTimeout} onCommand={onCommand} /></Suspense>
          </div>
        </div>
        {histOpen && <CmdHistoryModal hostKey={histKey} title={`${container} · ${cfg.user}@${cfg.host}:${cfg.port}`} cfg={cfg} allowServer={false} onClose={() => setHistOpen(false)} />}
      </div>
    );
  }

  return (
    <div className="view ssh-view">
      <div className="toolbar">
        {/* Nút bật/tắt SFTP đặt sát mép trái cho khớp vị trí panel file. */}
        <button
          className={`icon-btn ${filesOpen ? "on" : ""}`}
          title={tr("ssh.toggleFileBrowserSftp")}
          onClick={() => setFilesOpen((v) => !v)}
        >
          <Folder />
        </button>
        <button
          className="icon-btn"
          title={tr("ssh.dockerContainersExecIntoAService")}
          onClick={() => setDockerOpen(true)}
        >
          <Container />
        </button>
        <button className="icon-btn" title={tr("ssh.cmdHistTitle")} onClick={() => setHistOpen(true)}>
          <History />
        </button>
        <Picker
          label={<><span className="branch-glyph"><Monitor /></span> {curHost ? curHost.name || curHost.host : cfg.host}</>}
          items={hostItems}
          onPick={onPickHost}
          title={tr("ssh.switchHost")}
          filterPlaceholder={tr("ssh.filterHosts")}
        />
        <span className="mono muted small">{cfg.user}@{cfg.host}:{cfg.port}</span>
        {p.prod ? <span className="prod-tag">PROD</span> : null}
        <span className="muted small">· {statusText}</span>
        <span className={`dot status-dot ${statusDot}`} />
        <span className="grow" />
      </div>
      <div className="ssh-body">
        {/* Giữ panel luôn mount: bật/tắt chỉ ẩn/hiện, KHÔNG đóng phiên sftp (mở lại là thấy ngay). */}
        <div
          className="ssh-files-wrap"
          style={{ width: filesW, flex: "0 0 auto", display: filesOpen ? "flex" : "none" }}
        >
          <SftpPanel cfg={cfg} followCd={cd} />
        </div>
        {filesOpen && (
          <Splitter axis="x" live="prev" min={FILES_MIN} max={FILES_MAX} onResize={(d) => setFilesW((w) => w + d)} onReset={() => setFilesW(FILES_DEFAULT)} />
        )}
        <div className="ssh-term-wrap">
          <Suspense fallback={null}>
            <SshTerminal
              cfg={cfg}
              onStatus={setStatus}
              onCd={onCd}
              onTimeout={onTimeout}
              onCommand={onCommand}
            />
          </Suspense>
          <SshStats cfg={cfg} />
        </div>
      </div>
      {dockerOpen && <DockerModal cfg={cfg} base={base} onClose={() => setDockerOpen(false)} />}
      {histOpen && <CmdHistoryModal hostKey={histKey} title={`${curHost?.name || cfg.host} · ${cfg.user}@${cfg.host}:${cfg.port}`} cfg={cfg} allowServer onClose={() => setHistOpen(false)} />}
    </div>
  );
}

/* ── Gốc app: tab + lắng nghe event tunnel ── */

function SshRoot() {
  const req = useHostFormReq();
  const tabCount = useWorkbench((s) => s.apps.ssh.tabs.length);
  const setSidebar = useWorkbench((s) => s.setSidebar);
  useEffect(() => {
    let un: (() => void) | undefined;
    void listen<{ id: string; line?: string; closed?: boolean }>("ssh-tunnel", (ev) => onTunnelEvent(ev.payload.id, ev.payload)).then((f) => { un = f; });
    return () => un?.();
  }, []);
  // Vào phiên → thu sidebar (danh sách host thành dropdown ở toolbar); đóng hết phiên → mở lại.
  // -1 để lần mount đầu cũng áp: mở app SSH khi chưa có phiên nào → luôn mở danh sách host.
  const prevCount = useRef(-1);
  useEffect(() => {
    if (prevCount.current === tabCount) return;
    prevCount.current = tabCount;
    setSidebar("ssh", tabCount === 0);
  }, [tabCount, setSidebar]);
  return (
    <>
      <TabbedLayout appId="ssh" Sidebar={Sidebar} TabView={TabView} empty={<SshEmpty />} />
      {req && <HostModal host={req.host} onClose={closeHostForm} />}
    </>
  );
}

function SshEmpty() {
  const tr = useT();
  return (
    <div className="welcome">
      <h1><Monitor /> SSH</h1>
      <p className="muted">{tr("ssh.addAHostToOpenA")}</p>
    </div>
  );
}

const sshApp: AppModule = {
  View: SshRoot,
  commands: () => [],
};

export default sshApp;
