import { useEffect } from "react";
import { APPS, appById, appShortcut, loadApp } from "../apps/registry";
import { useWorkbench } from "../store/workbench";
import { AppHost } from "./AppHost";
import { CommandPalette } from "./CommandPalette";

/**
 * Bố cục: activity bar | mini app đang chọn (sidebar + tab riêng) / panel output / status bar.
 * App chỉ được tải khi mở lần đầu; app đã mở được giữ trong DOM (ẩn) để không mất trạng thái.
 */
export function Shell() {
  const activeApp = useWorkbench((s) => s.activeApp);
  const mounted = useWorkbench((s) => s.mounted);
  const sidebarOpen = useWorkbench((s) => s.apps[s.activeApp].sidebarOpen);
  const tabCount = useWorkbench((s) => s.apps[s.activeApp].tabs.length);
  const panelOpen = useWorkbench((s) => s.panelOpen);
  const paletteOpen = useWorkbench((s) => s.paletteOpen);
  const logs = useWorkbench((s) => s.logs);
  const { clickApp, setPalette, togglePanel } = useWorkbench.getState();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const s = useWorkbench.getState();
      const key = e.key.toLowerCase();
      // Dùng e.code để không phụ thuộc bố cục bàn phím / Unikey.
      const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
      if (mod && digit && !e.shiftKey && !e.altKey) {
        const app = APPS[Number(digit) - 1];
        if (app) { e.preventDefault(); s.switchApp(app.id); }
      }
      else if (mod && key === "k") { e.preventDefault(); s.setPalette(!s.paletteOpen); }
      else if (mod && key === "b") { e.preventDefault(); s.toggleSidebar(); }
      else if (mod && e.key === "`") { e.preventDefault(); s.togglePanel(); }
      else if (mod && e.key === "Tab") { e.preventDefault(); s.cycleTab(e.shiftKey ? -1 : 1); }
      else if (mod && e.key === "PageDown") { e.preventDefault(); s.cycleTab(1); }
      else if (mod && e.key === "PageUp") { e.preventDefault(); s.cycleTab(-1); }
      else if (mod && key === "w") {
        const tabId = s.apps[s.activeApp].activeTabId;
        if (tabId) { e.preventDefault(); s.closeTab(tabId); }
      }
      else if (e.key === "Escape" && s.paletteOpen) s.setPalette(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="shell">
      <div className="body">
        <nav className="activity">
          {APPS.map((a, i) => (
            <button
              key={a.id}
              title={`${a.title} (${appShortcut(a.id)})`}
              className={a.id === activeApp && sidebarOpen ? "on" : ""}
              onClick={() => clickApp(a.id)}
              // Rê chuột vào là tải trước code (chưa mount) để lúc bấm mở gần như tức thì.
              onMouseEnter={() => void loadApp(a.id).catch(() => {})}
            >
              {a.icon}
              <span className="key-hint">{i + 1}</span>
              {mounted.includes(a.id) && <span className="live-dot" />}
            </button>
          ))}
          <span className="grow" />
          <button title="Command palette (Ctrl+K)" onClick={() => setPalette(true)}>🔍</button>
          <button title="Cài đặt">⚙</button>
        </nav>

        <div className="stage">
          <div className="apps">
            {mounted.map((id) => (
              <AppHost key={id} id={id} active={id === activeApp} />
            ))}
          </div>

          {panelOpen && (
            <section className="panel">
              <div className="pane-title">
                OUTPUT <span className="grow" />
                <button className="icon-btn" onClick={togglePanel}>×</button>
              </div>
              <pre className="mono log">{logs.join("\n") || "Chưa có log."}</pre>
            </section>
          )}
        </div>
      </div>

      <footer className="statusbar">
        <span>{appById(activeApp).icon} {appById(activeApp).title}</span>
        <span>🗂 Workspace: Mặc định</span>
        <span className="grow" />
        <span title="Số app đang giữ trong bộ nhớ">{mounted.length}/{APPS.length} app đang mở</span>
        <span>{tabCount} tab</span>
        <button onClick={togglePanel}>Output {logs.length ? `(${logs.length})` : ""}</button>
      </footer>

      {paletteOpen && <CommandPalette />}
    </div>
  );
}
