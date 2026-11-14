import { create } from "zustand";
import { git, errText } from "./api";

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

export async function refreshSummary(path: string) {
  try {
    const s = await git.status(path);
    useRepos.getState().setSummary(path, { branch: s.branch, ahead: s.ahead, behind: s.behind, changes: s.files.length });
  } catch (e) {
    useRepos.getState().setSummary(path, { branch: null, ahead: 0, behind: 0, changes: 0, error: errText(e) });
  }
}

export const refreshAllSummaries = () => Promise.all(useRepos.getState().repos.map((r) => refreshSummary(r.path)));
