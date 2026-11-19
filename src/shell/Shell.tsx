import { useEffect } from "react";
import { ChevronUp, SquareTerminal, X } from "lucide-react";
import { appById, orderedApps } from "../apps/registry";
import { useWorkbench } from "../store/workbench";
import { toggleTheme, useTheme } from "../store/theme";
import { toggleLang, useLang, useT, type TKey } from "../store/lang";
import { AppHost } from "./AppHost";
import { Launcher } from "./Launcher";
import { ConfirmHost } from "./confirm";
import { UpdateButton, UpdateHost, VersionLabel, checkForUpdate } from "./updater";
import { closeThisWindow, isMainWindow, launchApp, registerWindowApp, windowAppParam } from "./windows";

/**
 * Mỗi app một CỬA SỔ Windows riêng (xem shell/windows.ts) → chuyển qua lại bằng Alt+Tab.
 * Cửa sổ chính mở lên là màn hình chính (launcher); chọn app thì cửa sổ đó thành app.
 * Trong app: Ctrl+G / Ctrl+1..9 mở app khác (đã có cửa sổ thì đưa lên, chưa có thì mở cửa sổ mới).
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
  const { togglePanel, setLauncher } = useWorkbench.getState();

  // Kiểm tra bản mới 3s sau khi mở, rồi mỗi 30 phút — CHỈ ở cửa sổ chính (tránh mỗi cửa sổ tự tải một bản).
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    let iv: ReturnType<typeof setInterval> | undefined;
    void isMainWindow().then((main) => {
      if (!main) return;
      t = setTimeout(() => void checkForUpdate(), 3000);
      iv = setInterval(() => void checkForUpdate(), 30 * 60 * 1000);
    });
    return () => { clearTimeout(t); clearInterval(iv); };
  }, []);

  // Ghi nhận cửa sổ này đang chứa app nào (+ tiêu đề cửa sổ). Cửa sổ mở riêng cho một app mà app bị tắt → đóng cửa sổ.
  useEffect(() => {
    void registerWindowApp(activeApp);
    if (windowAppParam && !activeApp && !mounted.length) void closeThisWindow();
  }, [activeApp, mounted.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const s = useWorkbench.getState();
      const key = e.key.toLowerCase();
      // Dùng e.code để không phụ thuộc bố cục bàn phím / Unikey.
      const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
      if (mod && digit && !e.shiftKey && !e.altKey) {
        const app = orderedApps()[Number(digit) - 1];
        if (app) { e.preventDefault(); void launchApp(app.id); }
      }
      else if (mod && !e.shiftKey && !e.altKey && (e.code === "KeyG" || key === "g")) {
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
        // Ctrl+Shift+W: tắt hẳn app (đóng mọi tab; cửa sổ riêng của app thì đóng luôn cửa sổ).
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
              <button className="icon-btn" onClick={togglePanel}><X /></button>
            </div>
            <pre className="mono log">{logs.join("\n") || tr("shell.noLogsYet")}</pre>
          </section>
        )}
      </div>

      <footer className="statusbar">
        {current && (
          <button title={tr("shell.openAnotherAppWindow")} onClick={() => setLauncher(true)}>
            {current.iconNode ?? current.icon} {tr(`apps.${current.id}.title` as TKey)} <ChevronUp />
          </button>
        )}
        <span className="grow" />
        <UpdateButton />
        {current && <span>{tabCount} tab</span>}
        <button className="sb-lang" title={tr("shell.switchToVietnamese")} onClick={toggleLang}>
          {lang === "en" ? "EN" : "VI"}
        </button>
        <button
          className={`theme-btn ${theme === "dark" ? "sun" : "moon"}`}
          title={theme === "dark" ? tr("shell.lightTheme") : tr("shell.darkTheme")}
          onClick={toggleTheme}
          aria-label={tr("shell.toggleTheme")}
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
        <VersionLabel />
        <button onClick={togglePanel}><SquareTerminal />Output {logs.length ? `(${logs.length})` : ""}</button>
      </footer>

      {launcherOpen && activeApp && <Launcher />}
      <ConfirmHost />
      <UpdateHost />
    </div>
  );
}
