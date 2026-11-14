import { useState, type ComponentType, type ReactNode } from "react";
import type { AppId, Tab } from "../apps/types";
import { useWorkbench } from "../store/workbench";
import { Splitter, useSplitSize } from "./Resizable";
import { ContextMenu, type CtxItem } from "./ContextMenu";
import { useT } from "../store/lang";

const SIDEBAR_DEFAULT = 260;
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 520;

/**
 * Bố cục dựng sẵn cho app: (sidebar tuỳ chọn) | thanh tab + nội dung tab.
 * App không bắt buộc dùng — app nào cần giao diện khác thì tự vẽ trong `View`.
 */
export function TabbedLayout({
  appId,
  Sidebar,
  TabView,
  empty,
}: {
  appId: AppId;
  Sidebar?: ComponentType;
  TabView: ComponentType<{ tab: Tab }>;
  /** Hiện khi app chưa có tab nào. */
  empty?: ReactNode;
}) {
  const tr = useT();
  const app = useWorkbench((s) => s.apps[appId]);
  const focusTab = useWorkbench((s) => s.focusTab);
  const closeTab = useWorkbench((s) => s.closeTab);
  const closeOtherTabs = useWorkbench((s) => s.closeOtherTabs);
  const closeAllTabs = useWorkbench((s) => s.closeAllTabs);
  const openTab = useWorkbench((s) => s.openTab);
  const toggleSidebar = useWorkbench((s) => s.toggleSidebar);
  const [sidebarW, setSidebarW] = useSplitSize("sidebar", SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_MAX);
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; tab: Tab } | null>(null);

  /** Nhân đôi một tab: clone payload + title, id mới (cho phép nhiều tab cùng nguồn). */
  const duplicateTab = (t: Tab) => {
    const uid = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    openTab({ ...t, id: `${t.id}~${uid}` });
  };
  const tabMenuItems = (t: Tab): CtxItem[] => [
    { id: "dup", icon: "⧉", label: tr("Duplicate", "Nhân đôi"), action: () => duplicateTab(t) },
    { id: "s1", sep: true },
    { id: "close", icon: "✕", label: tr("Close tab", "Đóng tab"), action: () => closeTab(t.id) },
    { id: "others", icon: "⊘", label: tr("Close others", "Đóng tab khác"), disabled: app.tabs.length < 2, action: () => closeOtherTabs(t.id) },
    { id: "all", icon: "⨉", label: tr("Close all", "Đóng tất cả"), danger: true, action: () => closeAllTabs(appId) },
  ];

  return (
    <div className="tabbed">
      {Sidebar && app.sidebarOpen && (
        <>
          <aside className="sidebar" style={{ width: sidebarW, flex: "0 0 auto" }}>
            <Sidebar />
          </aside>
          <Splitter axis="x" onResize={(d) => setSidebarW((w) => w + d)} onReset={() => setSidebarW(SIDEBAR_DEFAULT)} />
        </>
      )}
      <main className="main">
        <div className="tabbar">
          {Sidebar && (
            <button
              className={`side-toggle ${app.sidebarOpen ? "on" : ""}`}
              title={`${app.sidebarOpen ? "Ẩn" : "Hiện"} danh sách (Ctrl+B)`}
              onClick={toggleSidebar}
            >
              ☰
            </button>
          )}
          {app.tabs.map((t) => (
            <div
              key={t.id}
              className={`tab ${t.id === app.activeTabId ? "on" : ""} ${t.danger ? "danger" : ""}`}
              onClick={() => focusTab(t.id)}
              onAuxClick={(e) => e.button === 1 && closeTab(t.id)}
              onContextMenu={(e) => { e.preventDefault(); setTabMenu({ x: e.clientX, y: e.clientY, tab: t }); }}
            >
              <span className="ellipsis">{t.title}</span>
              <button className="x" onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}>×</button>
            </div>
          ))}
        </div>
        {tabMenu && <ContextMenu x={tabMenu.x} y={tabMenu.y} items={tabMenuItems(tabMenu.tab)} onClose={() => setTabMenu(null)} />}
        <section className="workspace">
          {/* Giữ mọi tab trong DOM, chỉ ẩn tab không active — để terminal SSH
              và form request không mất trạng thái khi chuyển tab. */}
          {app.tabs.map((t) => (
            <div key={t.id} className="tab-host" hidden={t.id !== app.activeTabId}>
              <TabView tab={t} />
            </div>
          ))}
          {!app.tabs.length && (empty ?? <div className="empty">Chọn một mục ở sidebar để mở tab.</div>)}
        </section>
      </main>
    </div>
  );
}
