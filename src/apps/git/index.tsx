import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { AppModule, Tab } from "../types";
import { useWorkbench } from "../../store/workbench";
import { getLang, t, useT, rich } from "../../store/lang";
import { TabbedLayout } from "../../shell/TabbedLayout";
import { Picker } from "../../shell/Picker";
import { ContextMenu, type CtxItem } from "../../shell/ContextMenu";
import { Modal } from "../../shell/Modal";
import { Splitter, useSplitSize } from "../../shell/Resizable";
import { git, errText, type Branch, type Commit, type FileChange, type GitAccount, type RemoteOp, type Status } from "./api";
import { refreshAllSummaries, refreshSummary, repoName, useRepos, type Repo } from "./repos";

function openRepo(r: Repo) {
  useWorkbench.getState().openTab({ id: `git:${r.path}`, appId: "git", title: `🌿 ${r.name}`, payload: { path: r.path } });
}

/** Chọn thư mục: là repo thì thêm luôn, không phải thì quét các repo con bên trong. */
async function addRepos(): Promise<string> {
  const dir = await openDialog({ directory: true, title: t("git.pickARepoOrAFolder") });
  if (typeof dir !== "string") return "";
  let paths: string[];
  try {
    paths = [await git.root(dir)];
  } catch {
    paths = await git.findRepos(dir);
  }
  if (!paths.length) return t("git.noGitRepoFoundInThis");
  const n = useRepos.getState().add(paths);
  void refreshAllSummaries();
  if (paths.length === 1 && n === 1) openRepo({ path: paths[0], name: repoName(paths[0]) });
  return n ? "" : t("git.theseReposAreAlreadyInThe");
}

/* Các thao tác cần nhập thêm (tài khoản, clone) mở dạng MODAL, không phải tab.
   Mỗi cái một cờ nhỏ dùng chung cho mọi nơi gọi (sidebar, màn trống, lệnh Ctrl+K). */
function makeToggle() {
  let open = false;
  const subs = new Set<() => void>();
  return {
    open: () => { open = true; subs.forEach((f) => f()); },
    close: () => { open = false; subs.forEach((f) => f()); },
    use: () => useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => open),
  };
}
const accountModal = makeToggle();
const cloneModal = makeToggle();
const openAccount = accountModal.open;
const closeAccount = accountModal.close;
const useAccountOpen = accountModal.use;
const openClone = cloneModal.open;
const closeClone = cloneModal.close;
const useCloneOpen = cloneModal.use;

/* ── Repo switcher (dropdown kiểu GitHub Desktop) ── */

/** Nút "Current Repository ▾": chọn repo, thêm, clone, tài khoản — thay cho sidebar cũ. */
function RepoSwitcher({ currentPath }: { currentPath: string | null }) {
  const tr = useT();
  const repos = useRepos((s) => s.repos);
  const summaries = useRepos((s) => s.summaries);
  const current = repos.find((r) => r.path === currentPath);

  useEffect(() => { void refreshAllSummaries(); }, []);

  return (
    <Picker
      title={tr("git.switchAddRepository")}
      filterPlaceholder={tr("git.filterRepository")}
      label={<><span className="branch-glyph">▤</span> {current?.name ?? tr("git.pickRepository")}</>}
      items={[
        ...repos.map((r) => {
          const s = summaries[r.path];
          const hint = s?.error
            ? tr("git.error")
            : s
              ? `${s.branch ?? "detached"}${s.ahead ? ` ↑${s.ahead}` : ""}${s.behind ? ` ↓${s.behind}` : ""}${s.changes ? ` •${s.changes}` : ""}`
              : undefined;
          return { id: r.path, label: r.name, group: "Repository", icon: "▤", hint, selected: r.path === currentPath, removable: true };
        }),
        { id: "\u0000add", label: tr("git.addExistingRepo"), group: tr("git.actions"), icon: "＋" },
        { id: "\u0000clone", label: tr("git.cloneFromUrl"), group: tr("git.actions"), icon: "⬇" },
        { id: "\u0000account", label: tr("git.gitAccount"), group: tr("git.actions"), icon: "⚙" },
      ]}
      onPick={(id) => {
        if (id === "\u0000add") return void addRepos().catch(() => {});
        if (id === "\u0000clone") return openClone();
        if (id === "\u0000account") return openAccount();
        const r = repos.find((x) => x.path === id);
        if (r) openRepo(r);
      }}
      onRemove={(id) => {
        useRepos.getState().remove(id);
        useWorkbench.getState().closeTab(`git:${id}`);
      }}
    />
  );
}

/* ── Một repo ──────────────────────────────────── */

type Selected = { type: "file"; file: FileChange; staged: boolean } | { type: "commit"; commit: Commit } | null;

/** Thao tác với một commit từ menu chuột phải trong Lịch sử (giống GitHub Desktop). */
type CommitAction =
  | { kind: "reword"; c: Commit; draft: string }
  | { kind: "branch"; c: Commit; name: string }
  | { kind: "revert"; c: Commit }
  | { kind: "reset"; c: Commit }
  | { kind: "checkout"; c: Commit };

/** Một lần chuyển nhánh đã tính sẵn (branch + cờ create/track) để có thể thử lại kèm mang theo thay đổi. */
type SwitchTarget = { branch: string; create: boolean; track: boolean; label: string };

/** Thao tác với một nhánh từ menu chuột phải (đổi tên / xoá). */
type BranchAction =
  | { kind: "rename"; b: Branch; name: string }
  | { kind: "delete"; b: Branch; force: boolean };

/** Phạm vi bỏ qua khi thêm vào .gitignore. */
type IgnoreScope = "file" | "parent" | "ext";

/** Mẫu .gitignore khớp với lệnh Rust `git_ignore` (cùng quy tắc). */
function ignorePattern(p: string, scope: IgnoreScope) {
  if (scope === "ext") {
    const ext = p.includes(".") ? p.split(".").pop()! : "";
    return ext ? `*.${ext}` : "";
  }
  if (scope === "parent") {
    const i = p.lastIndexOf("/");
    return i < 0 ? "" : `/${p.slice(0, i)}/`;
  }
  return `/${p}`;
}

let jobSeq = 0;

function RepoView({ tab }: { tab: Tab }) {
  const tr = useT();
  const path = String(tab.payload.path);
  const log = useWorkbench((s) => s.log);
  const [status, setStatus] = useState<Status | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [history, setHistory] = useState<Commit[]>([]);
  const [selected, setSelected] = useState<Selected>(null);
  const [diff, setDiff] = useState("");
  const [message, setMessage] = useState("");
  /** Commit cuối đã push → không cho bỏ commit (phải force push mới đẩy được). */
  const [headPushed, setHeadPushed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState<FileChange[] | null>(null);
  /** Xác nhận bỏ TẤT CẢ thay đổi (reset --hard + clean). */
  const [confirmDiscardAll, setConfirmDiscardAll] = useState(false);
  const [confirmUndo, setConfirmUndo] = useState<Commit | null>(null);
  /** Kiểu GitHub Desktop: các file người dùng BỎ tick (không commit). File không nằm đây = có tick. */
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  /** Bề rộng cột Thay đổi và chiều cao khung Lịch sử — kéo được, nhớ lại. */
  const [changesW, setChangesW] = useSplitSize("git.changes", 280, 200, 600);
  const [historyH, setHistoryH] = useSplitSize("git.history", 200, 80, 560);
  /** Menu chuột phải trên một file. */
  const [menu, setMenu] = useState<{ file: FileChange; staged: boolean; x: number; y: number } | null>(null);
  /** Bỏ qua file đang được theo dõi: cần hỏi lại vì phải bỏ track. */
  const [confirmIgnore, setConfirmIgnore] = useState<{ file: FileChange; scope: IgnoreScope; pattern: string } | null>(null);
  const [newBranch, setNewBranch] = useState<string | null>(null);
  /** Mở modal chọn nhánh để merge vào nhánh hiện tại. */
  const [mergeOpen, setMergeOpen] = useState(false);
  /** Menu chuột phải trên một commit trong Lịch sử. */
  const [commitMenu, setCommitMenu] = useState<{ c: Commit; x: number; y: number } | null>(null);
  /** Hộp xác nhận / nhập liệu cho thao tác với commit (revert, reset, tạo nhánh, sửa message…). */
  const [commitAction, setCommitAction] = useState<CommitAction | null>(null);
  /** Menu chuột phải trên một nhánh (trong dropdown đổi nhánh). */
  const [branchMenu, setBranchMenu] = useState<{ b: Branch; x: number; y: number } | null>(null);
  /** Hộp đổi tên / xoá nhánh. */
  const [branchAction, setBranchAction] = useState<BranchAction | null>(null);
  /** Hàm đóng dropdown nhánh (để đóng khi đã chọn thao tác từ menu chuột phải). */
  const closeBranchPicker = useRef<(() => void) | null>(null);
  /** Chuyển nhánh bị chặn do còn thay đổi chưa commit → hỏi có mang theo không. */
  const [switchDirty, setSwitchDirty] = useState<SwitchTarget | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, b, h, pushed] = await Promise.all([git.status(path), git.branches(path), git.log(path), git.headPushed(path)]);
      setStatus(s);
      setBranches(b);
      setHistory(h);
      setHeadPushed(pushed);
      void refreshSummary(path);
    } catch (e) {
      setError(errText(e));
    }
  }, [path]);

  useEffect(() => {
    void refresh();
    // Quay lại app (vd. vừa sửa code trong VS Code) → đọc lại status.
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  // Khi danh sách file thay đổi, dọn các path đã biến mất khỏi tập "bỏ tick".
  useEffect(() => {
    const paths = new Set((status?.files ?? []).map((f) => f.path));
    setUnchecked((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const p of prev) (paths.has(p) ? next.add(p) : (changed = true));
      return changed ? next : prev;
    });
  }, [status]);

  // Nạp diff cho mục đang chọn; file biến mất khỏi danh sách thì bỏ chọn.
  useEffect(() => {
    if (!selected) return setDiff("");
    let alive = true;
    const p =
      selected.type === "commit"
        ? git.show(path, selected.commit.hash)
        : git.fileDiff(path, selected.file.path, selected.file.kind === "untracked");
    p.then((d) => alive && setDiff(d || tr("git.noTextualDifference"))).catch((e) => alive && setDiff(`⚠ ${errText(e)}`));
    return () => { alive = false; };
  }, [selected, path, status]);

  /** Bọc một thao tác: hiện trạng thái bận, ghi log, báo lỗi tại chỗ, xong thì làm mới. */
  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError("");
    try {
      const out = await fn();
      log(`[${repoName(path)}] ${label}${typeof out === "string" && out ? `\n${out}` : " ✓"}`);
    } catch (e) {
      setError(errText(e));
      log(`[${repoName(path)}] ${label} ✗ ${errText(e)}`);
    } finally {
      setBusy(null);
      setProgress("");
      await refresh();
    }
  };

  const remote = (op: RemoteOp, label: string) =>
    run(label, async () => {
      const job = `j${++jobSeq}`;
      const un = await listen<{ job: string; line: string; done: boolean }>("git-progress", (ev) => {
        if (ev.payload.job === job) setProgress(ev.payload.line);
      });
      try {
        return await git.remote(path, op, job);
      } finally {
        un();
      }
    });

  const files = status?.files ?? [];
  const conflicts = files.filter((f) => f.kind === "conflict");
  /** Kiểu GitHub Desktop: một danh sách, tick file nào thì file đó vào commit (mặc định tick hết). */
  const committable = files.filter((f) => f.kind !== "conflict");
  const checkedFiles = committable.filter((f) => !unchecked.has(f.path));
  const checkState: "all" | "none" | "some" =
    committable.length === 0 || checkedFiles.length === committable.length
      ? "all"
      : checkedFiles.length === 0
        ? "none"
        : "some";
  // Chỉ đúng 1 file thay đổi: gợi ý "Update <tên file>" làm PLACEHOLDER (như GitHub Desktop) — ô vẫn trống,
  // nếu không gõ gì thì commit dùng luôn gợi ý này.
  const soloName = committable.length === 1 ? committable[0].path.split("/").pop()! : null;
  const suggestedMsg = soloName ? `Update ${soloName}` : "";
  const effectiveMsg = message.trim() || suggestedMsg;
  const canCommit = !busy && effectiveMsg !== "" && checkedFiles.length > 0 && conflicts.length === 0;

  const toggleCheck = (f: FileChange) =>
    setUnchecked((prev) => {
      const next = new Set(prev);
      next.has(f.path) ? next.delete(f.path) : next.add(f.path);
      return next;
    });
  /** Tick/bỏ tick tất cả: đang tick hết thì bỏ hết, ngược lại tick hết. */
  const toggleCheckAll = () =>
    setUnchecked(checkState === "all" ? new Set(committable.map((f) => f.path)) : new Set());
  /** Chỉ có ý nghĩa khi commit gần nhất chưa push; đã push thì ẩn nút luôn. */
  const showUndo = history.length > 0 && !headPushed;
  const canUndo = !busy && showUndo;

  const commit = () =>
    canCommit &&
    run("commit", async () => {
      // Đưa index về đúng tập file đã tick: stage file tick, unstage file bỏ tick, rồi commit.
      const toStage = checkedFiles.map((f) => f.path);
      const toUnstage = committable.filter((f) => unchecked.has(f.path)).map((f) => f.path);
      if (toUnstage.length) await git.unstage(path, toUnstage);
      if (toStage.length) await git.stage(path, toStage);
      const out = await git.commit(path, effectiveMsg);
      setMessage("");
      return out;
    });

  const doDiscardAll = () => {
    setConfirmDiscardAll(false);
    void run(tr("git.discardAllChanges"), async () => {
      await git.discardAll(path);
      setSelected(null);
      return tr("git.revertedEveryFileToHeadAnd");
    });
  };

  /** Bỏ commit cuối (chỉ khi chưa push): thay đổi về Staged, message cũ điền lại để sửa. */
  const undoCommit = (c: Commit) => {
    setConfirmUndo(null);
    void run(tr("git.undoCommit"), async () => {
      const msg = await git.undoCommit(path);
      setMessage(msg);
      setSelected(null);
      return tr("git.undidCommitChangesAreStillStaged", { short: c.short });
    });
  };

  const doDiscard = (list: FileChange[]) => {
    setConfirmDiscard(null);
    void run(tr("git.discardChangesInFileS", { listLength: list.length }), () =>
      git.discard(path, list.filter((f) => f.kind !== "untracked").map((f) => f.path), list.filter((f) => f.kind === "untracked").map((f) => f.path)),
    );
  };

  const switchTo = (name: string) => {
    const b = branches.find((x) => x.name === name);
    if (!b || b.current) return;
    if (!b.remote) return void doSwitch({ branch: name, create: false, track: false, label: tr("git.switchTo", { name }) });
    // Nhánh remote: đã có nhánh local cùng tên thì chuyển sang đó, chưa có thì tạo nhánh theo dõi.
    const local = name.slice(name.indexOf("/") + 1);
    if (branches.some((x) => !x.remote && x.name === local))
      return void doSwitch({ branch: local, create: false, track: false, label: tr("git.switchTo2", { local }) });
    void doSwitch({ branch: name, create: false, track: true, label: `checkout ${name}` });
  };

  /** Chuyển nhánh; nếu git từ chối vì còn thay đổi chưa commit thì mở hộp hỏi mang theo (không báo lỗi đỏ). */
  const doSwitch = async (t: SwitchTarget) => {
    setBusy(t.label);
    setError("");
    try {
      await git.switchBranch(path, t.branch, t.create, t.track);
      log(`[${repoName(path)}] ${t.label} ✓`);
    } catch (e) {
      if (errText(e).startsWith("__DIRTY__")) {
        setSwitchDirty(t); // còn thay đổi chưa commit → hỏi mang theo / huỷ
      } else {
        setError(errText(e));
        log(`[${repoName(path)}] ${t.label} ✗ ${errText(e)}`);
      }
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  /** Chuyển nhánh kèm mang theo thay đổi chưa commit (stash → switch → pop phía Rust). */
  const doSwitchBring = (t: SwitchTarget) => {
    setSwitchDirty(null);
    void run(`${t.label} ${tr("git.bringChangesAlong")}`, () => git.switchBringChanges(path, t.branch, t.create, t.track));
  };

  const selectCommit = useCallback((c: Commit) => setSelected({ type: "commit", commit: c }), []);
  const onCommitMenu = useCallback((c: Commit, e: React.MouseEvent) => {
    e.preventDefault();
    setCommitMenu({ c, x: e.clientX, y: e.clientY });
  }, []);

  /** Mở hộp sửa message: điền sẵn message hiện tại của commit. */
  const openReword = async (c: Commit) => {
    try {
      setCommitAction({ kind: "reword", c, draft: await git.commitMessage(path, c.hash) });
    } catch (e) {
      setError(errText(e));
    }
  };
  const doReword = (c: Commit, msg: string) => {
    setCommitAction(null);
    void run(tr("git.editMessage", { short: c.short }), async () => { await git.rewordHead(path, msg); return tr("git.updatedCommitMessage", { short: c.short }); });
  };
  const doBranchAt = (c: Commit, name: string) => {
    setCommitAction(null);
    void run(tr("git.createBranchFrom", { p: name.trim(), short: c.short }), () => git.branchAt(path, name, c.hash));
  };
  const doRevert = (c: Commit) => {
    setCommitAction(null);
    void run(`revert ${c.short}`, () => git.revert(path, c.hash));
  };
  const doReset = (c: Commit, hard: boolean) => {
    setCommitAction(null);
    void run(`reset ${hard ? "--hard" : "--soft"} ${tr("git.to")} ${c.short}`, async () => {
      await git.resetTo(path, c.hash, hard);
      setSelected(null);
      return hard ? tr("git.resetAndClearedAllChangesBack") : tr("git.resetChangesFromLaterCommitsAre");
    });
  };
  const doCheckout = (c: Commit) => {
    setCommitAction(null);
    void run(`checkout ${c.short}`, async () => { await git.checkoutCommit(path, c.hash); setSelected(null); });
  };

  /** Các mục của menu chuột phải trên một commit. */
  const commitMenuItems = (c: Commit): CtxItem[] => {
    const copy = (t: string) => void navigator.clipboard.writeText(t);
    const isHead = history[0]?.hash === c.hash;
    return [
      // Sửa message = amend, chỉ áp dụng cho commit mới nhất và chưa push.
      ...(isHead && !headPushed ? [{ id: "reword", label: tr("git.editThisCommitMessage"), action: () => void openReword(c) }] : []),
      { id: "branch", label: tr("git.createBranchFromThisCommit"), action: () => setCommitAction({ kind: "branch", c, name: "" }) },
      { id: "revert", label: tr("git.revertThisCommit"), action: () => setCommitAction({ kind: "revert", c }) },
      { id: "reset", label: tr("git.resetBranchToThisCommit"), danger: true, action: () => setCommitAction({ kind: "reset", c }) },
      { id: "checkout", label: tr("git.checkoutThisCommitDetached"), action: () => setCommitAction({ kind: "checkout", c }) },
      { id: "s1", sep: true },
      { id: "copySha", label: tr("git.copyFullSha"), action: () => copy(c.hash) },
      { id: "copySubject", label: tr("git.copySubject"), action: () => copy(c.subject) },
      { id: "openRemote", label: tr("git.openOnRemoteBrowser"), action: () => void git.openCommitRemote(path, c.hash).catch((e) => setError(errText(e))) },
    ];
  };

  /** Bỏ qua file: chưa track thì chỉ thêm .gitignore, đã track thì hỏi trước khi bỏ theo dõi. */
  const applyIgnore = (f: FileChange, scope: IgnoreScope) => {
    const pattern = ignorePattern(f.path, scope);
    if (!pattern) return setError(tr("git.couldnTBuildAnIgnorePattern"));
    if (f.kind === "untracked") return doIgnore(f, scope, false);
    setConfirmIgnore({ file: f, scope, pattern });
  };
  const doIgnore = (f: FileChange, scope: IgnoreScope, untrack: boolean) => {
    setConfirmIgnore(null);
    void run(tr("git.ignore", { path: f.path }), async () => {
      const p = await git.ignore(path, f.path, scope, untrack);
      return tr(untrack ? "git.addedToGitignoreUntracked" : "git.addedToGitignore", { p });
    });
  };

  /** Các mục của menu chuột phải trên một file. */
  const fileMenu = (m: { file: FileChange; staged: boolean }): CtxItem[] => {
    const f = m.file;
    const ext = f.path.includes(".") ? f.path.split(".").pop()! : "";
    const copy = (text: string) => void navigator.clipboard.writeText(text);
    return [
      m.staged
        ? { id: "unstage", label: "Unstage", action: () => void run(`unstage ${f.path}`, () => git.unstage(path, [f.path])) }
        : {
            id: "stage",
            label: f.kind === "conflict" ? tr("git.markResolved") : "Stage",
            action: () => void run(`stage ${f.path}`, () => git.stage(path, [f.path])),
          },
      ...(m.staged
        ? []
        : [{ id: "discard", label: tr("git.discardChanges"), danger: true, action: () => setConfirmDiscard([f]) }]),
      { id: "s1", sep: true },
      { id: "copyRel", label: tr("git.copyRelativePath"), action: () => copy(f.path) },
      { id: "copyAbs", label: tr("git.copyFullPath"), action: () => copy(`${path}/${f.path}`) },
      { id: "reveal", label: tr("git.revealInExplorer"), action: () => void git.reveal(path, f.path).catch((e) => setError(errText(e))) },
      { id: "s2", sep: true },
      { id: "igFile", label: tr("git.ignoreThisFileGitignore"), action: () => applyIgnore(f, "file") },
      { id: "igParent", label: tr("git.ignoreParentFolder"), disabled: !f.path.includes("/"), action: () => applyIgnore(f, "parent") },
      { id: "igExt", label: ext ? tr("git.ignoreAllExtFiles", { ext }) : tr("git.ignoreAllSameExtFiles"), disabled: !ext, action: () => applyIgnore(f, "ext") },
    ];
  };

  const byRecent = (a: Branch, b: Branch) => b.time - a.time;
  const localBranches = branches.filter((b) => !b.remote).sort(byRecent);
  const remoteBranches = branches.filter((b) => b.remote).sort(byRecent);
  const pushOp: RemoteOp = status?.upstream ? "push" : "push-upstream";

  const doMerge = (b: string) => {
    setMergeOpen(false);
    void run(`merge ${b}`, () => git.merge(path, b));
  };

  const doRenameBranch = (b: Branch, name: string) => {
    setBranchAction(null);
    void run(tr("git.renameBranch", { name: b.name, name2: name }), () => git.renameBranch(path, b.name, name));
  };
  const doDeleteBranch = (b: Branch, force: boolean) => {
    setBranchAction(null);
    void run(tr("git.deleteBranch", { name: b.name }), async () => {
      try {
        return await git.deleteBranch(path, b.name, b.remote, force);
      } catch (e) {
        // Nhánh local chưa merge: Rust gắn tiền tố __UNMERGED__ → mở lại hộp với tuỳ chọn xoá ép.
        if (errText(e).startsWith("__UNMERGED__")) {
          setBranchAction({ kind: "delete", b, force: true });
          throw new Error(tr("git.branchIsnTMergedAnywhereIts", { name: b.name }));
        }
        throw e;
      }
    });
  };

  /** Menu chuột phải trên một nhánh trong dropdown (giống GitHub Desktop). */
  const branchMenuItems = (b: Branch): CtxItem[] => [
    { id: "switch", label: tr("git.switchToThisBranch"), disabled: b.current, action: () => switchTo(b.name) },
    { id: "merge", label: tr("git.mergeIntoCurrentBranch", { name: b.name }), disabled: b.current, action: () => doMerge(b.name) },
    { id: "s1", sep: true },
    ...(b.remote
      ? []
      : [{ id: "rename", label: tr("git.renameBranch2"), action: () => setBranchAction({ kind: "rename", b, name: b.name }) }]),
    {
      id: "delete",
      label: b.remote ? tr("git.deleteRemoteBranch") : tr("git.deleteBranch2"),
      danger: true,
      disabled: b.current,
      action: () => setBranchAction({ kind: "delete", b, force: false }),
    },
    { id: "s2", sep: true },
    { id: "copy", label: tr("git.copyBranchName"), action: () => void navigator.clipboard.writeText(b.name) },
  ];

  return (
    <div className="view">
      <div className="toolbar">
        <RepoSwitcher currentPath={path} />
        <span className="tb-sep" />
        {newBranch === null ? (
          <Picker
            title={tr("git.switchBranch")}
            disabled={!!busy}
            filterPlaceholder={tr("git.filterBranches")}
            label={<><span className="branch-glyph">⎇</span> {status?.branch ?? `(detached ${status?.head ?? ""})`}</>}
            items={[
              ...localBranches.map((b) => ({
                id: b.name,
                label: b.name,
                group: "Local",
                icon: "🌿",
                hint: b.time ? ago(b.time) : undefined,
                selected: b.current,
              })),
              ...remoteBranches.map((b) => ({ id: b.name, label: b.name, group: "Remote", icon: "☁", hint: b.time ? ago(b.time) : undefined })),
              { id: "\u0000new", label: "New branch…", group: "Other", icon: "＋" },
            ]}
            onPick={(id) => (id === "\u0000new" ? setNewBranch("") : switchTo(id))}
            onItemContextMenu={(id, e, close) => {
              const b = branches.find((x) => x.name === id);
              if (b) {
                closeBranchPicker.current = close;
                setBranchMenu({ b, x: e.clientX, y: e.clientY });
              }
            }}
          />
        ) : (
          <>
            <input
              autoFocus
              placeholder={tr("git.newBranchNameFromCurrentHead")}
              value={newBranch}
              onChange={(e) => setNewBranch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setNewBranch(null);
                if (e.key === "Enter" && newBranch.trim()) {
                  const n = newBranch.trim();
                  setNewBranch(null);
                  void run(`${tr("git.createBranch")} ${n}`, () => git.switchBranch(path, n, true));
                }
              }}
            />
            <button onClick={() => setNewBranch(null)}>{tr("git.cancel")}</button>
          </>
        )}
        <button
          disabled={!!busy || branches.filter((b) => !b.current).length === 0}
          onClick={() => setMergeOpen(true)}
          title={tr("git.mergeAnotherBranchIntoTheCurrent")}
        >
          ⇄ Merge
        </button>
        <span className="muted small ellipsis" title={path}>
          {status?.upstream ? `→ ${status.upstream}` : status ? tr("git.noUpstream") : ""}
        </span>
        <span className="grow" />
        {busy && <span className="muted small ellipsis progress-text">⏳ {progress || busy}</span>}
        <button className="icon-btn" disabled={!!busy} onClick={() => void refresh()} title={tr("git.reloadStatus")}>↻</button>
        {/* Nhóm remote tách riêng khỏi các nút khác để không bấm nhầm; mỗi nút chỉ bật khi có việc để làm. */}
        <div className="remote-actions">
          <button
            disabled={!!busy}
            onClick={() => remote("fetch", "fetch")}
            title={tr("git.fetchDownloadNewCommitsFromRemote")}
          >
            ⟳ Fetch
          </button>
          <button
            disabled={!!busy || !status?.behind}
            onClick={() => remote("pull", "pull")}
            title={status?.behind ? tr("git.pullFetchCommitsFromRemoteInto", { behind: status.behind }) : tr("git.noCommitsOnRemoteToPull")}
          >
            ⬇ Pull{status?.behind ? ` ${status.behind}` : ""}
          </button>
          <button
            disabled={!!busy || (!!status?.upstream && !status.ahead)}
            onClick={() => remote(pushOp, pushOp === "push" ? "push" : "publish")}
            title={
              !status?.upstream
                ? tr("git.publishThisBranchIsnTOn")
                : status.ahead
                  ? tr("git.pushPushCommitsTo", { ahead: status.ahead, upstream: status.upstream })
                  : tr("git.noCommitsToPush")
            }
          >
            {status?.upstream ? `⬆ Push${status.ahead ? ` ${status.ahead}` : ""}` : "⬆ Publish"}
          </button>
        </div>
        <button disabled={!!busy || !files.length} onClick={() => run("stash", () => git.stash(path, false))} title={tr("git.stashShelveAllChangesInclNew")}>Stash</button>
        <button disabled={!!busy} onClick={() => run("stash pop", () => git.stash(path, true))} title={tr("git.popRestoreStashedChanges")}>Pop</button>
      </div>

      {error && <div className="error-box pre">⚠ {error}</div>}
      {confirmDiscard && (
        <div className="error-box toolbar">
          {tr("git.discardChangesInFilesNewFiles", { confirmDiscardLength: confirmDiscard.length })}
          <span className="grow" />
          <button onClick={() => setConfirmDiscard(null)}>{tr("git.cancel")}</button>
          <button className="primary danger" onClick={() => doDiscard(confirmDiscard)}>{tr("git.discardChanges2")}</button>
        </div>
      )}
      {commitAction && (
        <div className="error-box commit-action">
          {commitAction.kind === "reword" && (
            <>
              <div>{tr("git.editMessageOfCommit")} <b>{commitAction.c.short}</b> {tr("git.amendOnlyForTheLatestUnpushed")}</div>
              <textarea
                autoFocus
                value={commitAction.draft}
                onChange={(e) => setCommitAction({ ...commitAction, draft: e.target.value })}
              />
              <div className="toolbar">
                <span className="grow" />
                <button onClick={() => setCommitAction(null)}>{tr("git.cancel")}</button>
                <button className="primary" disabled={!commitAction.draft.trim()} onClick={() => doReword(commitAction.c, commitAction.draft)}>{tr("git.saveMessage")}</button>
              </div>
            </>
          )}
          {commitAction.kind === "branch" && (
            <>
              <div>{tr("git.createANewBranchFromCommit")} <b>{commitAction.c.short}</b> “{commitAction.c.subject}” {tr("git.andSwitchToIt")}</div>
              <input
                autoFocus
                placeholder={tr("git.newBranchName")}
                value={commitAction.name}
                onChange={(e) => setCommitAction({ ...commitAction, name: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setCommitAction(null);
                  if (e.key === "Enter" && commitAction.name.trim()) doBranchAt(commitAction.c, commitAction.name);
                }}
              />
              <div className="toolbar">
                <span className="grow" />
                <button onClick={() => setCommitAction(null)}>{tr("git.cancel")}</button>
                <button className="primary" disabled={!commitAction.name.trim()} onClick={() => doBranchAt(commitAction.c, commitAction.name)}>{tr("git.createSwitchBranch")}</button>
              </div>
            </>
          )}
          {commitAction.kind === "revert" && (
            <>
              <div>{tr("git.revertCommit")} <b>{commitAction.c.short}</b> “{commitAction.c.subject}”? {tr("git.createsANewCommitThatUndoes")}</div>
              <div className="toolbar">
                <span className="grow" />
                <button onClick={() => setCommitAction(null)}>{tr("git.cancel")}</button>
                <button className="primary" onClick={() => doRevert(commitAction.c)}>Revert</button>
              </div>
            </>
          )}
          {commitAction.kind === "checkout" && (
            <>
              <div>{tr("git.checkoutCommit")} <b>{commitAction.c.short}</b> {tr("git.in")} <b>detached HEAD</b> {tr("git.notOnAnyBranchViewOnly")}</div>
              <div className="toolbar">
                <span className="grow" />
                <button onClick={() => setCommitAction(null)}>{tr("git.cancel")}</button>
                <button className="primary" onClick={() => doCheckout(commitAction.c)}>Checkout</button>
              </div>
            </>
          )}
          {commitAction.kind === "reset" && (
            <>
              <div>
                {tr("git.resetBranch")} <b>{status?.branch ?? ""}</b> {tr("git.toCommit")} <b>{commitAction.c.short}</b> “{commitAction.c.subject}”.
                {tr("git.allCommitsAfterItAreRemoved")}
              </div>
              <div className="toolbar">
                <span className="grow" />
                <button onClick={() => setCommitAction(null)}>{tr("git.cancel")}</button>
                <button className="primary" title={tr("git.keepAllChangesInStagedTo")} onClick={() => doReset(commitAction.c, false)}>{tr("git.keepChangesSoft")}</button>
                <button className="primary danger" title={tr("git.wipeAllChangesResetWorkingTree")} onClick={() => doReset(commitAction.c, true)}>{tr("git.wipeAllHard")}</button>
              </div>
            </>
          )}
        </div>
      )}

      <div className="split">
        <div className="pane narrow changes" style={{ width: changesW, flex: "0 0 auto" }}>
          <div className="file-lists">
            {conflicts.length > 0 && (
              <FileGroup title={`Conflicts (${conflicts.length})`} files={conflicts} selected={selected} staged={false}
                onSelect={(f) => setSelected({ type: "file", file: f, staged: false })}
                onMenu={(f, e) => setMenu({ file: f, staged: false, x: e.clientX, y: e.clientY })}
                actions={(f) => <button className="icon-btn" title={tr("git.markResolvedStage")} onClick={() => run(`stage ${f.path}`, () => git.stage(path, [f.path]))}>✓</button>}
              />
            )}
            {committable.length > 0 && (
              <FileGroup
                title={`Changes (${checkedFiles.length}/${committable.length})`}
                files={committable}
                selected={selected}
                staged={false}
                headerLead={
                  <input
                    type="checkbox"
                    className="file-check"
                    title={tr("git.selectDeselectAll")}
                    checked={checkState === "all"}
                    ref={(el) => { if (el) el.indeterminate = checkState === "some"; }}
                    onChange={toggleCheckAll}
                  />
                }
                headerAction={
                  <>
                    <button className="icon-btn danger" title={tr("git.discardAllChangesResetToHead")} onClick={() => setConfirmDiscardAll(true)}>↶</button>
                    <button className="icon-btn" title={tr("git.stashAllChanges")} onClick={() => run(tr("git.stashAll"), () => git.stash(path, false))}>🗄</button>
                  </>
                }
                isChecked={(f) => !unchecked.has(f.path)}
                onToggleCheck={toggleCheck}
                onSelect={(f) => setSelected({ type: "file", file: f, staged: false })}
                onMenu={(f, e) => setMenu({ file: f, staged: false, x: e.clientX, y: e.clientY })}
                actions={(f) => (
                  <button className="icon-btn danger" title={tr("git.discardThisFileSChanges")} onClick={() => setConfirmDiscard([f])}>↶</button>
                )}
              />
            )}
            {status && !files.length && <div className="muted small pad">{tr("git.noChanges")}</div>}
          </div>
          <textarea
            className="commit-msg"
            placeholder={suggestedMsg || `Commit message (Ctrl+Enter)${status?.branch ? ` — ${tr("git.to2")} ${status.branch}` : ""}`}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void commit(); } }}
          />
          <div className="toolbar commit-actions">
            {/* Chỉ hiện khi có commit chưa push để bỏ — không có thì giữ chỗ trống cho Commit. */}
            {showUndo && (
              <button
                disabled={!canUndo}
                onClick={() => history[0] && setConfirmUndo(history[0])}
                title={tr("git.undoLastCommitKeepChangesIn")}
              >
                ↶ {tr("git.undoCommit2")} {history[0]?.short}
              </button>
            )}
            <button className="primary grow" disabled={!canCommit} onClick={() => void commit()}>
              Commit{checkedFiles.length ? ` ${checkedFiles.length} ${tr("git.files")}` : ""}
            </button>
          </div>
          {confirmDiscardAll && (
            <div className="error-box">
              {tr("git.discardAllUncommittedChangesEveryModified")}
              <div className="toolbar">
                <span className="grow" />
                <button onClick={() => setConfirmDiscardAll(false)}>{tr("git.cancel")}</button>
                <button className="primary danger" onClick={doDiscardAll}>{tr("git.discardAll")}</button>
              </div>
            </div>
          )}
          {confirmUndo && (
            <div className="error-box">
              {tr("git.undoCommit3")} <b>{confirmUndo.short}</b> “{confirmUndo.subject}”? {tr("git.theCommitLeavesTheBranchIts")}
              <div className="toolbar">
                <span className="grow" />
                <button onClick={() => setConfirmUndo(null)}>{tr("git.cancel")}</button>
                <button className="primary danger" onClick={() => undoCommit(confirmUndo)}>{tr("git.undoCommit2")}</button>
              </div>
            </div>
          )}
          {confirmIgnore && (
            <div className="error-box">
              ⚠ <span className="mono">{confirmIgnore.file.path}</span> {tr("git.isTrackedByGitIgnoringWith")}{" "}
              <span className="mono">{confirmIgnore.pattern}</span> {tr("git.addsToGitignoreAnd")} <b>{tr("git.untracks")}</b> {tr("git.thisFileFileStaysOnDisk")}
              <div className="toolbar">
                <span className="grow" />
                <button onClick={() => setConfirmIgnore(null)}>{tr("git.cancel")}</button>
                <button className="primary danger" onClick={() => doIgnore(confirmIgnore.file, confirmIgnore.scope, true)}>
                  {tr("git.ignoreUntrack")}
                </button>
              </div>
            </div>
          )}
        </div>
        <Splitter axis="x" onResize={(d) => setChangesW((w) => w + d)} onReset={() => setChangesW(280)} />
        <div className="pane">
          <div className="pane-title ellipsis">
            {selected?.type === "file" && <>{selected.file.orig ? `${selected.file.orig} → ` : ""}{selected.file.path}</>}
            {selected?.type === "commit" && <>Commit {selected.commit.short} · {selected.commit.subject}</>}
            {!selected && "Diff"}
          </div>
          {selected ? <DiffView text={diff} /> : <div className="empty">{tr("git.pickAFileOrCommitTo")}</div>}
        </div>
      </div>

      <Splitter axis="y" onResize={(d) => setHistoryH((h) => h - d)} onReset={() => setHistoryH(200)} />
      <div className="pane history" style={{ height: historyH, flex: "0 0 auto" }}>
        <div className="pane-title">History ({history.length}{history.length >= 200 ? "+" : ""})</div>
        <HistoryList
          history={history}
          loaded={!!status}
          selectedHash={selected?.type === "commit" ? selected.commit.hash : null}
          onSelect={selectCommit}
          onMenu={onCommitMenu}
        />
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={fileMenu(menu)} onClose={() => setMenu(null)} />}
      {commitMenu && <ContextMenu x={commitMenu.x} y={commitMenu.y} items={commitMenuItems(commitMenu.c)} onClose={() => setCommitMenu(null)} />}
      {branchMenu && (
        <ContextMenu
          x={branchMenu.x}
          y={branchMenu.y}
          items={branchMenuItems(branchMenu.b)}
          onClose={() => { setBranchMenu(null); closeBranchPicker.current?.(); closeBranchPicker.current = null; }}
        />
      )}
      {branchAction && (
        <Modal
          title={branchAction.kind === "rename" ? tr("git.renameBranch3") : tr("git.deleteBranch3", { name: branchAction.b.name })}
          width={460}
          onClose={() => setBranchAction(null)}
        >
          {branchAction.kind === "rename" ? (
            <div className="form account-form">
              <div className="muted small">{rich(tr("git.renameLocalBranchRich"), { name: <b>{branchAction.b.name}</b> })}</div>
              <input
                autoFocus
                value={branchAction.name}
                onChange={(e) => setBranchAction({ ...branchAction, name: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setBranchAction(null);
                  if (e.key === "Enter" && branchAction.name.trim() && branchAction.name.trim() !== branchAction.b.name)
                    doRenameBranch(branchAction.b, branchAction.name.trim());
                }}
              />
              <div className="toolbar">
                <span className="grow" />
                <button onClick={() => setBranchAction(null)}>{tr("git.cancel")}</button>
                <button
                  className="primary"
                  disabled={!branchAction.name.trim() || branchAction.name.trim() === branchAction.b.name}
                  onClick={() => doRenameBranch(branchAction.b, branchAction.name.trim())}
                >
                  {tr("git.rename")}
                </button>
              </div>
            </div>
          ) : (
            <div className="form account-form">
              <div className="muted small">
                {branchAction.b.remote ? (
                  rich(tr("git.deleteRemoteBranchRich"), { name: <b>{branchAction.b.name}</b>, remote: <b>remote</b> })
                ) : branchAction.force ? (
                  rich(tr("git.branchNotMergedRich"), { name: <b>{branchAction.b.name}</b>, notMerged: <b>{tr("git.notMerged")}</b> })
                ) : (
                  rich(tr("git.deleteLocalBranchRich"), { name: <b>{branchAction.b.name}</b> })
                )}
              </div>
              <div className="toolbar">
                <span className="grow" />
                <button onClick={() => setBranchAction(null)}>{tr("git.cancel")}</button>
                <button
                  className="primary danger"
                  onClick={() => doDeleteBranch(branchAction.b, branchAction.force || branchAction.b.remote)}
                >
                  {branchAction.force ? tr("git.forceDelete") : tr("git.delete")}
                </button>
              </div>
            </div>
          )}
        </Modal>
      )}
      {switchDirty && (
        <Modal title={tr("git.uncommittedChanges")} width={480} onClose={() => setSwitchDirty(null)}>
          <div className="form account-form">
            <div className="muted small">
              {rich(tr("git.switchDirtyRich"), { cur: <b>{status?.branch}</b>, target: <b>{switchDirty.branch}</b>, bring: <b>{tr("git.bringTheseChangesAlong")}</b> })}
            </div>
            <div className="toolbar">
              <span className="grow" />
              <button onClick={() => setSwitchDirty(null)}>{tr("git.cancel")}</button>
              <button className="primary" onClick={() => doSwitchBring(switchDirty)}>{tr("git.bringAlongSwitch")}</button>
            </div>
          </div>
        </Modal>
      )}
      {mergeOpen && (
        <Modal title={tr("git.mergeInto", { branch: status?.branch ?? tr("git.currentBranch") })} width={520} onClose={() => setMergeOpen(false)}>
          <div className="form account-form">
            <div className="muted small">
              {rich(tr("git.pickMergeSourceRich"), { branch: <b>{status?.branch}</b> })}
            </div>
            <div className="merge-list">
              {[...localBranches, ...remoteBranches].filter((b) => !b.current).map((b) => (
                <button key={b.name} className="merge-row" onClick={() => doMerge(b.name)} title={b.subject}>
                  <span className="merge-ic">{b.remote ? "☁" : "🌿"}</span>
                  <span className="merge-main">
                    <span className="merge-name ellipsis">{b.name}</span>
                    <span className="merge-sub muted small ellipsis">
                      {b.subject || "—"}{b.time ? ` · ${ago(b.time)}` : ""}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Danh sách commit: memo để kéo giãn khối không phải vẽ lại 200 dòng mỗi khung hình. */
const HistoryList = memo(function HistoryList({
  history,
  loaded,
  selectedHash,
  onSelect,
  onMenu,
}: {
  history: Commit[];
  loaded: boolean;
  selectedHash: string | null;
  onSelect: (c: Commit) => void;
  onMenu: (c: Commit, e: React.MouseEvent) => void;
}) {
  const tr = useT();
  return (
    <div className="history-list">
      {history.map((c) => (
        <div
          key={c.hash}
          className={`history-row ${c.hash === selectedHash ? "on" : ""}`}
          onClick={() => onSelect(c)}
          onContextMenu={(e) => onMenu(c, e)}
          title={c.subject}
        >
          <span className="mono muted">{c.short}</span>
          <span className="grow ellipsis">
            {c.refs &&
              c.refs.split(", ").map((r) => (
                <span key={r} className={`ref ${r.startsWith("HEAD") ? "head" : r.includes("/") ? "remote" : ""}`}>
                  {r.replace("HEAD -> ", "")}
                </span>
              ))}
            {c.subject}
          </span>
          <span className="muted small ellipsis author">{c.author}</span>
          <span className="muted small time">{ago(c.time)}</span>
        </div>
      ))}
      {loaded && !history.length && <div className="muted small pad">{tr("git.noCommitsYet")}</div>}
    </div>
  );
});

function FileGroup(props: {
  title: string;
  files: FileChange[];
  staged: boolean;
  selected: Selected;
  onSelect: (f: FileChange) => void;
  onMenu: (f: FileChange, e: React.MouseEvent) => void;
  actions: (f: FileChange) => React.ReactNode;
  headerAction?: React.ReactNode;
  /** Ô tick "chọn tất cả" hiện trước tiêu đề nhóm. */
  headerLead?: React.ReactNode;
  /** Có bật ô tick từng dòng không (và trạng thái của nó). */
  isChecked?: (f: FileChange) => boolean;
  onToggleCheck?: (f: FileChange) => void;
}) {
  const tr = useT();
  return (
    <div>
      <div className="file-group">
        {props.headerLead}
        <span className="grow">{props.title}</span>
        {props.headerAction}
      </div>
      {props.files.map((f) => {
        const code = f.kind === "untracked" ? "U" : f.kind === "conflict" ? "!" : props.staged ? f.x : f.y;
        const on = props.selected?.type === "file" && props.selected.file.path === f.path && props.selected.staged === props.staged;
        const slash = f.path.lastIndexOf("/");
        return (
          <div
            key={f.path}
            className={`file-row ${on ? "on" : ""}`}
            onClick={() => props.onSelect(f)}
            onContextMenu={(e) => { e.preventDefault(); props.onMenu(f, e); }}
            title={f.path}
          >
            {props.onToggleCheck && (
              <input
                type="checkbox"
                className="file-check"
                checked={props.isChecked?.(f) ?? true}
                onClick={(e) => e.stopPropagation()}
                onChange={() => props.onToggleCheck!(f)}
                title={tr("git.includeThisFileInTheCommit")}
              />
            )}
            <span className={`st st-${code}`}>{code}</span>
            <span className="grow ellipsis">
              {f.path.slice(slash + 1)} <span className="muted small">{slash > 0 ? f.path.slice(0, slash) : ""}</span>
            </span>
            <span className="row-actions" onClick={(e) => e.stopPropagation()}>{props.actions(f)}</span>
          </div>
        );
      })}
    </div>
  );
}

const MAX_DIFF_LINES = 4000;

const DiffView = memo(function DiffView({ text }: { text: string }) {
  const tr = useT();
  const lines = useMemo(() => text.split("\n"), [text]);
  const shown = lines.slice(0, MAX_DIFF_LINES);
  return (
    <div className="diff mono">
      {shown.map((l, i) => {
        const cls =
          l.startsWith("+++") || l.startsWith("---") || l.startsWith("diff ") || l.startsWith("index ") ? "meta"
          : l.startsWith("+") ? "add"
          : l.startsWith("-") ? "del"
          : l.startsWith("@@") ? "hunk"
          : "";
        return <div key={i} className={cls}>{l || " "}</div>;
      })}
      {lines.length > MAX_DIFF_LINES && <div className="meta">{tr("git.moreLinesDiffTooLarge", { p: lines.length - MAX_DIFF_LINES })}</div>}
    </div>
  );
});

function ago(unix: number) {
  const s = Math.floor(Date.now() / 1000) - unix;
  if (s < 60) return t("git.justNow");
  if (s < 3600) return `${Math.floor(s / 60)} ${t("git.min")}`;
  if (s < 86400) return `${Math.floor(s / 3600)} ${t("git.h")}`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} ${t("git.d")}`;
  return new Date(unix * 1000).toLocaleDateString(getLang() === "vi" ? "vi-VN" : "en-US");
}

/* ── Clone ─────────────────────────────────────── */

function CloneView({ onClose }: { onClose: () => void }) {
  const tr = useT();
  const log = useWorkbench((s) => s.log);
  const [url, setUrl] = useState("");
  const [parent, setParent] = useState("");
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");

  // Gợi ý tên thư mục từ URL.
  const suggested = useMemo(() => {
    const s = url.trim().replace(/\/+$/, "");
    const last = s.split(/[/:]/).pop() ?? "";
    return last.replace(/\.git$/, "");
  }, [url]);

  const chooseParent = async () => {
    const dir = await openDialog({ directory: true, title: t("git.pickAFolderToHoldThe") });
    if (typeof dir === "string") setParent(dir);
  };

  const clone = async () => {
    if (!url.trim()) return setError(tr("git.enterARepoUrl"));
    if (!parent.trim()) return setError(tr("git.pickADestinationFolder"));
    setBusy(true);
    setError("");
    setProgress("");
    const job = `j${++jobSeq}`;
    const un = await listen<{ job: string; line: string }>("git-progress", (ev) => {
      if (ev.payload.job === job) setProgress(ev.payload.line);
    });
    try {
      const dest = await git.clone(url.trim(), parent.trim(), folder.trim(), job);
      const name = repoName(dest);
      useRepos.getState().add([dest]);
      void refreshAllSummaries();
      log(`[git] clone ${url.trim()} → ${dest}`);
      onClose();
      openRepo({ path: dest, name });
    } catch (e) {
      setError(errText(e));
    } finally {
      un();
      setBusy(false);
      setProgress("");
    }
  };

  return (
    <div className="form account-form">
        <label>
          URL
          <input
            className="mono"
            autoFocus
            value={url}
            placeholder="https://github.com/user/repo.git  hoặc  git@github.com:user/repo.git"
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
        <label>
          {tr("git.destinationFolder")}
          <div className="form-row">
            <input className="grow mono" value={parent} placeholder="vd. D:\projects" onChange={(e) => setParent(e.target.value)} />
            <button onClick={chooseParent}>{tr("git.browse")}</button>
          </div>
        </label>
        <label>
          {tr("git.subfolderName")}
          <input className="mono" value={folder} placeholder={suggested || tr("git.autoFromUrl")} onChange={(e) => setFolder(e.target.value)} />
        </label>
        {parent && (folder || suggested) && (
          <div className="muted small mono">→ {parent}\{folder || suggested}</div>
        )}
        <div className="toolbar">
          <button className="primary" disabled={busy} onClick={() => void clone()}>{busy ? tr("git.cloning") : "Clone"}</button>
          {busy && <span className="muted small ellipsis progress-text">⏳ {progress}</span>}
        </div>
        {error && <div className="error-box pre">⚠ {error}</div>}
        <div className="muted small">
          {rich(tr("git.privateRepoLoginRich"), { account: <b>{tr("git.gitAccountLabel")}</b> })}
        </div>
    </div>
  );
}

/* ── Tài khoản Git ─────────────────────────────── */

function AccountView() {
  const tr = useT();
  const log = useWorkbench((s) => s.log);
  const [ident, setIdent] = useState<{ name: string; email: string; helper: string } | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [savedIdent, setSavedIdent] = useState("");

  const [host, setHost] = useState("github.com");
  const [username, setUsername] = useState("");
  const [token, setToken] = useState("");
  const [credMsg, setCredMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [error, setError] = useState("");
  const [account, setAccount] = useState<GitAccount | null>(null);
  const [accLoading, setAccLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      const id = await git.identity();
      setIdent(id);
      setName(id.name);
      setEmail(id.email);
    } catch (e) {
      setError(errText(e));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  /** Đọc trạng thái đăng nhập của host hiện tại (không bật popup). */
  const loadAccount = useCallback(async (h: string) => {
    if (!h.trim()) return setAccount(null);
    setAccLoading(true);
    try {
      setAccount(await git.account(h.trim()));
    } catch (e) {
      setError(errText(e));
      setAccount(null);
    } finally {
      setAccLoading(false);
    }
  }, []);
  // Host đổi → kiểm tra lại (hoãn nhẹ để không gọi khi đang gõ).
  useEffect(() => {
    const t = setTimeout(() => void loadAccount(host), 400);
    return () => clearTimeout(t);
  }, [host, loadAccount]);

  const signOut = async () => {
    try {
      await git.signOut(host.trim(), account?.username ?? "");
      setCredMsg(null);
      log(`[git] ${tr("git.signOut")} ${host.trim()}`);
      await loadAccount(host);
    } catch (e) {
      setError(errText(e));
    }
  };

  const saveIdentity = async () => {
    try {
      await git.setIdentity(name, email);
      setSavedIdent(tr("git.savedNameEmailGlobal"));
      log(`[git] ${tr("git.updateUserNameUserEmail")}`);
      void load();
    } catch (e) {
      setError(errText(e));
    }
  };

  const enableManager = async () => {
    try {
      await git.enableManager();
      void load();
    } catch (e) {
      setError(errText(e));
    }
  };

  const saveCredential = async () => {
    if (!username.trim() || !token) return setCredMsg({ ok: false, text: tr("git.usernameAndTokenAreRequired") });
    try {
      const login = await git.storeCredential(host.trim(), username.trim(), token);
      setToken("");
      setCredMsg({ ok: true, text: tr("git.signedIn", { login }) });
      log(`[git] ${tr("git.signIn")} ${host.trim()} ${tr("git.as")} ${login}`);
      await loadAccount(host);
    } catch (e) {
      setCredMsg({ ok: false, text: errText(e) });
    }
  };

  const tokenUrl =
    host.includes("github") ? "https://github.com/settings/tokens"
    : host.includes("gitlab") ? "https://gitlab.com/-/user_settings/personal_access_tokens"
    : null;

  return (
    <div className="form account-form">
        <h3>{tr("git.identityUsedForCommits")}</h3>
        <div className="form-row">
          <label className="grow">{tr("git.name")}<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nguyen Van A" /></label>
          <label className="grow">Email<input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="a@example.com" /></label>
        </div>
        <div className="toolbar">
          <button className="primary" onClick={() => void saveIdentity()}>{tr("git.saveIdentity")}</button>
          {savedIdent && <span className="muted small">{savedIdent}</span>}
        </div>

        <div className="form-sep" />

        <h3>{tr("git.signInPushPullClonePrivate")}</h3>

        {/* Thẻ tài khoản đang đăng nhập cho host hiện tại. */}
        <div className="account-card">
          {accLoading ? (
            <span className="muted small">{tr("git.checking")} {host}…</span>
          ) : account?.signedIn ? (
            <>
              <span className="account-avatar">{(account.login ?? account.username ?? "?").slice(0, 1).toUpperCase()}</span>
              <span className="grow">
                <div>
                  {account.login ? <b>@{account.login}</b> : <b>{account.username}</b>}
                  {account.name && <span className="muted"> · {account.name}</span>}
                </div>
                <div className="muted small">
                  {account.login ? `${account.username} · ` : ""}{account.host}
                  {account.note && <span className="danger-text"> · {account.note}</span>}
                </div>
              </span>
              <button onClick={() => void signOut()}>{tr("git.signOut2")}</button>
            </>
          ) : (
            <span className="muted small grow">{rich(tr("git.notSignedInRich"), { host: <b className="mono">{host}</b> })}</span>
          )}
          <button className="icon-btn" title={tr("git.reCheck")} onClick={() => void loadAccount(host)}>↻</button>
        </div>

        <div className="muted small">
          {ident?.helper
            ? rich(tr("git.credentialHelperRich"), { helper: <b className="mono">{ident.helper}</b> })
            : rich(tr("git.noCredentialHelperRich"), { enable: <button className="link" onClick={() => void enableManager()}>{tr("git.enableGitCredentialManager")}</button> })}
        </div>
        <div className="form-row">
          <label style={{ width: 180 }}>Host<input className="mono" value={host} onChange={(e) => setHost(e.target.value)} /></label>
          <label className="grow">Username<input value={username} onChange={(e) => setUsername(e.target.value)} placeholder={tr("git.gitUsername")} /></label>
        </div>
        <label>
          Personal Access Token
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={tr("git.pasteTokenHere")} />
        </label>
        {tokenUrl && (
          <div className="muted small">
            {tr("git.createATokenAt")} <span className="mono">{tokenUrl}</span> ({tr("git.scope")} <span className="mono">repo</span>). {tr("git.useTheTokenInsteadOfA")}
          </div>
        )}
        <div className="toolbar">
          <button className="primary" onClick={() => void saveCredential()}>{account?.signedIn ? tr("git.signInAgain") : tr("git.signIn2")}</button>
          {credMsg && <span className={credMsg.ok ? "muted small" : "danger-text small"}>{credMsg.text}</span>}
        </div>
        <div className="muted small">
          {rich(tr("git.tokenStorageRich"), { cmd: <span className="mono">git credential approve</span> })}
        </div>
        {error && <div className="error-box pre">⚠ {error}</div>}
    </div>
  );
}

/** Mỗi tab Git chỉ là một repo. (Tài khoản + clone mở dạng modal, không phải tab.) */
function GitTab({ tab }: { tab: Tab }) {
  return <RepoView tab={tab} />;
}

function GitEmpty() {
  const tr = useT();
  const repos = useRepos((s) => s.repos);
  useEffect(() => { void refreshAllSummaries(); }, []);
  return (
    <div className="welcome git-empty">
      <h1>🌿 Git</h1>
      {repos.length > 0 ? (
        <>
          <p className="muted">{tr("git.pickARepositoryToOpen")}</p>
          <div className="empty-repo-list">
            {repos.map((r) => (
              <button key={r.path} className="empty-repo" onClick={() => openRepo(r)} title={r.path}>
                <span className="grow ellipsis">▤ {r.name}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <p className="muted">{tr("git.noRepositoriesYet")}</p>
      )}
      <div className="toolbar">
        <button onClick={() => void addRepos().catch(() => {})}>{tr("git.addExistingRepo2")}</button>
        <button className="primary" onClick={openClone}>{tr("git.cloneFromUrl2")}</button>
        <button onClick={openAccount}>{tr("git.gitAccount2")}</button>
      </div>
    </div>
  );
}

/** Gốc app Git: bố cục tab + các modal (Tài khoản, Clone) mở từ bất cứ đâu. */
function GitRoot() {
  const tr = useT();
  const accOpen = useAccountOpen();
  const cloneOpen = useCloneOpen();
  return (
    <>
      <TabbedLayout appId="git" TabView={GitTab} empty={<GitEmpty />} />
      {accOpen && (
        <Modal title={tr("git.gitAccount2")} width={560} onClose={closeAccount}>
          <AccountView />
        </Modal>
      )}
      {cloneOpen && (
        <Modal title={tr("git.cloneRepository")} width={620} onClose={closeClone}>
          <CloneView onClose={closeClone} />
        </Modal>
      )}
    </>
  );
}

const gitApp: AppModule = {
  View: GitRoot,
  commands: () => [
    { id: "git.add", group: "Git", title: t("git.addExistingRepo3"), run: () => void addRepos().catch(() => {}) },
    { id: "git.clone", group: "Git", title: t("git.cloneRepositoryFromUrl"), run: openClone },
    { id: "git.account", group: "Git", title: t("git.gitAccountLoginIdentity"), run: openAccount },
    ...useRepos.getState().repos.map((r) => ({
      id: `git.open.${r.path}`,
      group: "Git",
      title: `${t("git.openRepo")} ${r.name}`,
      run: () => openRepo(r),
    })),
  ],
};

export default gitApp;
