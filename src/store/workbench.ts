import { create } from "zustand";
import type { AppId, Tab } from "../apps/types";

/** Trạng thái riêng của từng mini app. */
export interface AppState {
  tabs: Tab[];
  activeTabId: string | null;
  sidebarOpen: boolean;
}

const emptyApp = (): AppState => ({ tabs: [], activeTabId: null, sidebarOpen: true });

interface WorkbenchState {
  activeApp: AppId;
  /** App đang được giữ trong DOM, xếp theo lần dùng gần nhất (cuối = mới nhất). */
  mounted: AppId[];
  apps: Record<AppId, AppState>;
  panelOpen: boolean;
  paletteOpen: boolean;
  /** Dòng log hiện ở panel dưới (output của pull/push, request, ssh...). */
  logs: string[];

  /** Chuyển sang app (Ctrl+1..9). Lần đầu sẽ tải code của app. */
  switchApp: (id: AppId) => void;
  /** Bấm icon trên activity bar: bấm lại app đang chọn thì gập/mở sidebar, giống VS Code. */
  clickApp: (id: AppId) => void;
  /** Gỡ app khỏi DOM để giải phóng bộ nhớ; mọi tab của app bị đóng. */
  unloadApp: (id: AppId) => void;
  toggleSidebar: () => void;
  togglePanel: () => void;
  setPalette: (open: boolean) => void;
  /** Mở tab trong app của nó (tự chuyển sang app đó); nếu đã có tab cùng id thì chỉ chuyển sang. */
  openTab: (tab: Tab) => void;
  closeTab: (id: string) => void;
  focusTab: (id: string) => void;
  /** Chuyển tab kế tiếp/trước đó trong app hiện tại (Ctrl+Tab). */
  cycleTab: (dir: 1 | -1) => void;
  log: (line: string) => void;
}

const touch = (mounted: AppId[], id: AppId) => [...mounted.filter((m) => m !== id), id];
const ownerOf = (apps: Record<AppId, AppState>, tabId: string) =>
  (Object.keys(apps) as AppId[]).find((a) => apps[a].tabs.some((t) => t.id === tabId));

export const useWorkbench = create<WorkbenchState>((set) => ({
  activeApp: "git",
  mounted: ["git"],
  apps: { git: emptyApp(), http: emptyApp(), ssh: emptyApp(), tools: emptyApp() },
  panelOpen: false,
  paletteOpen: false,
  logs: [],

  switchApp: (id) => set((s) => ({ activeApp: id, mounted: touch(s.mounted, id) })),
  clickApp: (id) =>
    set((s) =>
      s.activeApp === id
        ? { apps: { ...s.apps, [id]: { ...s.apps[id], sidebarOpen: !s.apps[id].sidebarOpen } } }
        : {
            activeApp: id,
            mounted: touch(s.mounted, id),
            apps: { ...s.apps, [id]: { ...s.apps[id], sidebarOpen: true } },
          },
    ),
  unloadApp: (id) =>
    set((s) => {
      const mounted = s.mounted.filter((m) => m !== id);
      // Đóng app đang xem → quay về app dùng gần nhất; nếu không còn app nào thì app này khởi động lại sạch.
      const activeApp = s.activeApp === id ? (mounted[mounted.length - 1] ?? id) : s.activeApp;
      return {
        activeApp,
        mounted: activeApp === id ? [id] : mounted,
        apps: { ...s.apps, [id]: emptyApp() },
      };
    }),
  toggleSidebar: () =>
    set((s) => {
      const a = s.apps[s.activeApp];
      return { apps: { ...s.apps, [s.activeApp]: { ...a, sidebarOpen: !a.sidebarOpen } } };
    }),
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
  setPalette: (open) => set({ paletteOpen: open }),

  openTab: (tab) =>
    set((s) => {
      const a = s.apps[tab.appId];
      const tabs = a.tabs.some((t) => t.id === tab.id) ? a.tabs : [...a.tabs, tab];
      return {
        activeApp: tab.appId,
        mounted: touch(s.mounted, tab.appId),
        apps: { ...s.apps, [tab.appId]: { ...a, tabs, activeTabId: tab.id } },
      };
    }),
  closeTab: (id) =>
    set((s) => {
      const appId = ownerOf(s.apps, id);
      if (!appId) return {};
      const a = s.apps[appId];
      const idx = a.tabs.findIndex((t) => t.id === id);
      const tabs = a.tabs.filter((t) => t.id !== id);
      // Đóng tab đang xem thì chuyển sang tab bên cạnh.
      const activeTabId =
        a.activeTabId === id ? (tabs[Math.min(idx, tabs.length - 1)]?.id ?? null) : a.activeTabId;
      return { apps: { ...s.apps, [appId]: { ...a, tabs, activeTabId } } };
    }),
  focusTab: (id) =>
    set((s) => {
      const appId = ownerOf(s.apps, id);
      if (!appId) return {};
      return {
        activeApp: appId,
        mounted: touch(s.mounted, appId),
        apps: { ...s.apps, [appId]: { ...s.apps[appId], activeTabId: id } },
      };
    }),
  cycleTab: (dir) =>
    set((s) => {
      const a = s.apps[s.activeApp];
      if (a.tabs.length < 2) return {};
      const idx = a.tabs.findIndex((t) => t.id === a.activeTabId);
      const next = a.tabs[(idx + dir + a.tabs.length) % a.tabs.length];
      return { apps: { ...s.apps, [s.activeApp]: { ...a, activeTabId: next.id } } };
    }),
  log: (line) =>
    set((s) => ({
      logs: [...s.logs.slice(-499), `[${new Date().toLocaleTimeString()}] ${line}`],
    })),
}));
