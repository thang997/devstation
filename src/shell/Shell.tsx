import { useEffect, useState } from "react";
import { APPS, appById } from "../apps/registry";
import { useWorkbench } from "../store/workbench";
import { toggleTheme, useTheme } from "../store/theme";
import { toggleLang, useLang, useT } from "../store/lang";
import { AppHost } from "./AppHost";
import { Launcher } from "./Launcher";
import { ContextMenu, type CtxItem } from "./ContextMenu";
import { ConfirmHost } from "./confirm";
import { UpdateButton, UpdateHost, checkForUpdate } from "./updater";

/**
 * Mỗi mini app chiếm toàn bộ cửa sổ. Không có thanh chọn app cố định:
 * Ctrl+K mở launcher (danh sách app + tìm kiếm), Ctrl+1..9 vào thẳng app.
 * App chỉ được tải khi vào lần đầu; app đã vào được giữ trong DOM (ẩn) để không mất trạng thái.
 */
export function Shell() {
  const activeApp = useWorkbench((s) => s.activeApp);
  const mounted = useWorkbench((s) => s.mounted);
  const tabCount = useWorkbench((s) => (s.activeApp ? s.apps[s.activeApp].tabs.length : 0));
  const panelOpen = useWorkbench((s) => s.panelOpen);
  const launcherOpen = useWorkbench((s) => s.launcherOpen);
  const logs = useWorkbench((s) => s.logs);
  const theme = useTheme();
  const lang = useLang();
  const tr = useT();
  const { setLauncher, togglePanel, goHome, unloadApp } = useWorkbench.getState();
  /** Menu "các app đang chạy" ở thanh trạng thái. */
  const [runMenu, setRunMenu] = useState<{ x: number; y: number } | null>(null);

  // Kiểm tra bản mới 3s sau khi mở app (không chặn khởi động; lỗi mạng thì im lặng).
  useEffect(() => { const t = setTimeout(() => void checkForUpdate(), 3000); return () => clearTimeout(t); }, []);

  const closeAll = () => [...useWorkbench.getState().mounted].forEach((id) => useWorkbench.getState().unloadApp(id));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const s = useWorkbench.getState();
      const key = e.key.toLowerCase();
      // Dùng e.code để không phụ thuộc bố cục bàn phím / Unikey.
      const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
      if (mod && digit && !e.shiftKey && !e.altKey) {
        const app = APPS[Number(digit) - 1];
        if (app) { e.preventDefault(); s.openApp(app.id); }
      }
      else if (mod && key === "k") {
        e.preventDefault();
        // Ở màn hình chính launcher đã hiện sẵn.
        if (s.activeApp) s.setLauncher(!s.launcherOpen);
      }
      else if (mod && key === "b") { e.preventDefault(); s.toggleSidebar(); }
      else if (mod && e.key === "`") { e.preventDefault(); s.togglePanel(); }
      else if (mod && e.key === "Tab") { e.preventDefault(); s.cycleTab(e.shiftKey ? -1 : 1); }
      else if (mod && e.key === "PageDown") { e.preventDefault(); s.cycleTab(1); }
      else if (mod && e.key === "PageUp") { e.preventDefault(); s.cycleTab(-1); }
      else if (mod && e.shiftKey && key === "w" && s.activeApp) {
        // Ctrl+Shift+W: tắt hẳn app đang chạy (đóng mọi tab, giải phóng bộ nhớ).
        e.preventDefault();
        s.unloadApp(s.activeApp);
      }
      else if (mod && key === "w" && s.activeApp) {
        const tabId = s.apps[s.activeApp].activeTabId;
        if (tabId) { e.preventDefault(); s.closeTab(tabId); }
      }
      else if (e.key === "Escape" && s.launcherOpen) s.setLauncher(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const current = activeApp ? appById(activeApp) : null;

  return (
    <div className="shell">
      <div className="stage">
        <div className="apps">
          {mounted.map((id) => (
            <AppHost key={id} id={id} active={id === activeApp} />
          ))}
          {!activeApp && <Launcher inline />}
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

      <footer className="statusbar">
        <button title={tr("Home", "Về màn hình chính")} onClick={goHome}>🏠</button>
        <button title={tr("Switch app (Ctrl+K)", "Đổi app (Ctrl+K)")} onClick={() => (activeApp ? setLauncher(true) : goHome())}>
          {current ? <>{current.iconNode ?? current.icon} {current.title}</> : tr("Home", "Màn hình chính")} ▾
        </button>
        {current && (
          <button className="sb-close" title={tr("Close running app (Ctrl+Shift+W)", "Tắt app đang chạy (Ctrl+Shift+W)")} onClick={() => unloadApp(activeApp!)}>×</button>
        )}
        <span className="grow" />
        <UpdateButton />
        <button
          className="sb-running"
          disabled={!mounted.length}
          title={tr("Running apps — click to close", "Các app đang chạy — bấm để tắt")}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setRunMenu({ x: r.left, y: r.top - 4 });
          }}
        >
          {mounted.length}/{APPS.length} {tr("running", "app đang chạy")} ▴
        </button>
        {current && <span>{tabCount} tab</span>}
        <button className="sb-lang" title={tr("Switch to Vietnamese", "Chuyển sang tiếng Anh")} onClick={toggleLang}>
          {lang === "en" ? "EN" : "VI"}
        </button>
        <button
          className={`theme-btn ${theme === "dark" ? "sun" : "moon"}`}
          title={theme === "dark" ? tr("Light theme", "Chuyển sang nền sáng") : tr("Dark theme", "Chuyển sang nền tối")}
          onClick={toggleTheme}
          aria-label={tr("Toggle theme", "Đổi nền sáng/tối")}
        >
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
            <path
              d={theme === "dark"
                ? "M12 8a4 4 0 100 8 4 4 0 000-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"
                : "M20 14.5A8 8 0 019.5 4 7.2 7.2 0 1020 14.5z"}
              fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
            />
          </svg>
        </button>
        <button onClick={togglePanel}>Output {logs.length ? `(${logs.length})` : ""}</button>
      </footer>

      {runMenu && (
        <ContextMenu
          x={runMenu.x}
          y={runMenu.y}
          onClose={() => setRunMenu(null)}
          items={((): CtxItem[] => {
            const items: CtxItem[] = mounted.map((id) => {
              const a = appById(id);
              return {
                id,
                label: `${tr("Close", "Tắt")} ${a.icon} ${a.title}${id === activeApp ? tr(" (viewing)", " (đang xem)") : ""}`,
                danger: true,
                action: () => unloadApp(id),
              };
            });
            if (mounted.length > 1) {
              items.push({ id: "sep", sep: true }, { id: "all", label: tr("Close all apps", "Tắt tất cả app"), danger: true, action: closeAll });
            }
            if (!mounted.length) items.push({ id: "none", label: tr("No apps running", "Không có app nào đang chạy"), disabled: true });
            return items;
          })()}
        />
      )}

      {launcherOpen && activeApp && <Launcher />}
      <ConfirmHost />
      <UpdateHost />
    </div>
  );
}
