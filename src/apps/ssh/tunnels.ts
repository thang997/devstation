import { useSyncExternalStore } from "react";
import { ssh, errText, type TunnelCfg } from "./api";
import { uid } from "./hosts";
import { t as tr } from "../../store/lang";

/** Một tunnel đã lưu (độc lập, tự chứa thông tin kết nối — giống MobaXterm). */
export interface SavedTunnel {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  keyPath: string;
  kind: "L" | "R" | "D";
  /** Cổng mở ở máy (với D là cổng SOCKS). */
  localPort: number;
  /** Đích (không dùng cho D). */
  remoteHost: string;
  remotePort: number;
  /** Tự mở tunnel này ngay khi chạy app. */
  autostart?: boolean;
}

export type TunStatus = "stopped" | "starting" | "running" | "error";
export interface TunRuntime {
  status: TunStatus;
  msg: string;
}

const KEY = "devstation.ssh.tunnels";

function load(): SavedTunnel[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

let tunnels: SavedTunnel[] = load();
let runtime: Record<string, TunRuntime> = {};
const subs = new Set<() => void>();

function notify() {
  subs.forEach((f) => f());
}
function saveList(next: SavedTunnel[]) {
  tunnels = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(tunnels));
  } catch {
    /* hết chỗ */
  }
  notify();
}
function setRuntime(id: string, r: TunRuntime) {
  runtime = { ...runtime, [id]: r };
  notify();
}

export { uid };

export function useTunnels(): SavedTunnel[] {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => tunnels);
}
export function useTunnelRuntime(): Record<string, TunRuntime> {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => runtime);
}

export function saveTunnel(t: SavedTunnel) {
  const i = tunnels.findIndex((x) => x.id === t.id);
  saveList(i >= 0 ? tunnels.map((x) => (x.id === t.id ? t : x)) : [...tunnels, t]);
}
export function removeTunnel(id: string) {
  void stopTunnel(id);
  saveList(tunnels.filter((x) => x.id !== id));
}

export async function startTunnel(id: string) {
  const t = tunnels.find((x) => x.id === id);
  if (!t) return;
  setRuntime(id, { status: "starting", msg: tr("opening…", "đang mở…") });
  const cfg: TunnelCfg = {
    id: t.id, host: t.host, port: t.port, user: t.user, keyPath: t.keyPath,
    kind: t.kind, localPort: t.localPort, remoteHost: t.remoteHost, remotePort: t.remotePort,
  };
  try {
    await ssh.tunnelOpen(cfg);
    // Không có lỗi tức thì → coi như đang chạy; event ssh-tunnel sẽ cập nhật nếu có vấn đề.
    setRuntime(id, { status: "running", msg: tunnelDesc(t) });
  } catch (e) {
    setRuntime(id, { status: "error", msg: errText(e) });
  }
}

let autostarted = false;
/** Mở các tunnel được đánh dấu autostart — gọi một lần lúc khởi động app. */
export function startAutostartTunnels() {
  if (autostarted) return;
  autostarted = true;
  for (const t of tunnels) {
    if (t.autostart) void startTunnel(t.id);
  }
}

export async function stopTunnel(id: string) {
  try {
    await ssh.tunnelClose(id);
  } catch {
    /* kệ */
  }
  setRuntime(id, { status: "stopped", msg: "" });
}

/** Cập nhật từ event `ssh-tunnel` (stderr của ssh): dòng lỗi hoặc tiến trình thoát. */
export function onTunnelEvent(id: string, ev: { line?: string; closed?: boolean }) {
  const cur = runtime[id];
  if (!cur || cur.status === "stopped") return; // đã chủ động đóng
  if (ev.closed) {
    // ssh thoát trong khi ta tưởng đang chạy = lỗi (auth / cổng bận / mất kết nối).
    setRuntime(id, { status: "error", msg: cur.msg && cur.status === "error" ? cur.msg : tr("ssh exited — check key/port", "ssh thoát — kiểm tra key/cổng") });
  } else if (ev.line) {
    const low = ev.line.toLowerCase();
    const bad = /denied|refused|failed|cannot|error|address already|timed out/.test(low);
    setRuntime(id, { status: bad ? "error" : cur.status, msg: ev.line });
  }
}

export function tunnelDesc(t: SavedTunnel): string {
  if (t.kind === "D") return `SOCKS :${t.localPort}`;
  const arrow = t.kind === "L" ? "→" : "←";
  return `:${t.localPort} ${arrow} ${t.remoteHost}:${t.remotePort}`;
}

export const newTunnel = (): SavedTunnel => ({
  id: uid("t"), name: tr("New tunnel", "Tunnel mới"), host: "", port: 22, user: "", keyPath: "",
  kind: "L", localPort: 8080, remoteHost: "localhost", remotePort: 80,
});
