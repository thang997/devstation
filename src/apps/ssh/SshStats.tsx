import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useT } from "../../store/lang";
import { ssh, type ConnectCfg, type SshStat } from "./api";

/* Icon line-art nhỏ (dùng currentColor) — gọn hơn emoji và hợp theme. */
const svg = (children: React.ReactNode) => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor"
    strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
const IconCpu = () => svg(<>
  <rect x="4.5" y="4.5" width="7" height="7" rx="1" />
  <path d="M6.5 1.5v3M9.5 1.5v3M6.5 11.5v3M9.5 11.5v3M1.5 6.5h3M1.5 9.5h3M11.5 6.5h3M11.5 9.5h3" />
</>);
const IconRam = () => svg(<>
  <rect x="1.8" y="5" width="12.4" height="6" rx="1" />
  <path d="M4.5 11v2.2M8 11v2.2M11.5 11v2.2" />
</>);
const IconDisk = () => svg(<>
  <rect x="2" y="2.8" width="12" height="10.4" rx="1.4" />
  <circle cx="8" cy="8" r="2.4" />
</>);
const IconClock = () => svg(<>
  <circle cx="8" cy="8" r="5.8" /><path d="M8 4.7V8l2.3 1.4" />
</>);

function human(n: number): string {
  if (n < 1024) return `${Math.round(n)} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}
function rate(n: number): string {
  return `${human(n)}/s`;
}
/** Giây → "31d 19h" / "5h 12m" / "8m". */
function uptimeText(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Dải thống kê server (CPU/RAM/net/disk) kiểu MobaXterm. Chạy phiên ssh ẩn đọc /proc mỗi ~2s. */
export function SshStats({ cfg }: { cfg: Omit<ConnectCfg, "cols" | "rows" | "command"> }) {
  const tr = useT();
  const [stat, setStat] = useState<SshStat | null>(null);
  const [off, setOff] = useState(false); // server không hỗ trợ (không /proc) hoặc lỗi
  const sidRef = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    let un: (() => void) | undefined;
    // Không nhận được mẫu nào sau 15s (không đăng nhập được / không phải Linux) → ẩn dải.
    let got = false;
    const timer = setTimeout(() => { if (alive && !got) setOff(true); }, 15000);
    (async () => {
      try {
        const id = await ssh.statStart(cfg);
        if (!alive) {
          void ssh.statStop(id);
          return;
        }
        sidRef.current = id;
        un = await listen<SshStat>("ssh-stat", (ev) => {
          if (ev.payload.id === sidRef.current) { got = true; setStat(ev.payload); }
        });
      } catch {
        if (alive) setOff(true);
      }
    })();
    return () => {
      alive = false;
      clearTimeout(timer);
      un?.();
      if (sidRef.current) void ssh.statStop(sidRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (off) return null;
  if (!stat) {
    return <div className="ssh-stats muted"><span className="spinner" /> {tr("Reading server stats…", "Đang đọc thông số server…")}</div>;
  }

  const memPct = stat.memTotal ? Math.round((stat.memUsed / stat.memTotal) * 100) : 0;
  const diskPct = stat.diskTotal ? Math.round((stat.diskUsed / stat.diskTotal) * 100) : 0;
  const bar = (icon: React.ReactNode, label: string, pct: number, detail: string) => (
    <span className="stat-item" title={detail}>
      <span className="stat-label">{icon}{label}</span>
      <span className="stat-bar"><span className={`stat-fill ${pct >= 90 ? "hot" : pct >= 70 ? "warm" : ""}`} style={{ width: `${Math.min(100, pct)}%` }} /></span>
      <span className="stat-val">{pct}%</span>
    </span>
  );

  return (
    <div className="ssh-stats">
      {bar(<IconCpu />, "CPU", stat.cpu, `CPU ${stat.cpu}% · load ${stat.load}`)}
      {bar(<IconRam />, "RAM", memPct, `RAM ${human(stat.memUsed)} / ${human(stat.memTotal)}`)}
      {stat.diskTotal > 0 && bar(<IconDisk />, tr("Disk", "Đĩa"), diskPct, `Disk ${human(stat.diskUsed)} / ${human(stat.diskTotal)}`)}
      <span className="stat-item net" title={tr("Network up / down speed", "Tốc độ mạng lên / xuống")}>
        <span className="stat-val">↑{rate(stat.netTx)}</span>
        <span className="stat-val">↓{rate(stat.netRx)}</span>
      </span>
      {stat.uptime > 0 && (
        <span className="stat-item" title={tr("Server uptime", "Thời gian server đã chạy")}>
          <span className="stat-label"><IconClock /></span><span className="stat-val">{uptimeText(stat.uptime)}</span>
        </span>
      )}
    </div>
  );
}
