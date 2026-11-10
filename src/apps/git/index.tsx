import type { AppModule, Tab } from "../types";
import { useWorkbench } from "../../store/workbench";

// Dữ liệu mẫu — sẽ thay bằng danh sách repo lưu trong SQLite + status đọc qua git2.
const DEMO_REPOS = [
  { path: "D:/toolkit", name: "toolkit", branch: "main", ahead: 0, behind: 0, dirty: false },
  { path: "D:/hrm-ai", name: "hrm-ai", branch: "cursor", ahead: 2, behind: 1, dirty: true },
];

function openRepo(repo: (typeof DEMO_REPOS)[number]) {
  useWorkbench.getState().openTab({
    id: `git:${repo.path}`,
    appId: "git",
    title: `🌿 ${repo.name}`,
    payload: { ...repo },
  });
}

function Sidebar() {
  return (
    <div className="side-list">
      <div className="side-head">
        <span>REPOSITORIES</span>
        <button className="icon-btn" title="Mở thư mục / Clone">＋</button>
      </div>
      {DEMO_REPOS.map((r) => (
        <div key={r.path} className="side-item" onDoubleClick={() => openRepo(r)} onClick={() => openRepo(r)}>
          <span className="grow">
            {r.dirty && <span className="dot red" />} {r.name}
          </span>
          <span className="muted small">
            {r.branch} ↑{r.ahead}↓{r.behind}
          </span>
        </div>
      ))}
    </div>
  );
}

function TabView({ tab }: { tab: Tab }) {
  const log = useWorkbench((s) => s.log);
  const p = tab.payload as (typeof DEMO_REPOS)[number];
  const act = (name: string) => () => log(`git ${name} — ${p.name} (chưa nối backend)`);
  return (
    <div className="view">
      <div className="toolbar">
        <button>🌿 {p.branch} ▾</button>
        <span className="grow" />
        <button onClick={act("fetch")}>Fetch</button>
        <button onClick={act("pull")}>Pull ↓{p.behind}</button>
        <button className="primary" onClick={act("push")}>Push ↑{p.ahead}</button>
        <button onClick={act("stash")}>Stash</button>
      </div>
      <div className="split">
        <div className="pane narrow">
          <div className="pane-title">Changes</div>
          <div className="muted small pad">Staged (0)</div>
          <div className="muted small pad">Unstaged (0)</div>
          <textarea className="commit-msg" placeholder="Commit message" />
          <button className="primary block" onClick={act("commit")}>Commit</button>
        </div>
        <div className="pane">
          <div className="pane-title">Diff</div>
          <div className="empty">Chọn một file để xem diff (Monaco side-by-side)</div>
        </div>
      </div>
      <div className="pane history">
        <div className="pane-title">History</div>
        <div className="empty">Đồ thị commit + nhánh</div>
      </div>
    </div>
  );
}

export const gitApp: AppModule = {
  id: "git",
  title: "Git",
  icon: "🌿",
  Sidebar,
  TabView,
  commands: () =>
    DEMO_REPOS.map((r) => ({
      id: `git.open.${r.path}`,
      group: "Git",
      title: `Mở repo: ${r.name}`,
      run: () => openRepo(r),
    })),
};
