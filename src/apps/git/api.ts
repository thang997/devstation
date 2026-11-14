import { invoke, isTauri } from "@tauri-apps/api/core";

export interface FileChange {
  path: string;
  orig: string | null;
  /** Trạng thái trong index (staged): M A D R C T U hoặc '.' */
  x: string;
  /** Trạng thái trong working tree. */
  y: string;
  kind: "changed" | "renamed" | "conflict" | "untracked";
}

export interface Status {
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: FileChange[];
  conflicted: boolean;
}

export interface Commit {
  hash: string;
  short: string;
  author: string;
  time: number;
  refs: string;
  subject: string;
}

export interface Branch {
  name: string;
  remote: boolean;
  upstream: string;
  current: boolean;
  /** Thời điểm commit gần nhất (unix giây). */
  time: number;
  /** Tiêu đề commit gần nhất. */
  subject: string;
}

export type RemoteOp = "fetch" | "pull" | "push" | "push-upstream";

function call<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  if (!isTauri()) return Promise.reject(new Error("Cần chạy trong app (npm run app:dev) — trình duyệt không gọi được git."));
  return invoke<T>(cmd, args);
}

export const git = {
  status: (path: string) => call<Status>("git_status", { path }),
  root: (path: string) => call<string>("git_root", { path }),
  findRepos: (dir: string) => call<string[]>("git_find_repos", { dir }),
  diff: (path: string, file: string, staged: boolean, untracked: boolean) =>
    call<string>("git_diff", { path, file, staged, untracked }),
  fileDiff: (path: string, file: string, untracked: boolean) =>
    call<string>("git_file_diff", { path, file, untracked }),
  log: (path: string, limit = 200) => call<Commit[]>("git_log", { path, limit }),
  show: (path: string, hash: string) => call<string>("git_show", { path, hash }),
  undoCommit: (path: string) => call<string>("git_undo_commit", { path }),
  commitMessage: (path: string, hash: string) => call<string>("git_commit_message", { path, hash }),
  rewordHead: (path: string, message: string) => call<string>("git_reword_head", { path, message }),
  revert: (path: string, hash: string) => call<string>("git_revert", { path, hash }),
  resetTo: (path: string, hash: string, hard: boolean) => call<void>("git_reset_to", { path, hash, hard }),
  checkoutCommit: (path: string, hash: string) => call<void>("git_checkout_commit", { path, hash }),
  branchAt: (path: string, name: string, hash: string) => call<void>("git_branch_at", { path, name, hash }),
  openCommitRemote: (path: string, hash: string) => call<void>("git_open_commit_remote", { path, hash }),
  headPushed: (path: string) => call<boolean>("git_head_pushed", { path }),
  branches: (path: string) => call<Branch[]>("git_branches", { path }),
  stage: (path: string, files: string[]) => call<void>("git_stage", { path, files }),
  unstage: (path: string, files: string[]) => call<void>("git_unstage", { path, files }),
  discard: (path: string, tracked: string[], untracked: string[]) =>
    call<void>("git_discard", { path, tracked, untracked }),
  discardAll: (path: string) => call<void>("git_discard_all", { path }),
  commit: (path: string, message: string) => call<string>("git_commit", { path, message }),
  switchBranch: (path: string, branch: string, create = false, track = false) =>
    call<void>("git_switch", { path, branch, create, track }),
  switchBringChanges: (path: string, branch: string, create = false, track = false) =>
    call<string>("git_switch_bring", { path, branch, create, track }),
  merge: (path: string, branch: string) => call<string>("git_merge", { path, branch }),
  renameBranch: (path: string, old: string, name: string) => call<void>("git_rename_branch", { path, old, new: name }),
  deleteBranch: (path: string, name: string, remote: boolean, force: boolean) =>
    call<string>("git_delete_branch", { path, name, remote, force }),
  stash: (path: string, pop: boolean) => call<string>("git_stash", { path, pop }),
  ignore: (path: string, file: string, scope: string, untrack: boolean) =>
    call<string>("git_ignore", { path, file, scope, untrack }),
  reveal: (path: string, file?: string) => call<void>("git_reveal", { path, file: file ?? null }),
  remote: (path: string, op: RemoteOp, job: string) => call<string>("git_remote", { path, op, job }),
  clone: (url: string, parent: string, folder: string, job: string) =>
    call<string>("git_clone", { url, parent, folder, job }),
  identity: () => call<Identity>("git_identity", {}),
  setIdentity: (name: string, email: string) => call<void>("git_set_identity", { name, email }),
  enableManager: () => call<void>("git_enable_manager", {}),
  storeCredential: (host: string, username: string, token: string) =>
    call<string>("git_store_credential", { host, username, token }),
  account: (host: string) => call<GitAccount>("git_account", { host }),
  signOut: (host: string, username: string) => call<void>("git_sign_out", { host, username }),
};

export interface GitAccount {
  host: string;
  signedIn: boolean;
  username: string | null;
  /** Login GitHub (nếu xác minh được). */
  login: string | null;
  /** Tên hiển thị trên GitHub. */
  name: string | null;
  /** Ghi chú khi đã lưu nhưng chưa xác minh được. */
  note: string | null;
}

export interface Identity {
  name: string;
  email: string;
  /** credential.helper toàn cục; rỗng = mật khẩu sẽ không được nhớ. */
  helper: string;
}

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
