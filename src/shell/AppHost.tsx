import { Component, Suspense, use, type ReactNode } from "react";
import { appById, appShortcut, loadApp } from "../apps/registry";
import type { AppId } from "../apps/types";
import { useWorkbench } from "../store/workbench";

/**
 * Vỏ của một mini app: tự tải code khi mount lần đầu, có sidebar + thanh tab riêng,
 * và một error boundary để app này lỗi không kéo sập các app khác.
 */
export function AppHost({ id, active }: { id: AppId; active: boolean }) {
  const m = appById(id);
  return (
    <div className="app-host" hidden={!active}>
      <AppErrorBoundary title={m.title}>
        <Suspense fallback={<div className="empty">Đang tải {m.icon} {m.title}…</div>}>
          <AppFrame id={id} />
        </Suspense>
      </AppErrorBoundary>
    </div>
  );
}

function AppFrame({ id }: { id: AppId }) {
  const mod = use(loadApp(id));
  const app = useWorkbench((s) => s.apps[id]);
  const focusTab = useWorkbench((s) => s.focusTab);
  const closeTab = useWorkbench((s) => s.closeTab);
  const { Sidebar, TabView } = mod;

  return (
    <>
      {app.sidebarOpen && (
        <aside className="sidebar">
          <Sidebar />
        </aside>
      )}
      <main className="main">
        <div className="tabbar">
          {app.tabs.map((t) => (
            <div
              key={t.id}
              className={`tab ${t.id === app.activeTabId ? "on" : ""} ${t.danger ? "danger" : ""}`}
              onClick={() => focusTab(t.id)}
              onAuxClick={(e) => e.button === 1 && closeTab(t.id)}
            >
              <span className="ellipsis">{t.title}</span>
              <button className="x" onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}>×</button>
            </div>
          ))}
        </div>
        <section className="workspace">
          {/* Giữ mọi tab trong DOM, chỉ ẩn tab không active — để terminal SSH
              và form request không mất trạng thái khi chuyển tab. */}
          {app.tabs.map((t) => (
            <div key={t.id} className="tab-host" hidden={t.id !== app.activeTabId}>
              <TabView tab={t} />
            </div>
          ))}
          {!app.tabs.length && <AppWelcome id={id} />}
        </section>
      </main>
    </>
  );
}

function AppWelcome({ id }: { id: AppId }) {
  const m = appById(id);
  return (
    <div className="welcome">
      <h1>{m.icon} {m.title}</h1>
      <p className="muted">Chọn một mục ở sidebar để mở tab.</p>
      <ul className="keys">
        <li><kbd>Ctrl</kbd>+<kbd>1</kbd>…<kbd>9</kbd> Chuyển app (đang ở {appShortcut(id)})</li>
        <li><kbd>Ctrl</kbd>+<kbd>K</kbd> Tìm & chạy lệnh</li>
        <li><kbd>Ctrl</kbd>+<kbd>Tab</kbd> Chuyển tab trong app</li>
        <li><kbd>Ctrl</kbd>+<kbd>B</kbd> Ẩn/hiện sidebar</li>
        <li><kbd>Ctrl</kbd>+<kbd>`</kbd> Ẩn/hiện panel output</li>
        <li><kbd>Ctrl</kbd>+<kbd>W</kbd> Đóng tab</li>
      </ul>
    </div>
  );
}

class AppErrorBoundary extends Component<{ title: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="welcome">
        <div className="error-box">⚠ {this.props.title} gặp lỗi: {this.state.error.message}</div>
        <button onClick={() => this.setState({ error: null })}>Thử lại</button>
      </div>
    );
  }
}
