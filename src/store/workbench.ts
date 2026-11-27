import { create } from "zustand";
import type { AppId, Tab } from "../apps/types";

/** Trạng thái riêng của từng mini app (dùng bởi TabbedLayout). */
export interface AppState {
  tabs: Tab[];
  activeTabId: string | null;
  sidebarOpen: boolean;
}

/**
 * Nhớ trạng thái ẩn/hiện sidebar của từng app giữa các lần mở.
 * Git mặc định thu gọn để tiết kiệm chỗ; app khác mở sẵn. (Test chạy trong Node không có localStorage.)
 */
const SIDEBAR_KEY = "devstation.sidebar";
const readSidebar = (): Partial<Record<AppId, boolean>> => {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(SIDEBAR_KEY) ?? "{}");
  } catch {
    return {};
  }
};
const saveSidebar = (id: AppId, open: boolean) => {
  try {
    globalThis.localStorage?.setItem(SIDEBAR_KEY, JSON.stringify({ ...readSidebar(), [id]: open }));
  } catch {
    /* riêng tư / hết chỗ — không sao, chỉ mất ghi nhớ */
  }
};

const emptyApp = (sidebarOpen = true): AppState => ({ tabs: [], activeTabId: null, sidebarOpen });
const freshApp = (id: AppId) => emptyApp(readSidebar()[id] ?? id !== "git");

interface WorkbenchState {
  /** App đang hiển thị; null = màn hình chính (launcher). */
  activeApp: AppId | null;
  /** App đang được giữ trong DOM, xếp theo lần dùng gần nhất (cuối = mới nhất). */
  mounted: AppId[];
  apps: Record<AppId, AppState>;
  panelOpen: boolean;
  /** Launcher dạng overlay (Ctrl+G) khi đang ở trong một app. */
  launcherOpen: boolean;
  /** Dòng log hiện ở panel dưới (output của pull/push, request, ssh...). */
  logs: string[];

  /** Vào app (Ctrl+1..9 hoặc chọn trong launcher). Lần đầu sẽ tải code của app. */
  openApp: (id: AppId) => void;
  /** Về màn hình chính; các app đã mở vẫn chạy nền. */
  goHome: () => void;
  /** Gỡ app khỏi DOM để giải phóng bộ nhớ; mọi tab của app bị đóng. */
  unloadApp: (id: AppId) => void;
  toggleSidebar: () => void;
  /** Đặt trạng thái sidebar của một app (dùng khi vào/ra phiên làm việc). */
  setSidebar: (id: AppId, open: boolean) => void;
  togglePanel: () => void;
  setLauncher: (open: boolean) => void;
  /** Mở tab trong app của nó (tự chuyển sang app đó); nếu đã có tab cùng id thì chỉ chuyển sang. */
  openTab: (tab: Tab) => void;
  closeTab: (id: string) => void;
  /** Đổi tiêu đề / payload / cờ của tab (vd. Editor thêm dấu "●" khi chưa lưu, đổi tên sau "Lưu thành"). */
  updateTab: (id: string, patch: Partial<Pick<Tab, "title" | "payload" | "danger">>) => void;
  /** Đóng mọi tab khác trong cùng app, giữ lại tab `id`. */
  closeOtherTabs: (id: string) => void;
  /** Đóng toàn bộ tab của một app. */
  closeAllTabs: (appId: AppId) => void;
  focusTab: (id: string) => void;
  /** Chuyển tab kế tiếp/trước đó trong app hiện tại (Ctrl+Tab). */
  cycleTab: (dir: 1 | -1) => void;
  log: (line: string) => void;
}

/** Thứ tự tab app ổn định như trình duyệt: app mới thêm vào cuối, app đã mở giữ nguyên chỗ. */
const touch = (mounted: AppId[], id: AppId) => (mounted.includes(id) ? mounted : [...mounted, id]);
const ownerOf = (apps: Record<AppId, AppState>, tabId: string) =>
  (Object.keys(apps) as AppId[]).find((a) => apps[a].tabs.some((t) => t.id === tabId));

export const useWorkbench = create<WorkbenchState>((set) => ({
  activeApp: null,
  mounted: [],
  apps: { git: freshApp("git"), http: freshApp("http"), ssh: freshApp("ssh"), tools: freshApp("tools"), db: freshApp("db"), redis: freshApp("redis"), registry: freshApp("registry"), translate: freshApp("translate"), pdf: freshApp("pdf"), editor: freshApp("editor") },
  panelOpen: false,
  launcherOpen: false,
  logs: [],

  openApp: (id) => set((s) => ({ activeApp: id, mounted: touch(s.mounted, id), launcherOpen: false })),
  goHome: () => set({ activeApp: null, launcherOpen: false }),
  unloadApp: (id) =>
    set((s) => {
      const idx = s.mounted.indexOf(id);
      const mounted = s.mounted.filter((m) => m !== id);
      // Đóng tab app đang xem → sang tab bên phải (hết thì bên trái), không còn app thì về màn hình chính.
      const activeApp = s.activeApp === id ? (mounted[idx] ?? mounted[idx - 1] ?? null) : s.activeApp;
      return { activeApp, mounted, apps: { ...s.apps, [id]: freshApp(id) } };
    }),
  toggleSidebar: () =>
    set((s) => {
      if (!s.activeApp) return {};
      const a = s.apps[s.activeApp];
      const open = !a.sidebarOpen;
      saveSidebar(s.activeApp, open);
      return { apps: { ...s.apps, [s.activeApp]: { ...a, sidebarOpen: open } } };
    }),
  setSidebar: (id, open) =>
    set((s) => {
      const a = s.apps[id];
      if (!a) return {};
      saveSidebar(id, open);
      return { apps: { ...s.apps, [id]: { ...a, sidebarOpen: open } } };
    }),
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
  setLauncher: (open) => set({ launcherOpen: open }),

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
  updateTab: (id, patch) =>
    set((s) => {
      const appId = ownerOf(s.apps, id);
      if (!appId) return {};
      const a = s.apps[appId];
      return { apps: { ...s.apps, [appId]: { ...a, tabs: a.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) } } };
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
  closeOtherTabs: (id) =>
    set((s) => {
      const appId = ownerOf(s.apps, id);
      if (!appId) return {};
      const a = s.apps[appId];
      const tabs = a.tabs.filter((t) => t.id === id);
      return { apps: { ...s.apps, [appId]: { ...a, tabs, activeTabId: id } } };
    }),
  closeAllTabs: (appId) =>
    set((s) => ({ apps: { ...s.apps, [appId]: { ...s.apps[appId], tabs: [], activeTabId: null } } })),
  cycleTab: (dir) =>
    set((s) => {
      if (!s.activeApp) return {};
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

/* ── Hỏi trước khi đóng tab ──
 * App đăng ký hàm hỏi (vd. Editor: tab chưa lưu → Lưu / Không lưu / Huỷ). Thao tác đóng của NGƯỜI DÙNG (nút X, Ctrl+W,
 * chuột giữa, menu Close / Close others / Close all) đi qua `requestCloseTabs`; đóng do code (mở lại tab…) vẫn gọi
 * thẳng `closeTab`. Tắt cả app / cửa sổ KHÔNG hỏi (Editor giữ bản nháp cho lần mở sau). */
type CloseGuard = (tabIds: string[]) => Promise<string[]>;
const closeGuards = new Map<AppId, CloseGuard>();

/** Guard trả về danh sách tab ĐƯỢC đóng (bỏ những tab người dùng chọn Huỷ). `null` = gỡ guard. */
export function setCloseGuard(appId: AppId, guard: CloseGuard | null) {
  if (guard) closeGuards.set(appId, guard);
  else closeGuards.delete(appId);
}

export async function requestCloseTabs(ids: string[]) {
  const s = useWorkbench.getState();
  const byApp = new Map<AppId, string[]>();
  for (const id of ids) {
    const appId = ownerOf(s.apps, id);
    if (appId) byApp.set(appId, [...(byApp.get(appId) ?? []), id]);
  }
  for (const [appId, list] of byApp) {
    const guard = closeGuards.get(appId);
    const ok = guard ? await guard(list) : list;
    for (const id of ok) useWorkbench.getState().closeTab(id);
  }
}
