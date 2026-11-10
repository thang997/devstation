import { create } from "zustand";
import type { AppId, Tab } from "../apps/types";

interface WorkbenchState {
  activeApp: AppId;
  sidebarOpen: boolean;
  panelOpen: boolean;
  paletteOpen: boolean;
  tabs: Tab[];
  activeTabId: string | null;
  /** Dòng log hiện ở panel dưới (output của pull/push, request, ssh...). */
  logs: string[];

  setActiveApp: (id: AppId) => void;
  toggleSidebar: () => void;
  togglePanel: () => void;
  setPalette: (open: boolean) => void;
  /** Mở tab; nếu đã có tab cùng id thì chỉ chuyển sang. */
  openTab: (tab: Tab) => void;
  closeTab: (id: string) => void;
  focusTab: (id: string) => void;
  log: (line: string) => void;
}

export const useWorkbench = create<WorkbenchState>((set) => ({
  activeApp: "git",
  sidebarOpen: true,
  panelOpen: false,
  paletteOpen: false,
  tabs: [],
  activeTabId: null,
  logs: [],

  setActiveApp: (id) =>
    // Bấm lại app đang chọn thì gập/mở sidebar, giống VS Code.
    set((s) =>
      s.activeApp === id ? { sidebarOpen: !s.sidebarOpen } : { activeApp: id, sidebarOpen: true },
    ),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
  setPalette: (open) => set({ paletteOpen: open }),

  openTab: (tab) =>
    set((s) =>
      s.tabs.some((t) => t.id === tab.id)
        ? { activeTabId: tab.id }
        : { tabs: [...s.tabs, tab], activeTabId: tab.id },
    ),
  closeTab: (id) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      const tabs = s.tabs.filter((t) => t.id !== id);
      let activeTabId = s.activeTabId;
      if (activeTabId === id) {
        // Đóng tab đang xem thì chuyển sang tab bên cạnh.
        activeTabId = tabs[Math.min(idx, tabs.length - 1)]?.id ?? null;
      }
      return { tabs, activeTabId };
    }),
  focusTab: (id) => set({ activeTabId: id }),
  log: (line) =>
    set((s) => ({
      logs: [...s.logs.slice(-499), `[${new Date().toLocaleTimeString()}] ${line}`],
    })),
}));
