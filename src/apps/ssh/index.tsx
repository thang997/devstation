import type { AppModule, Tab } from "../types";
import { useWorkbench } from "../../store/workbench";

// Dữ liệu mẫu — sẽ thay bằng danh sách host trong SQLite, mật khẩu/key trong keyring.
const DEMO_HOSTS = [
  { id: "h1", name: "dev-01", host: "10.0.1.10", user: "ubuntu", env: "dev" },
  { id: "h2", name: "prod-01", host: "10.0.1.59", user: "deploy", env: "prod" },
];

function connect(h: (typeof DEMO_HOSTS)[number]) {
  const wb = useWorkbench.getState();
  wb.openTab({
    id: `ssh:${h.id}`,
    appId: "ssh",
    title: `🖥 ${h.name}`,
    payload: { ...h },
    danger: h.env === "prod",
  });
  wb.log(`ssh ${h.user}@${h.host} — chưa nối backend russh`);
}

function Sidebar() {
  return (
    <div className="side-list">
      <div className="side-head">
        <span>HOSTS</span>
        <button className="icon-btn" title="Thêm host">＋</button>
      </div>
      {DEMO_HOSTS.map((h) => (
        <div key={h.id} className="side-item" onDoubleClick={() => connect(h)}>
          <span className={`dot ${h.env === "prod" ? "red" : "green"}`} />
          <span className="grow">{h.name}</span>
          <span className="muted small">{h.user}@{h.host}</span>
        </div>
      ))}
      <div className="muted small pad">Double-click để kết nối</div>
      <div className="side-head"><span>SNIPPETS</span></div>
      <div className="side-item mono small">docker ps</div>
      <div className="side-item mono small">tail -f /var/log/syslog</div>
    </div>
  );
}

function TabView({ tab }: { tab: Tab }) {
  const h = tab.payload as (typeof DEMO_HOSTS)[number];
  return (
    <div className="view">
      <div className="toolbar">
        <span className="dot grey" /> {h.user}@{h.host}
        <span className="muted small">chưa kết nối</span>
        <span className="grow" />
        <button>SFTP</button>
        <button>Port forward</button>
        <button>⋮</button>
      </div>
      <div className="terminal">
        <div className="mono">Terminal (xterm.js) sẽ hiển thị ở đây.</div>
        <div className="mono muted">$ _</div>
      </div>
    </div>
  );
}

export const sshApp: AppModule = {
  id: "ssh",
  title: "SSH",
  icon: "🖥",
  Sidebar,
  TabView,
  commands: () =>
    DEMO_HOSTS.map((h) => ({
      id: `ssh.connect.${h.id}`,
      group: "SSH",
      title: `Kết nối: ${h.name}`,
      run: () => connect(h),
    })),
};
