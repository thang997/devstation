import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { AppModule, Tab } from "../types";
import { useWorkbench } from "../../store/workbench";
import { TabbedLayout } from "../../shell/TabbedLayout";
import { Modal } from "../../shell/Modal";
import { Picker, type PickerItem } from "../../shell/Picker";
import { ContextMenu, type CtxItem } from "../../shell/ContextMenu";
import { confirmDialog } from "../../shell/confirm";
import { t, useT } from "../../store/lang";
import { Splitter, useSplitSize } from "../../shell/Resizable";
import { SshTerminal } from "./Terminal";
import { SftpPanel } from "./SftpPanel";
import { SshStats } from "./SshStats";
import { ssh, dockerFs, errText, type ConnectCfg, type DockerContainer } from "./api";
import { removeHost, saveHost, setHosts, uid, useHosts, type SavedHost } from "./hosts";
import { addFolder, removeFolder, renameFolder, toggleFolder, useFolders } from "./folders";
import {
  newTunnel, onTunnelEvent, removeTunnel, saveTunnel, startTunnel, stopTunnel,
  tunnelDesc, useTunnelRuntime, useTunnels, type SavedTunnel,
} from "./tunnels";

const newHost = (folderId = ""): SavedHost => ({ id: uid("h"), name: "", host: "", port: 22, user: "", keyPath: "", prod: false, folderId });

/** Mở MỘT tab phiên mới cho host (cho phép nhiều tab cùng host — đánh số #2, #3… để phân biệt). */
function connect(h: SavedHost) {
  const wb = useWorkbench.getState();
  const n = wb.apps.ssh.tabs.filter((t) => t.payload?.hostId === h.id).length;
  wb.openTab({
    id: `ssh:term:${uid("x")}`,
    appId: "ssh",
    title: `🖥 ${h.name || h.host}${n ? ` #${n + 1}` : ""}`,
    payload: { hostId: h.id, host: h.host, port: h.port, user: h.user, keyPath: h.keyPath, name: h.name, prod: h.prod },
    danger: h.prod,
  });
  wb.log(`ssh ${h.user}@${h.host}:${h.port}`);
}

/** Thông tin host tối thiểu để mở tab exec vào container. */
interface ExecBase { hostId: string; host: string; port: number; user: string; keyPath: string; name: string; prod: boolean; }

/** Lệnh mở shell tương tác trong container: ưu tiên bash, không có thì sh. */
const dockerExecCmd = (c: string) => `docker exec -it ${c} sh -lc 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'`;

/** Mở một tab terminal exec thẳng vào container Docker (ssh -tt → docker exec -it). */
function connectExec(base: ExecBase, container: string) {
  const wb = useWorkbench.getState();
  wb.openTab({
    id: `ssh:exec:${uid("x")}`,
    appId: "ssh",
    title: `🐳 ${container}`,
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
function useHostFormReq() {
  return useSyncExternalStore(
    (cb) => { hostFormSubs.add(cb); return () => { hostFormSubs.delete(cb); }; },
    () => hostFormReq,
  );
}

/* ── Sidebar: hosts + tunnels ── */

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
  /** Kéo-thả sắp lại vị trí host: chèn `dragId` vào trước `targetId` (null = cuối), đổi folderId. */
  const dropHost = (targetId: string | null, folderId: string) => {
    if (!dragId) return;
    const list = [...hosts];
    const di = list.findIndex((h) => h.id === dragId);
    if (di < 0) return;
    const [moved] = list.splice(di, 1);
    moved.folderId = folderId;
    let ti = targetId ? list.findIndex((h) => h.id === targetId) : list.length;
    if (ti < 0) ti = list.length;
    list.splice(ti, 0, moved);
    setHosts(list);
    setDragId(null);
  };
  const [q, setQ] = useState("");
  const ql = q.trim().toLowerCase();
  const searching = ql.length > 0;
  const matchHost = (h: SavedHost) => !ql || `${h.name} ${h.host} ${h.user}`.toLowerCase().includes(ql);

  const openMenu = (e: React.MouseEvent, items: CtxItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };
  const folderMenu = (f: { id: string; name: string }): CtxItem[] => [
    { id: "add", icon: "＋", label: tr("Add host to folder…", "Thêm host vào thư mục…"), action: () => openHostForm(newHost(f.id)) },
    { id: "rename", icon: "✎", label: tr("Rename folder…", "Đổi tên thư mục…"), action: () => setEditingFolder(f.id) },
    { id: "s1", sep: true },
    { id: "del", icon: "🗑", label: tr("Delete folder (hosts move out)", "Xoá thư mục (host chuyển ra ngoài)"), danger: true, action: () => void confirmDialog({ message: tr(`Delete folder “${f.name}”? Hosts inside move out.`, `Xoá thư mục “${f.name}”? Host bên trong sẽ chuyển ra ngoài.`) }).then((ok) => ok && removeFolder(f.id)) },
  ];
  const hostMenu = (h: SavedHost): CtxItem[] => [
    { id: "conn", icon: "🖥", label: tr("Connect", "Kết nối"), action: () => connect(h) },
    { id: "rename", icon: "✎", label: tr("Rename (F2)", "Đổi tên (F2)"), action: () => setRenaming(h.id) },
    { id: "edit", icon: "⚙", label: tr("Edit host…", "Sửa host…"), action: () => openHostForm(h) },
    { id: "dup", icon: "⧉", label: tr("Duplicate host…", "Nhân bản host…"), action: () => openHostForm({ ...h, id: uid("h"), name: `${h.name || h.host} (copy)` }) },
    { id: "s1", sep: true },
    { id: "forget", icon: "🔑", label: tr("Forget saved password", "Quên mật khẩu đã lưu"), action: () => void ssh.forgetPassword(h.user, h.host, h.port) },
    { id: "del", icon: "🗑", label: tr("Delete host", "Xoá host"), danger: true, action: () => void confirmDialog({ message: tr(`Delete host “${h.name || h.host}”?`, `Xoá host “${h.name || h.host}”?`) }).then((ok) => ok && removeHost(h.id)) },
  ];

  const hostRow = (h: SavedHost, inFolder: boolean) =>
    renaming === h.id ? (
      <div key={h.id} className="side-item ssh-host" style={inFolder ? { paddingLeft: 24 } : undefined} onClick={(e) => e.stopPropagation()}>
        <span className="dot green" />
        <input
          autoFocus
          className="tree-rename grow"
          defaultValue={h.name || h.host}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => { saveHost({ ...h, name: e.target.value.trim() || h.host }); setRenaming(null); }}
          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") setRenaming(null); }}
        />
      </div>
    ) : (
    <div
      key={h.id}
      className={`side-item ssh-host ${h.prod ? "prod" : ""} ${sel === h.id ? "sel" : ""} ${dragId === h.id ? "dragging" : ""}`}
      style={inFolder ? { paddingLeft: 24 } : undefined}
      draggable
      tabIndex={0}
      onDragStart={(e) => { setDragId(h.id); e.dataTransfer.effectAllowed = "move"; }}
      onDragEnd={() => setDragId(null)}
      onDragOver={(e) => { if (dragId) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (dragId !== h.id) e.currentTarget.classList.add("drop-before"); } }}
      onDragLeave={(e) => e.currentTarget.classList.remove("drop-before")}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); e.currentTarget.classList.remove("drop-before"); dropHost(h.id, h.folderId ?? ""); }}
      onClick={() => setSel(h.id)}
      onDoubleClick={() => connect(h)}
      onKeyDown={(e) => { if (e.key === "F2") { e.preventDefault(); setRenaming(h.id); } }}
      onContextMenu={(e) => { setSel(h.id); openMenu(e, hostMenu(h)); }}
      title={`${tr("Double-click to connect", "Double-click để kết nối")} ${h.user}@${h.host}${h.prod ? " (PROD)" : ""} · ${tr("F2 to rename", "F2 đổi tên")}`}
    >
      <span className="dot green" />
      <span className="grow ellipsis">{h.name || h.host}</span>
      {h.prod && <span className="prod-tag">PROD</span>}
      <span className="muted small ellipsis">{h.user}@{h.host}</span>
      <span className="row-actions" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn" title={tr("Edit", "Sửa")} onClick={() => openHostForm(h)}>✎</button>
        <button className="icon-btn" title={tr("Delete", "Xoá")} onClick={() => void confirmDialog({ message: tr(`Delete host “${h.name || h.host}”?`, `Xoá host “${h.name || h.host}”?`) }).then((ok) => ok && removeHost(h.id))}>×</button>
      </span>
    </div>
  );

  const rootHosts = hosts.filter((h) => !h.folderId || !folders.some((f) => f.id === h.folderId));

  return (
    <div
      className="side-list"
      onDragOver={(e) => { if (dragId) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; } }}
      onDrop={(e) => { if (dragId) { e.preventDefault(); dropHost(null, ""); } }}
    >
      <div className="side-head">
        <span>HOSTS</span>
        <span className="side-actions">
          <button className="icon-btn" title={tr("Add host", "Thêm host")} onClick={() => openHostForm(newHost())}>＋</button>
          <button className="icon-btn" title={tr("New folder", "Thư mục mới")} onClick={() => setEditingFolder(addFolder())}>🗂</button>
        </span>
      </div>
      {hosts.length > 0 && (
        <div className="side-search-row">
          <span className="side-search-ic">🔍</span>
          <input className="side-search" placeholder={tr("Search host (name / IP / user)…", "Tìm host (tên / IP / user)…")} value={q} onChange={(e) => setQ(e.target.value)} />
          {q && <button className="icon-btn" title={tr("Clear search", "Xoá tìm")} onClick={() => setQ("")}>×</button>}
        </div>
      )}
      {hosts.length === 0 && folders.length === 0 && <div className="muted small pad">{tr("No hosts. Click ＋ to add.", "Chưa có host. Bấm ＋ để thêm.")}</div>}

      {/* Đang tìm: hiện phẳng mọi host khớp (bỏ qua nhóm/thu gọn). Không tìm: giữ cây thư mục. */}
      {searching ? (
        hosts.filter(matchHost).length ? (
          hosts.filter(matchHost).map((h) => hostRow(h, false))
        ) : (
          <div className="muted small pad">Không có host khớp “{q}”.</div>
        )
      ) : (
        <>
          {folders.map((f) => (
            <div key={f.id}>
              <div
            className="tree-row"
            tabIndex={0}
            onClick={() => toggleFolder(f.id)}
            onKeyDown={(e) => { if (e.key === "F2") { e.preventDefault(); setEditingFolder(f.id); } }}
            onDragOver={(e) => { if (dragId) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; e.currentTarget.classList.add("drop-into"); } }}
            onDragLeave={(e) => e.currentTarget.classList.remove("drop-into")}
            onDrop={(e) => { e.preventDefault(); e.stopPropagation(); e.currentTarget.classList.remove("drop-into"); dropHost(null, f.id); }}
            onContextMenu={(e) => openMenu(e, folderMenu(f))}
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
                    onBlur={(e) => { renameFolder(f.id, e.target.value.trim() || f.name); setEditingFolder(null); }}
                    onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") setEditingFolder(null); }}
                  />
                ) : (
                  <span className="grow ellipsis">{f.name}</span>
                )}
                <span className="row-actions" onClick={(e) => e.stopPropagation()}>
                  <button className="icon-btn" title={tr("Add host to folder", "Thêm host vào thư mục")} onClick={() => openHostForm(newHost(f.id))}>＋</button>
                  <button className="icon-btn" title={tr("Rename", "Đổi tên")} onClick={() => setEditingFolder(f.id)}>✎</button>
                  <button className="icon-btn" title={tr("Delete folder (hosts move out)", "Xoá thư mục (host chuyển ra ngoài)")} onClick={() => void confirmDialog({ message: tr(`Delete folder “${f.name}”? Hosts inside move out.`, `Xoá thư mục “${f.name}”? Host bên trong sẽ chuyển ra ngoài.`) }).then((ok) => ok && removeFolder(f.id))}>×</button>
                </span>
              </div>
              {f.open && hosts.filter((h) => h.folderId === f.id).map((h) => hostRow(h, true))}
            </div>
          ))}
          {rootHosts.map((h) => hostRow(h, false))}
        </>
      )}

      <div className="side-head">
        <span>TUNNELS</span>
        <button className="icon-btn" title={tr("Add tunnel", "Thêm tunnel")} onClick={() => setTunModal(newTunnel())}>＋</button>
      </div>
      {tunnels.length === 0 && <div className="muted small pad">{tr("No tunnels (port forward).", "Chưa có tunnel (port forward).")}</div>}
      {tunnels.map((tn) => {
        const st = runtime[tn.id]?.status ?? "stopped";
        const on = st === "running" || st === "starting";
        return (
          <div key={tn.id} className="side-item ssh-tunnel" title={runtime[tn.id]?.msg || tunnelDesc(tn)}>
            <button
              className="icon-btn tun-toggle"
              title={on ? tr("Stop tunnel", "Dừng tunnel") : tr("Open tunnel", "Mở tunnel")}
              onClick={() => (on ? void stopTunnel(tn.id) : void startTunnel(tn.id))}
            >
              {on ? "⏹" : "▶"}
            </button>
            <span className={`dot tun-${st}`} />
            <span className="grow ellipsis">{tn.name}</span>
            {tn.autostart && <span title={tr("Auto-start on app launch", "Tự chạy khi mở app")} style={{ opacity: 0.7 }}>⚡</span>}
            <span className="muted small ellipsis">{tunnelDesc(tn)}</span>
            <span className="row-actions">
              <button className="icon-btn" title={tr("Edit", "Sửa")} onClick={() => setTunModal(tn)}>✎</button>
              <button className="icon-btn" title={tr("Delete", "Xoá")} onClick={() => void confirmDialog({ message: tr(`Delete tunnel “${tn.name}”?`, `Xoá tunnel “${tn.name}”?`) }).then((ok) => ok && removeTunnel(tn.id))}>×</button>
            </span>
          </div>
        );
      })}

      {tunModal && <TunnelModal tunnel={tunModal} onClose={() => setTunModal(null)} />}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

/* ── Chọn file key ── */

async function pickKey(set: (p: string) => void) {
  const f = await openDialog({ multiple: false, title: t("Choose private key", "Chọn private key") });
  if (typeof f === "string") set(f);
}

/* ── Modal thêm/sửa host ── */

function HostModal({ host, onClose }: { host: SavedHost; onClose: () => void }) {
  const tr = useT();
  const [h, setH] = useState<SavedHost>(host);
  const folders = useFolders();
  const [hasPw, setHasPw] = useState(false);
  const set = (p: Partial<SavedHost>) => setH((x) => ({ ...x, ...p }));
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
    if (!h.host.trim() || !h.user.trim()) return;
    saveHost({ ...h, name: h.name.trim() || h.host.trim() });
    onClose();
  };
  return (
    <Modal title={tr("🖥 SSH Host", "🖥 Host SSH")} width={560} onClose={onClose}>
      <div className="form account-form">
        <label>{tr("Display name", "Tên gợi nhớ")}<input autoFocus value={h.name} placeholder="vd. prod-web" onChange={(e) => set({ name: e.target.value })} /></label>
        <div className="form-row">
          <label className="grow">Host / IP<input className="mono" value={h.host} placeholder="10.0.0.5" onChange={(e) => set({ host: e.target.value })} /></label>
          <label style={{ width: 90 }}>Port<input className="mono" type="number" value={h.port} onChange={(e) => set({ port: Number(e.target.value) || 22 })} /></label>
        </div>
        <label>User<input value={h.user} placeholder="ubuntu" onChange={(e) => set({ user: e.target.value })} /></label>
        <label>{tr("Private key (optional)", "Private key (tuỳ chọn)")}
          <div className="form-row">
            <input className="grow mono" value={h.keyPath} placeholder={tr("empty = default key / ssh-agent", "để trống = key mặc định / ssh-agent")} onChange={(e) => set({ keyPath: e.target.value })} />
            <button onClick={() => void pickKey((p) => set({ keyPath: p }))}>{tr("Browse…", "Chọn…")}</button>
          </div>
        </label>
        <div className="field">
          <span className="field-cap">{tr("Folder", "Thư mục")}</span>
          <div className="picker-field">
            <Picker
              label={<span className="ellipsis">{folders.find((f) => f.id === h.folderId)?.name ?? tr("(No folder)", "(Ngoài thư mục)")}</span>}
              items={[{ id: "", label: tr("(No folder)", "(Ngoài thư mục)"), selected: !h.folderId }, ...folders.map((f) => ({ id: f.id, label: f.name, selected: h.folderId === f.id }))]}
              onPick={(id) => set({ folderId: id })}
            />
          </div>
        </div>
        <label className="check"><input type="checkbox" checked={h.prod} onChange={(e) => set({ prod: e.target.checked })} /> {tr("Mark PROD (red border, be careful)", "Đánh dấu PROD (viền đỏ, cẩn thận)")}</label>
        {hasPw ? (
          <div className="form-row" style={{ alignItems: "center" }}>
            <span className="muted small grow">{tr("🔑 Password saved for this host — auto login next time.", "🔑 Đã lưu mật khẩu cho host này — lần sau tự đăng nhập.")}</span>
            <button onClick={forget}>{tr("Forget password", "Quên mật khẩu")}</button>
          </div>
        ) : (
          <div className="muted small">
            {tr("🔒 No saved password. Type it correctly the first time → saved securely to Windows Credential Manager, no need to type again (MobaXterm-style).", "🔒 Mật khẩu chưa lưu. Gõ đúng mật khẩu lần đầu → tự lưu an toàn vào Windows Credential Manager, lần sau khỏi nhập (kiểu MobaXterm).")}
          </div>
        )}
        <div className="toolbar">
          <span className="grow" />
          <button onClick={onClose}>{tr("Cancel", "Huỷ")}</button>
          <button className="primary" disabled={!h.host.trim() || !h.user.trim()} onClick={save}>{tr("Save", "Lưu")}</button>
        </div>
      </div>
    </Modal>
  );
}

/* ── Modal thêm/sửa tunnel ── */

function TunnelModal({ tunnel, onClose }: { tunnel: SavedTunnel; onClose: () => void }) {
  const tr = useT();
  const [t, setT] = useState<SavedTunnel>(tunnel);
  const set = (p: Partial<SavedTunnel>) => setT((x) => ({ ...x, ...p }));
  const KIND_LABEL: Record<SavedTunnel["kind"], string> = {
    L: tr("Local  (-L): local port → target via server", "Local  (-L): cổng máy → đích qua server"),
    R: tr("Remote (-R): server port → target via local", "Remote (-R): cổng server → đích qua máy"),
    D: "Dynamic (-D): SOCKS proxy",
  };
  const save = () => {
    if (!t.host.trim() || !t.user.trim()) return;
    saveTunnel({ ...t, name: t.name.trim() || tunnelDesc(t) });
    onClose();
  };
  return (
    <Modal title={tr("🔀 Tunnel (port forward)", "🔀 Tunnel (port forward)")} width={620} onClose={onClose}>
      <div className="form account-form">
        <label>{tr("Name", "Tên")}<input autoFocus value={t.name} onChange={(e) => set({ name: e.target.value })} /></label>
        <div className="field">
          <span className="field-cap">{tr("Kind", "Kiểu")}</span>
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
          <label style={{ width: 90 }}>Port<input className="mono" type="number" value={t.port} onChange={(e) => set({ port: Number(e.target.value) || 22 })} /></label>
          <label className="grow">User<input value={t.user} onChange={(e) => set({ user: e.target.value })} /></label>
        </div>
        <label>{tr("Private key (optional — tunnels should use a key)", "Private key (tuỳ chọn — tunnel nên dùng key)")}
          <div className="form-row">
            <input className="grow mono" value={t.keyPath} placeholder={tr("empty = default key / ssh-agent", "để trống = key mặc định / ssh-agent")} onChange={(e) => set({ keyPath: e.target.value })} />
            <button onClick={() => void pickKey((p) => set({ keyPath: p }))}>{tr("Browse…", "Chọn…")}</button>
          </div>
        </label>
        <div className="form-row">
          <label style={{ width: 150 }}>{t.kind === "D" ? tr("SOCKS port", "Cổng SOCKS") : tr("Local port", "Cổng mở ở máy")}<input className="mono" type="number" value={t.localPort} onChange={(e) => set({ localPort: Number(e.target.value) || 0 })} /></label>
          {t.kind !== "D" && (
            <>
              <label className="grow">{tr("Target host", "Đích host")}<input className="mono" value={t.remoteHost} placeholder="localhost" onChange={(e) => set({ remoteHost: e.target.value })} /></label>
              <label style={{ width: 120 }}>{tr("Target port", "Đích port")}<input className="mono" type="number" value={t.remotePort} onChange={(e) => set({ remotePort: Number(e.target.value) || 0 })} /></label>
            </>
          )}
        </div>
        <label className="check"><input type="checkbox" checked={!!t.autostart} onChange={(e) => set({ autostart: e.target.checked })} /> {tr("Auto-start this tunnel on app launch", "Tự chạy tunnel này khi mở app")}</label>

        {/* Sơ đồ đường đi: hiện rõ cổng LOCAL và luồng dữ liệu theo từng kiểu. */}
        <div className="tun-flow">
          {t.kind === "L" && (<>
            <span className="tun-node you">🖥 127.0.0.1:{t.localPort}</span>
            <span className="tun-arrow">→</span>
            <span className="tun-node srv">{t.host || "server"}:{t.port}</span>
            <span className="tun-arrow">→</span>
            <span className="tun-node tgt">🎯 {t.remoteHost || "localhost"}:{t.remotePort}</span>
          </>)}
          {t.kind === "R" && (<>
            <span className="tun-node srv">{t.host || "server"}:{t.localPort}</span>
            <span className="tun-arrow">→</span>
            <span className="tun-node you">🖥 {tr("your machine", "máy bạn")}</span>
            <span className="tun-arrow">→</span>
            <span className="tun-node tgt">🎯 {t.remoteHost || "localhost"}:{t.remotePort}</span>
          </>)}
          {t.kind === "D" && (<>
            <span className="tun-node you">🖥 SOCKS 127.0.0.1:{t.localPort}</span>
            <span className="tun-arrow">→</span>
            <span className="tun-node srv">{t.host || "server"}:{t.port}</span>
            <span className="tun-arrow">→</span>
            <span className="tun-node tgt">{tr("any destination", "mọi đích")}</span>
          </>)}
        </div>
        <div className="muted small">
          {t.kind === "L" && tr(
            `Connect to 127.0.0.1:${t.localPort} on your machine → reaches ${t.remoteHost || "localhost"}:${t.remotePort} via the server.`,
            `Kết nối tới 127.0.0.1:${t.localPort} trên MÁY BẠN → chạm ${t.remoteHost || "localhost"}:${t.remotePort} qua server.`)}
          {t.kind === "R" && tr(
            `On the server, 127.0.0.1:${t.localPort} → reaches ${t.remoteHost || "localhost"}:${t.remotePort} on your side.`,
            `Trên SERVER, 127.0.0.1:${t.localPort} → chạm ${t.remoteHost || "localhost"}:${t.remotePort} ở phía máy bạn.`)}
          {t.kind === "D" && tr(
            `Set SOCKS5 proxy 127.0.0.1:${t.localPort} in your apps to route out through the server.`,
            `Đặt proxy SOCKS5 127.0.0.1:${t.localPort} cho app để đi ra qua server.`)}
        </div>
        <div className="muted small">{tr("Tunnel runs with", "Tunnel chạy bằng")} <span className="mono">ssh -N {t.kind === "D" ? "-D" : t.kind === "L" ? "-L" : "-R"}</span> {tr("in BatchMode (needs key/agent, no password prompt).", "ở chế độ BatchMode (cần key/agent, không hỏi mật khẩu).")}</div>
        <div className="toolbar">
          <span className="grow" />
          <button onClick={onClose}>{tr("Cancel", "Huỷ")}</button>
          <button className="primary" disabled={!t.host.trim() || !t.user.trim()} onClick={save}>{tr("Save", "Lưu")}</button>
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
    { id: "exec", icon: "▶", label: tr("Exec (shell into container)", "Exec (vào shell container)"), action: () => exec(c) },
    { id: "s1", sep: true },
    { id: "copy", icon: "⧉", label: tr("Copy name", "Copy tên"), action: () => void navigator.clipboard.writeText(c.name || c.id) },
    { id: "copyid", icon: "#", label: tr("Copy ID", "Copy ID"), action: () => void navigator.clipboard.writeText(c.id) },
    { id: "copyimg", icon: "🖼", label: tr("Copy image", "Copy image"), action: () => void navigator.clipboard.writeText(c.image) },
  ];
  return (
    <Modal title={tr("🐳 Docker containers", "🐳 Container Docker")} width={760} onClose={onClose}>
      {/* minHeight cố định để khi Refresh (list → spinner) modal không bị co lại. */}
      <div className="form" style={{ maxWidth: "none", minHeight: 480 }}>
        <div className="toolbar">
          <span className="mono muted small grow ellipsis">{base.name || cfg.host} · {cfg.user}@{cfg.host}:{cfg.port}</span>
          {base.prod ? <span className="prod-tag">PROD</span> : null}
          <button onClick={load} disabled={loading}>{loading ? tr("Loading…", "Đang tải…") : tr("↻ Refresh", "↻ Làm mới")}</button>
        </div>
        {loading && (
          <div className="db-connecting"><span className="spinner" /> {tr("Reading", "Đang đọc")} <span className="mono">docker ps</span>…</div>
        )}
        {!loading && err && <div className="error-box pre">{err}</div>}
        {!loading && !err && list && list.length === 0 && (
          <div className="muted pad">{tr("No running containers (docker ps empty).", "Không có container nào đang chạy (docker ps rỗng).")}</div>
        )}
        {!loading && !err && list && list.length > 0 && (() => {
          const ql = q.trim().toLowerCase();
          const shown = ql
            ? list.filter((c) => `${c.name} ${c.image} ${c.ports} ${c.id}`.toLowerCase().includes(ql))
            : list;
          return (
          <>
          <div className="side-search-row">
            <span className="side-search-ic">🔍</span>
            <input
              autoFocus
              className="side-search"
              placeholder={tr("Filter by name / image / port…", "Lọc theo tên / image / cổng…")}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            {q && <button className="icon-btn" title={tr("Clear", "Xoá")} onClick={() => setQ("")}>×</button>}
            <span className="muted small" style={{ whiteSpace: "nowrap" }}>{shown.length}/{list.length}</span>
          </div>
          {shown.length === 0 ? (
            <div className="muted pad">{tr("No container matches", "Không có container khớp")} “{q}”.</div>
          ) : (
          <div className="docker-list">
            {shown.map((c) => (
              <div
                key={c.id}
                className="docker-row"
                onDoubleClick={() => exec(c)}
                onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, items: rowMenu(c) }); }}
                title={tr("Double-click to exec into this container", "Double-click để exec vào container này")}
              >
                <span className="docker-ic">🐳</span>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="ellipsis"><b>{c.name || c.id.slice(0, 12)}</b> <span className="muted small">{c.image}</span></div>
                  <div className="muted small ellipsis">{c.status}{c.ports ? ` · ${c.ports}` : ""}</div>
                </div>
                <button className="primary" onClick={() => exec(c)} title={tr("Open a shell inside this container", "Mở shell trong container này")}>Exec</button>
              </div>
            ))}
          </div>
          )}
          </>
          );
        })()}
        <div className="muted small">
          {tr("Exec opens a terminal tab running", "Exec mở một tab terminal chạy")} <span className="mono">ssh -tt → docker exec -it &lt;name&gt; bash/sh</span>.
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
    status === "connected" ? tr("connected", "đã kết nối")
    : status === "connecting" ? tr("connecting…", "đang kết nối…")
    : status === "closed" ? tr("closed", "đã đóng")
    : status === "error" ? tr("error", "lỗi")
    : status;
  const statusDot = status === "connected" ? "green" : status === "error" ? "red" : status === "connecting" ? "yellow" : "grey";
  // SFTP mở sẵn mỗi khi vào phiên (bên trái terminal).
  const [filesOpen, setFilesOpen] = useState(true);
  const [filesW, setFilesW] = useSplitSize("ssh-files", FILES_DEFAULT, FILES_MIN, FILES_MAX);
  const [cd, setCd] = useState<{ arg: string; seq: number } | null>(null);
  const [dockerOpen, setDockerOpen] = useState(false);
  const cdSeq = useRef(0);
  const cfg = { host: String(p.host), port: Number(p.port) || 22, user: String(p.user), keyPath: String(p.keyPath ?? "") };
  const hostId = String(p.hostId ?? "");
  const curHost = hosts.find((h) => h.id === hostId);
  // Tab exec vào container: chạy `docker exec -it` qua ssh -tt. Giao diện tối giản (chỉ terminal).
  const isExec = !!p.exec;
  const execCfg: ConnectCfg = isExec ? { ...cfg, command: String(p.command ?? ""), tty: p.tty !== false } : cfg;
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
    { id: "\u0000new", label: tr("＋ New host…", "＋ Host mới…") },
    { id: "\u0000list", label: tr("Show full host list", "Hiện danh sách host đầy đủ"), icon: "☰" },
  ];
  const onPickHost = (id: string) => {
    if (id === "\u0000new") return openHostForm(newHost(curHost?.folderId ?? ""));
    if (id === "\u0000list") return useWorkbench.getState().setSidebar("ssh", true);
    const h = hosts.find((x) => x.id === id);
    if (h) connect(h); // mở tab mới (cho phép nhiều tab/host); chuyển tab dùng thanh tab
  };
  // ── Tab exec container: terminal + panel file DUYỆT TRONG CONTAINER (qua docker exec), không stats. ──
  if (isExec) {
    const container = String(p.container ?? "");
    const drv = dockerFs(cfg, container);
    return (
      <div className="view ssh-view">
        <div className="toolbar">
          <button
            className={`icon-btn ${filesOpen ? "on" : ""}`}
            title={tr("Toggle container files", "Bật/tắt file trong container")}
            onClick={() => setFilesOpen((v) => !v)}
          >
            📁
          </button>
          <span className="branch-glyph">🐳</span>
          <b>{container}</b>
          <span className="mono muted small">{tr("in", "trong")} {base.name || cfg.host}</span>
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
            <SftpPanel cfg={cfg} driver={drv} title={`🐳 ${container}`} noUpload />
          </div>
          {filesOpen && (
            <Splitter axis="x" onResize={(d) => setFilesW((w) => w + d)} onReset={() => setFilesW(FILES_DEFAULT)} />
          )}
          <div className="ssh-term-wrap">
            <SshTerminal cfg={execCfg} onStatus={setStatus} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="view ssh-view">
      <div className="toolbar">
        {/* Nút bật/tắt SFTP đặt sát mép trái cho khớp vị trí panel file. */}
        <button
          className={`icon-btn ${filesOpen ? "on" : ""}`}
          title={tr("Toggle file browser (SFTP)", "Bật/tắt trình duyệt file (SFTP)")}
          onClick={() => setFilesOpen((v) => !v)}
        >
          📁
        </button>
        <button
          className="icon-btn"
          title={tr("Docker containers (exec into a service)", "Container Docker (exec vào service)")}
          onClick={() => setDockerOpen(true)}
        >
          🐳
        </button>
        <Picker
          label={<><span className="branch-glyph">🖥</span> {curHost ? curHost.name || curHost.host : cfg.host}</>}
          items={hostItems}
          onPick={onPickHost}
          title={tr("Switch host", "Đổi host")}
          filterPlaceholder={tr("Filter hosts…", "Lọc host…")}
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
          <Splitter axis="x" onResize={(d) => setFilesW((w) => w + d)} onReset={() => setFilesW(FILES_DEFAULT)} />
        )}
        <div className="ssh-term-wrap">
          <SshTerminal
            cfg={cfg}
            onStatus={setStatus}
            onCd={(arg) => { cdSeq.current += 1; setCd({ arg, seq: cdSeq.current }); }}
          />
          <SshStats cfg={cfg} />
        </div>
      </div>
      {dockerOpen && <DockerModal cfg={cfg} base={base} onClose={() => setDockerOpen(false)} />}
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
      <h1>🖥 SSH</h1>
      <p className="muted">{tr("Add a host to open a real terminal (via the machine's ssh.exe), create MobaXterm-style tunnels (-L/-R/-D).", "Thêm host để mở terminal thật (qua ssh.exe của máy), tạo tunnel kiểu MobaXterm (-L/-R/-D).")}</p>
    </div>
  );
}

const sshApp: AppModule = {
  View: SshRoot,
  commands: () => [],
};

export default sshApp;
