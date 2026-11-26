import { create } from "zustand";
import { git, errText, type Status } from "./api";

export interface Repo {
  /** Thư mục gốc (dấu `/`), dùng làm id. */
  path: string;
  name: string;
}

export interface Summary {
  branch: string | null;
  ahead: number;
  behind: number;
  changes: number;
  error?: string;
}

// Tạm lưu localStorage; khi có SQLite (giai đoạn 1) sẽ chuyển sang đó.
const KEY = "devstation.git.repos";
const load = (): Repo[] => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]");
  } catch {
    return [];
  }
};

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
export const repoName = (p: string) => norm(p).split("/").pop() || p;

interface RepoStore {
  repos: Repo[];
  summaries: Record<string, Summary>;
  add: (paths: string[]) => number;
  remove: (path: string) => void;
  setSummary: (path: string, s: Summary) => void;
}

export const useRepos = create<RepoStore>((set, get) => ({
  repos: load(),
  summaries: {},
  add: (paths) => {
    const have = new Set(get().repos.map((r) => r.path.toLowerCase()));
    const fresh = paths
      .map(norm)
      .filter((p) => !have.has(p.toLowerCase()))
      .map((path) => ({ path, name: repoName(path) }));
    const repos = [...get().repos, ...fresh].sort((a, b) => a.name.localeCompare(b.name));
    localStorage.setItem(KEY, JSON.stringify(repos));
    set({ repos });
    return fresh.length;
  },
  remove: (path) => {
    const repos = get().repos.filter((r) => r.path !== path);
    localStorage.setItem(KEY, JSON.stringify(repos));
    set({ repos });
  },
  setSummary: (path, s) => set((st) => ({ summaries: { ...st.summaries, [path]: s } })),
}));

/** Cập nhật tóm tắt từ một Status đã có (khỏi chạy lại git status). */
export function setSummaryFrom(path: string, s: Status) {
  useRepos.getState().setSummary(path, { branch: s.branch, ahead: s.ahead, behind: s.behind, changes: s.files.length });
}

/** Lượt tóm tắt đang chạy theo repo → gọi trùng (StrictMode, mở dropdown repo liên tục) dùng chung, không chạy thêm git status. */
const inflight = new Map<string, Promise<void>>();

export function refreshSummary(path: string): Promise<void> {
  const running = inflight.get(path);
  if (running) return running;
  const p = (async () => {
    try {
      setSummaryFrom(path, await git.status(path));
    } catch (e) {
      useRepos.getState().setSummary(path, { branch: null, ahead: 0, behind: 0, changes: 0, error: errText(e) });
    } finally {
      inflight.delete(path);
    }
  })();
  inflight.set(path, p);
  return p;
}

export const refreshAllSummaries = () => Promise.all(useRepos.getState().repos.map((r) => refreshSummary(r.path)));
