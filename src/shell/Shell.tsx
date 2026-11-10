import { useEffect } from "react";
import { APPS, appById } from "../apps/registry";
import { useWorkbench } from "../store/workbench";
import { CommandPalette } from "./CommandPalette";

/** Bố cục kiểu IDE: activity bar | sidebar | (tab bar + vùng làm việc + panel) / status bar. */
export function Shell() {
  const wb = useWorkbench();
  const activeTab = wb.tabs.find((t) => t.id === wb.activeTabId) ?? null;
  const SidebarView = appById(wb.activeApp).Sidebar;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const s = useWorkbench.getState();
      if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); s.setPalette(!s.paletteOpen); }
      else if (mod && e.key.toLowerCase() === "b") { e.preventDefault(); s.toggleSidebar(); }
      else if (mod && e.key === "`") { e.preventDefault(); s.togglePanel(); }
      else if (mod && e.key.toLowerCase() === "w" && s.activeTabId) { e.preventDefault(); s.closeTab(s.activeTabId); }
      else if (e.key === "Escape" && s.paletteOpen) s.setPalette(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="shell">
      <div className="body">
        <nav className="activity">
          {APPS.map((a) => (
            <button
              key={a.id}
              title={a.title}
              className={a.id === wb.activeApp && wb.sidebarOpen ? "on" : ""}
              onClick={() => wb.setActiveApp(a.id)}
            >
              {a.icon}
            </button>
          ))}
          <span className="grow" />
          <button title="Command palette (Ctrl+K)" onClick={() => wb.setPalette(true)}>🔍</button>
          <button title="Cài đặt">⚙</button>
        </nav>

        {wb.sidebarOpen && (
          <aside className="sidebar">
            <SidebarView />
          </aside>
        )}

        <main className="main">
          <div className="tabbar">
            {wb.tabs.map((t) => (
              <div
                key={t.id}
                className={`tab ${t.id === wb.activeTabId ? "on" : ""} ${t.danger ? "danger" : ""}`}
                onClick={() => wb.focusTab(t.id)}
                onAuxClick={(e) => e.button === 1 && wb.closeTab(t.id)}
              >
                <span className="ellipsis">{t.title}</span>
                <button className="x" onClick={(e) => { e.stopPropagation(); wb.closeTab(t.id); }}>×</button>
              </div>
            ))}
          </div>

          <section className="workspace">
            {/* Giữ mọi tab trong DOM, chỉ ẩn tab không active — để terminal SSH
                và form request không mất trạng thái khi chuyển tab. */}
            {wb.tabs.map((t) => {
              const View = appById(t.appId).TabView;
              return (
                <div key={t.id} className="tab-host" hidden={t.id !== wb.activeTabId}>
                  <View tab={t} />
                </div>
              );
            })}
            {!activeTab && <Welcome />}
          </section>

          {wb.panelOpen && (
            <section className="panel">
              <div className="pane-title">
                OUTPUT <span className="grow" />
                <button className="icon-btn" onClick={wb.togglePanel}>×</button>
              </div>
              <pre className="mono log">{wb.logs.join("\n") || "Chưa có log."}</pre>
            </section>
          )}
        </main>
      </div>

      <footer className="statusbar">
        <span>🗂 Workspace: Mặc định</span>
        <span className="grow" />
        <span>{wb.tabs.length} tab</span>
        <button onClick={wb.togglePanel}>Output {wb.logs.length ? `(${wb.logs.length})` : ""}</button>
      </footer>

      {wb.paletteOpen && <CommandPalette />}
    </div>
  );
}

function Welcome() {
  return (
    <div className="welcome">
      <h1>DevStation</h1>
      <p className="muted">Git · HTTP · SSH · Tiện ích — trong một cửa sổ.</p>
      <ul className="keys">
        <li><kbd>Ctrl</kbd>+<kbd>K</kbd> Tìm & chạy lệnh</li>
        <li><kbd>Ctrl</kbd>+<kbd>B</kbd> Ẩn/hiện sidebar</li>
        <li><kbd>Ctrl</kbd>+<kbd>`</kbd> Ẩn/hiện panel output</li>
        <li><kbd>Ctrl</kbd>+<kbd>W</kbd> Đóng tab</li>
      </ul>
    </div>
  );
}
