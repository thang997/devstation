import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { AppModule, Tab } from "../types";
import { useWorkbench } from "../../store/workbench";
import { getLang, t, useT } from "../../store/lang";
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
  const dir = await openDialog({ directory: true, title: t("Pick a repo or a folder containing repos", "Chọn repo hoặc thư mục chứa nhiều repo") });
  if (typeof dir !== "string") return "";
  let paths: string[];
  try {
    paths = [await git.root(dir)];
  } catch {
    paths = await git.findRepos(dir);
  }
  if (!paths.length) return t("No git repo found in this folder", "Không tìm thấy repo git nào trong thư mục này");
  const n = useRepos.getState().add(paths);
  void refreshAllSummaries();
  if (paths.length === 1 && n === 1) openRepo({ path: paths[0], name: repoName(paths[0]) });
  return n ? "" : t("These repos are already in the list", "Các repo này đã có trong danh sách");
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
      title={tr("Switch / add repository", "Đổi / thêm repository")}
      filterPlaceholder={tr("Filter repository…", "Lọc repository…")}
      label={<><span className="branch-glyph">▤</span> {current?.name ?? tr("Pick repository", "Chọn repository")}</>}
      items={[
        ...repos.map((r) => {
          const s = summaries[r.path];
          const hint = s?.error
            ? tr("error", "lỗi")
            : s
              ? `${s.branch ?? "detached"}${s.ahead ? ` ↑${s.ahead}` : ""}${s.behind ? ` ↓${s.behind}` : ""}${s.changes ? ` •${s.changes}` : ""}`
              : undefined;
          return { id: r.path, label: r.name, group: "Repository", icon: "▤", hint, selected: r.path === currentPath, removable: true };
        }),
        { id: "\u0000add", label: tr("Add existing repo…", "Thêm repo có sẵn…"), group: tr("Actions", "Thao tác"), icon: "＋" },
        { id: "\u0000clone", label: tr("Clone from URL…", "Clone từ URL…"), group: tr("Actions", "Thao tác"), icon: "⬇" },
        { id: "\u0000account", label: tr("Git account…", "Tài khoản Git…"), group: tr("Actions", "Thao tác"), icon: "⚙" },
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
    p.then((d) => alive && setDiff(d || tr("(No textual difference)", "(Không có khác biệt dạng văn bản)"))).catch((e) => alive && setDiff(`⚠ ${errText(e)}`));
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
    void run(tr("discard all changes", "bỏ tất cả thay đổi"), async () => {
      await git.discardAll(path);
      setSelected(null);
      return tr("reverted every file to HEAD and removed untracked files", "đã đưa mọi file về HEAD và xoá file chưa track");
    });
  };

  /** Bỏ commit cuối (chỉ khi chưa push): thay đổi về Staged, message cũ điền lại để sửa. */
  const undoCommit = (c: Commit) => {
    setConfirmUndo(null);
    void run(tr("undo commit", "bỏ commit"), async () => {
      const msg = await git.undoCommit(path);
      setMessage(msg);
      setSelected(null);
      return tr(`undid commit ${c.short}; changes are still Staged, message refilled in the box`, `đã bỏ commit ${c.short}; thay đổi vẫn ở Staged, message điền lại vào ô`);
    });
  };

  const doDiscard = (list: FileChange[]) => {
    setConfirmDiscard(null);
    void run(tr(`discard changes in ${list.length} file(s)`, `bỏ thay đổi ${list.length} file`), () =>
      git.discard(path, list.filter((f) => f.kind !== "untracked").map((f) => f.path), list.filter((f) => f.kind === "untracked").map((f) => f.path)),
    );
  };

  const switchTo = (name: string) => {
    const b = branches.find((x) => x.name === name);
    if (!b || b.current) return;
    if (!b.remote) return void doSwitch({ branch: name, create: false, track: false, label: tr(`switch to ${name}`, `chuyển sang ${name}`) });
    // Nhánh remote: đã có nhánh local cùng tên thì chuyển sang đó, chưa có thì tạo nhánh theo dõi.
    const local = name.slice(name.indexOf("/") + 1);
    if (branches.some((x) => !x.remote && x.name === local))
      return void doSwitch({ branch: local, create: false, track: false, label: tr(`switch to ${local}`, `chuyển sang ${local}`) });
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
    void run(`${t.label} ${tr("(bring changes along)", "(mang theo thay đổi)")}`, () => git.switchBringChanges(path, t.branch, t.create, t.track));
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
    void run(tr(`edit message ${c.short}`, `sửa message ${c.short}`), async () => { await git.rewordHead(path, msg); return tr(`updated commit message ${c.short}`, `đã cập nhật message commit ${c.short}`); });
  };
  const doBranchAt = (c: Commit, name: string) => {
    setCommitAction(null);
    void run(tr(`create branch ${name.trim()} from ${c.short}`, `tạo nhánh ${name.trim()} từ ${c.short}`), () => git.branchAt(path, name, c.hash));
  };
  const doRevert = (c: Commit) => {
    setCommitAction(null);
    void run(`revert ${c.short}`, () => git.revert(path, c.hash));
  };
  const doReset = (c: Commit, hard: boolean) => {
    setCommitAction(null);
    void run(`reset ${hard ? "--hard" : "--soft"} ${tr("to", "về")} ${c.short}`, async () => {
      await git.resetTo(path, c.hash, hard);
      setSelected(null);
      return hard ? tr("reset and cleared all changes back to this commit", "đã reset và xoá mọi thay đổi về đúng commit này") : tr("reset; changes from later commits are now Staged", "đã reset, thay đổi của các commit sau nằm ở Staged");
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
      ...(isHead && !headPushed ? [{ id: "reword", label: tr("Edit this commit message…", "Sửa message commit này…"), action: () => void openReword(c) }] : []),
      { id: "branch", label: tr("Create branch from this commit…", "Tạo nhánh từ commit này…"), action: () => setCommitAction({ kind: "branch", c, name: "" }) },
      { id: "revert", label: tr("Revert this commit…", "Revert commit này…"), action: () => setCommitAction({ kind: "revert", c }) },
      { id: "reset", label: tr("Reset branch to this commit…", "Reset nhánh về commit này…"), danger: true, action: () => setCommitAction({ kind: "reset", c }) },
      { id: "checkout", label: tr("Checkout this commit (detached)…", "Checkout commit này (detached)…"), action: () => setCommitAction({ kind: "checkout", c }) },
      { id: "s1", sep: true },
      { id: "copySha", label: tr("Copy full SHA", "Copy SHA đầy đủ"), action: () => copy(c.hash) },
      { id: "copySubject", label: tr("Copy subject", "Copy tiêu đề"), action: () => copy(c.subject) },
      { id: "openRemote", label: tr("Open on remote (browser)", "Mở trên remote (trình duyệt)"), action: () => void git.openCommitRemote(path, c.hash).catch((e) => setError(errText(e))) },
    ];
  };

  /** Bỏ qua file: chưa track thì chỉ thêm .gitignore, đã track thì hỏi trước khi bỏ theo dõi. */
  const applyIgnore = (f: FileChange, scope: IgnoreScope) => {
    const pattern = ignorePattern(f.path, scope);
    if (!pattern) return setError(tr("Couldn't build an ignore pattern for this item", "Không tạo được mẫu bỏ qua cho mục này"));
    if (f.kind === "untracked") return doIgnore(f, scope, false);
    setConfirmIgnore({ file: f, scope, pattern });
  };
  const doIgnore = (f: FileChange, scope: IgnoreScope, untrack: boolean) => {
    setConfirmIgnore(null);
    void run(tr(`ignore ${f.path}`, `bỏ qua ${f.path}`), async () => {
      const p = await git.ignore(path, f.path, scope, untrack);
      return tr(`added ${p} to .gitignore${untrack ? " and untracked the file" : ""}`, `đã thêm ${p} vào .gitignore${untrack ? " và bỏ theo dõi file" : ""}`);
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
            label: f.kind === "conflict" ? tr("Mark resolved", "Đánh dấu đã giải quyết") : "Stage",
            action: () => void run(`stage ${f.path}`, () => git.stage(path, [f.path])),
          },
      ...(m.staged
        ? []
        : [{ id: "discard", label: tr("Discard changes…", "Bỏ thay đổi…"), danger: true, action: () => setConfirmDiscard([f]) }]),
      { id: "s1", sep: true },
      { id: "copyRel", label: tr("Copy relative path", "Copy đường dẫn tương đối"), action: () => copy(f.path) },
      { id: "copyAbs", label: tr("Copy full path", "Copy đường dẫn đầy đủ"), action: () => copy(`${path}/${f.path}`) },
      { id: "reveal", label: tr("Reveal in Explorer", "Mở trong Explorer"), action: () => void git.reveal(path, f.path).catch((e) => setError(errText(e))) },
      { id: "s2", sep: true },
      { id: "igFile", label: tr("Ignore this file (.gitignore)", "Bỏ qua file này (.gitignore)"), action: () => applyIgnore(f, "file") },
      { id: "igParent", label: tr("Ignore parent folder", "Bỏ qua thư mục chứa"), disabled: !f.path.includes("/"), action: () => applyIgnore(f, "parent") },
      { id: "igExt", label: tr(`Ignore all ${ext ? `*.${ext}` : "same-ext"} files`, `Bỏ qua mọi file ${ext ? `*.${ext}` : "cùng đuôi"}`), disabled: !ext, action: () => applyIgnore(f, "ext") },
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
    void run(tr(`rename branch ${b.name} → ${name}`, `đổi tên nhánh ${b.name} → ${name}`), () => git.renameBranch(path, b.name, name));
  };
  const doDeleteBranch = (b: Branch, force: boolean) => {
    setBranchAction(null);
    void run(tr(`delete branch ${b.name}`, `xoá nhánh ${b.name}`), async () => {
      try {
        return await git.deleteBranch(path, b.name, b.remote, force);
      } catch (e) {
        // Nhánh local chưa merge: Rust gắn tiền tố __UNMERGED__ → mở lại hộp với tuỳ chọn xoá ép.
        if (errText(e).startsWith("__UNMERGED__")) {
          setBranchAction({ kind: "delete", b, force: true });
          throw new Error(tr(`Branch ${b.name} isn't merged anywhere — its own commits will be lost. Click "Force delete" if you're sure.`, `Nhánh ${b.name} chưa được merge vào đâu — các commit riêng của nó sẽ mất. Bấm “Xoá ép” nếu chắc chắn.`));
        }
        throw e;
      }
    });
  };

  /** Menu chuột phải trên một nhánh trong dropdown (giống GitHub Desktop). */
  const branchMenuItems = (b: Branch): CtxItem[] => [
    { id: "switch", label: tr("Switch to this branch", "Chuyển sang nhánh này"), disabled: b.current, action: () => switchTo(b.name) },
    { id: "merge", label: tr(`Merge “${b.name}” into current branch…`, `Merge “${b.name}” vào nhánh hiện tại…`), disabled: b.current, action: () => doMerge(b.name) },
    { id: "s1", sep: true },
    ...(b.remote
      ? []
      : [{ id: "rename", label: tr("Rename branch…", "Đổi tên nhánh…"), action: () => setBranchAction({ kind: "rename", b, name: b.name }) }]),
    {
      id: "delete",
      label: b.remote ? tr("Delete remote branch…", "Xoá nhánh trên remote…") : tr("Delete branch…", "Xoá nhánh…"),
      danger: true,
      disabled: b.current,
      action: () => setBranchAction({ kind: "delete", b, force: false }),
    },
    { id: "s2", sep: true },
    { id: "copy", label: tr("Copy branch name", "Copy tên nhánh"), action: () => void navigator.clipboard.writeText(b.name) },
  ];

  return (
    <div className="view">
      <div className="toolbar">
        <RepoSwitcher currentPath={path} />
        <span className="tb-sep" />
        {newBranch === null ? (
          <Picker
            title={tr("Switch branch", "Đổi nhánh")}
            disabled={!!busy}
            filterPlaceholder={tr("Filter branches…", "Lọc nhánh…")}
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
              placeholder={tr("new branch name (from current HEAD)", "tên nhánh mới (từ HEAD hiện tại)")}
              value={newBranch}
              onChange={(e) => setNewBranch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setNewBranch(null);
                if (e.key === "Enter" && newBranch.trim()) {
                  const n = newBranch.trim();
                  setNewBranch(null);
                  void run(`${tr("create branch", "tạo nhánh")} ${n}`, () => git.switchBranch(path, n, true));
                }
              }}
            />
            <button onClick={() => setNewBranch(null)}>{tr("Cancel", "Huỷ")}</button>
          </>
        )}
        <button
          disabled={!!busy || branches.filter((b) => !b.current).length === 0}
          onClick={() => setMergeOpen(true)}
          title={tr("Merge another branch into the current one", "Hợp nhất một nhánh khác vào nhánh hiện tại")}
        >
          ⇄ Merge
        </button>
        <span className="muted small ellipsis" title={path}>
          {status?.upstream ? `→ ${status.upstream}` : status ? tr("no upstream", "chưa có upstream") : ""}
        </span>
        <span className="grow" />
        {busy && <span className="muted small ellipsis progress-text">⏳ {progress || busy}</span>}
        <button className="icon-btn" disabled={!!busy} onClick={() => void refresh()} title={tr("Reload status", "Đọc lại status")}>↻</button>
        {/* Nhóm remote tách riêng khỏi các nút khác để không bấm nhầm; mỗi nút chỉ bật khi có việc để làm. */}
        <div className="remote-actions">
          <button
            disabled={!!busy}
            onClick={() => remote("fetch", "fetch")}
            title={tr("Fetch: download new commits from remote, doesn't touch your branch", "Fetch: tải commit mới từ remote về, không đụng nhánh đang làm")}
          >
            ⟳ Fetch
          </button>
          <button
            disabled={!!busy || !status?.behind}
            onClick={() => remote("pull", "pull")}
            title={status?.behind ? tr(`Pull: fetch ${status.behind} commits from remote into current branch`, `Pull: kéo ${status.behind} commit từ remote vào nhánh hiện tại`) : tr("No commits on remote to pull", "Không có commit nào ở remote để kéo")}
          >
            ⬇ Pull{status?.behind ? ` ${status.behind}` : ""}
          </button>
          <button
            disabled={!!busy || (!!status?.upstream && !status.ahead)}
            onClick={() => remote(pushOp, pushOp === "push" ? "push" : "publish")}
            title={
              !status?.upstream
                ? tr("Publish: this branch isn't on remote yet — runs push -u origin HEAD", "Publish: nhánh này chưa có trên remote — sẽ chạy push -u origin HEAD")
                : status.ahead
                  ? tr(`Push: push ${status.ahead} commits to ${status.upstream}`, `Push: đẩy ${status.ahead} commit lên ${status.upstream}`)
                  : tr("No commits to push", "Không có commit nào cần đẩy")
            }
          >
            {status?.upstream ? `⬆ Push${status.ahead ? ` ${status.ahead}` : ""}` : "⬆ Publish"}
          </button>
        </div>
        <button disabled={!!busy || !files.length} onClick={() => run("stash", () => git.stash(path, false))} title={tr("Stash: shelve all changes (incl. new files)", "Stash: cất mọi thay đổi (kể cả file mới)")}>Stash</button>
        <button disabled={!!busy} onClick={() => run("stash pop", () => git.stash(path, true))} title={tr("Pop: restore stashed changes", "Pop: lấy lại thay đổi đã stash")}>Pop</button>
      </div>

      {error && <div className="error-box pre">⚠ {error}</div>}
      {confirmDiscard && (
        <div className="error-box toolbar">
          {tr(`⚠ Discard changes in ${confirmDiscard.length} files? New files are deleted. Can't be undone.`, `⚠ Bỏ thay đổi của ${confirmDiscard.length} file? File mới sẽ bị xoá. Không hoàn tác được.`)}
          <span className="grow" />
          <button onClick={() => setConfirmDiscard(null)}>{tr("Cancel", "Huỷ")}</button>
          <button className="primary danger" onClick={() => doDiscard(confirmDiscard)}>{tr("Discard changes", "Bỏ thay đổi")}</button>
        </div>
      )}
      {commitAction && (
        <div className="error-box commit-action">
          {commitAction.kind === "reword" && (
            <>
              <div>{tr("Edit message of commit", "Sửa message commit")} <b>{commitAction.c.short}</b> {tr("(amend — only for the latest, unpushed commit):", "(amend — chỉ dùng được khi commit chưa push):")}</div>
              <textarea
                autoFocus
                value={commitAction.draft}
                onChange={(e) => setCommitAction({ ...commitAction, draft: e.target.value })}
              />
              <div className="toolbar">
                <span className="grow" />
                <button onClick={() => setCommitAction(null)}>{tr("Cancel", "Huỷ")}</button>
                <button className="primary" disabled={!commitAction.draft.trim()} onClick={() => doReword(commitAction.c, commitAction.draft)}>{tr("Save message", "Lưu message")}</button>
              </div>
            </>
          )}
          {commitAction.kind === "branch" && (
            <>
              <div>{tr("Create a new branch from commit", "Tạo nhánh mới từ commit")} <b>{commitAction.c.short}</b> “{commitAction.c.subject}” {tr("and switch to it:", "rồi chuyển sang nhánh đó:")}</div>
              <input
                autoFocus
                placeholder={tr("new branch name", "tên nhánh mới")}
                value={commitAction.name}
                onChange={(e) => setCommitAction({ ...commitAction, name: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setCommitAction(null);
                  if (e.key === "Enter" && commitAction.name.trim()) doBranchAt(commitAction.c, commitAction.name);
                }}
              />
              <div className="toolbar">
                <span className="grow" />
                <button onClick={() => setCommitAction(null)}>{tr("Cancel", "Huỷ")}</button>
                <button className="primary" disabled={!commitAction.name.trim()} onClick={() => doBranchAt(commitAction.c, commitAction.name)}>{tr("Create & switch branch", "Tạo & chuyển nhánh")}</button>
              </div>
            </>
          )}
          {commitAction.kind === "revert" && (
            <>
              <div>{tr("Revert commit", "Revert commit")} <b>{commitAction.c.short}</b> “{commitAction.c.subject}”? {tr("Creates a new commit that undoes the changes — doesn't rewrite history, safe even after push.", "Sẽ tạo một commit mới đảo ngược thay đổi — không viết lại lịch sử, an toàn cả khi đã push.")}</div>
              <div className="toolbar">
                <span className="grow" />
                <button onClick={() => setCommitAction(null)}>{tr("Cancel", "Huỷ")}</button>
                <button className="primary" onClick={() => doRevert(commitAction.c)}>Revert</button>
              </div>
            </>
          )}
          {commitAction.kind === "checkout" && (
            <>
              <div>{tr("Checkout commit", "Checkout commit")} <b>{commitAction.c.short}</b> {tr("in", "ở trạng thái")} <b>detached HEAD</b> {tr("(not on any branch, view only). Uncommitted changes may block this.", "(không nằm trên nhánh nào, chỉ để xem lại). Thay đổi chưa commit có thể cản thao tác này.")}</div>
              <div className="toolbar">
                <span className="grow" />
                <button onClick={() => setCommitAction(null)}>{tr("Cancel", "Huỷ")}</button>
                <button className="primary" onClick={() => doCheckout(commitAction.c)}>Checkout</button>
              </div>
            </>
          )}
          {commitAction.kind === "reset" && (
            <>
              <div>
                {tr("⚠ Reset branch", "⚠ Reset nhánh")} <b>{status?.branch ?? ""}</b> {tr("to commit", "về commit")} <b>{commitAction.c.short}</b> “{commitAction.c.subject}”.
                {tr(" All commits after it are removed from the branch; if those were pushed, your local branch diverges from remote.", " Mọi commit sau nó sẽ bị bỏ khỏi nhánh; nếu các commit đó đã push, nhánh local sẽ lệch remote.")}
              </div>
              <div className="toolbar">
                <span className="grow" />
                <button onClick={() => setCommitAction(null)}>{tr("Cancel", "Huỷ")}</button>
                <button className="primary" title={tr("Keep all changes in Staged to commit again", "Giữ mọi thay đổi ở vùng Staged để commit lại")} onClick={() => doReset(commitAction.c, false)}>{tr("Keep changes (soft)", "Giữ thay đổi (soft)")}</button>
                <button className="primary danger" title={tr("Wipe all changes, reset working tree to this commit", "Xoá sạch mọi thay đổi, đưa thư mục về đúng commit này")} onClick={() => doReset(commitAction.c, true)}>{tr("Wipe all (hard)", "Xoá hết (hard)")}</button>
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
                actions={(f) => <button className="icon-btn" title={tr("Mark resolved (stage)", "Đánh dấu đã giải quyết (stage)")} onClick={() => run(`stage ${f.path}`, () => git.stage(path, [f.path]))}>✓</button>}
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
                    title={tr("Select / deselect all", "Chọn / bỏ chọn tất cả")}
                    checked={checkState === "all"}
                    ref={(el) => { if (el) el.indeterminate = checkState === "some"; }}
                    onChange={toggleCheckAll}
                  />
                }
                headerAction={
                  <>
                    <button className="icon-btn" title={tr("Discard all changes (reset to HEAD, delete new files)", "Bỏ tất cả thay đổi (đưa về HEAD, xoá file mới)")} onClick={() => setConfirmDiscardAll(true)}>↶</button>
                    <button className="icon-btn" title={tr("Stash all changes", "Stash tất cả thay đổi")} onClick={() => run(tr("stash all", "stash tất cả"), () => git.stash(path, false))}>🗄</button>
                  </>
                }
                isChecked={(f) => !unchecked.has(f.path)}
                onToggleCheck={toggleCheck}
                onSelect={(f) => setSelected({ type: "file", file: f, staged: false })}
                onMenu={(f, e) => setMenu({ file: f, staged: false, x: e.clientX, y: e.clientY })}
                actions={(f) => (
                  <button className="icon-btn" title={tr("Discard this file's changes", "Bỏ thay đổi file này")} onClick={() => setConfirmDiscard([f])}>↶</button>
                )}
              />
            )}
            {status && !files.length && <div className="muted small pad">{tr("✓ No changes", "✓ Không có thay đổi")}</div>}
          </div>
          <textarea
            className="commit-msg"
            placeholder={suggestedMsg || `Commit message (Ctrl+Enter)${status?.branch ? ` — ${tr("to", "vào")} ${status.branch}` : ""}`}
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
                title={tr("Undo last commit, keep changes in Staged to edit and commit again", "Bỏ commit gần nhất, giữ thay đổi ở Staged để sửa rồi commit lại")}
              >
                ↶ {tr("Undo commit", "Bỏ commit")} {history[0]?.short}
              </button>
            )}
            <button className="primary grow" disabled={!canCommit} onClick={() => void commit()}>
              Commit{checkedFiles.length ? ` ${checkedFiles.length} ${tr("files", "file")}` : ""}
            </button>
          </div>
          {confirmDiscardAll && (
            <div className="error-box">
              {tr("⚠ Discard ALL uncommitted changes? Every modified file returns to HEAD and new files are deleted — can't be undone.", "⚠ Bỏ tất cả thay đổi chưa commit? Mọi file đã sửa quay về đúng HEAD và các file mới sẽ bị xoá — không hoàn tác được.")}
              <div className="toolbar">
                <span className="grow" />
                <button onClick={() => setConfirmDiscardAll(false)}>{tr("Cancel", "Huỷ")}</button>
                <button className="primary danger" onClick={doDiscardAll}>{tr("Discard all", "Bỏ tất cả")}</button>
              </div>
            </div>
          )}
          {confirmUndo && (
            <div className="error-box">
              {tr("⚠ Undo commit", "⚠ Bỏ commit")} <b>{confirmUndo.short}</b> “{confirmUndo.subject}”? {tr("The commit leaves the branch; its changes stay in Staged for you to edit and commit again.", "Commit biến mất khỏi nhánh, thay đổi của nó vẫn ở Staged để bạn sửa rồi commit lại.")}
              <div className="toolbar">
                <span className="grow" />
                <button onClick={() => setConfirmUndo(null)}>{tr("Cancel", "Huỷ")}</button>
                <button className="primary danger" onClick={() => undoCommit(confirmUndo)}>{tr("Undo commit", "Bỏ commit")}</button>
              </div>
            </div>
          )}
          {confirmIgnore && (
            <div className="error-box">
              ⚠ <span className="mono">{confirmIgnore.file.path}</span> {tr("is tracked by git. Ignoring with", "đang được git theo dõi. Bỏ qua bằng")}{" "}
              <span className="mono">{confirmIgnore.pattern}</span> {tr("adds to .gitignore and", "sẽ thêm vào .gitignore và")} <b>{tr("untracks", "bỏ theo dõi")}</b> {tr("this file (file stays on disk).", "file này (file vẫn còn trên đĩa).")}
              <div className="toolbar">
                <span className="grow" />
                <button onClick={() => setConfirmIgnore(null)}>{tr("Cancel", "Huỷ")}</button>
                <button className="primary danger" onClick={() => doIgnore(confirmIgnore.file, confirmIgnore.scope, true)}>
                  {tr("Ignore & untrack", "Bỏ qua & bỏ theo dõi")}
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
          {selected ? <DiffView text={diff} /> : <div className="empty">{tr("Pick a file or commit to see changes", "Chọn một file hoặc commit để xem thay đổi")}</div>}
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
          title={branchAction.kind === "rename" ? tr("Rename branch", "Đổi tên nhánh") : tr(`Delete branch ${branchAction.b.name}`, `Xoá nhánh ${branchAction.b.name}`)}
          width={460}
          onClose={() => setBranchAction(null)}
        >
          {branchAction.kind === "rename" ? (
            <div className="form account-form">
              <div className="muted small">{tr(<>Rename local branch <b>{branchAction.b.name}</b>.</>, <>Đổi tên nhánh local <b>{branchAction.b.name}</b>.</>)}</div>
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
                <button onClick={() => setBranchAction(null)}>{tr("Cancel", "Huỷ")}</button>
                <button
                  className="primary"
                  disabled={!branchAction.name.trim() || branchAction.name.trim() === branchAction.b.name}
                  onClick={() => doRenameBranch(branchAction.b, branchAction.name.trim())}
                >
                  {tr("Rename", "Đổi tên")}
                </button>
              </div>
            </div>
          ) : (
            <div className="form account-form">
              <div className="muted small">
                {branchAction.b.remote ? (
                  tr(<>⚠ Delete branch <b>{branchAction.b.name}</b> on the <b>remote</b>. This pushes to the server and cannot be undone.</>, <>⚠ Xoá nhánh <b>{branchAction.b.name}</b> trên <b>remote</b>. Thao tác này đẩy lên server và không hoàn tác được.</>)
                ) : branchAction.force ? (
                  tr(<>⚠ Branch <b>{branchAction.b.name}</b> is <b>not merged</b>. Force delete will lose commits that only exist on this branch.</>, <>⚠ Nhánh <b>{branchAction.b.name}</b> <b>chưa được merge</b>. Xoá ép sẽ mất các commit chỉ có trên nhánh này.</>)
                ) : (
                  tr(<>Delete local branch <b>{branchAction.b.name}</b>?</>, <>Xoá nhánh local <b>{branchAction.b.name}</b>?</>)
                )}
              </div>
              <div className="toolbar">
                <span className="grow" />
                <button onClick={() => setBranchAction(null)}>{tr("Cancel", "Huỷ")}</button>
                <button
                  className="primary danger"
                  onClick={() => doDeleteBranch(branchAction.b, branchAction.force || branchAction.b.remote)}
                >
                  {branchAction.force ? tr("Force delete", "Xoá ép") : tr("Delete", "Xoá")}
                </button>
              </div>
            </div>
          )}
        </Modal>
      )}
      {switchDirty && (
        <Modal title={tr("Uncommitted changes", "Còn thay đổi chưa commit")} width={480} onClose={() => setSwitchDirty(null)}>
          <div className="form account-form">
            <div className="muted small">
              {tr(
                <>Branch <b>{status?.branch}</b> has uncommitted changes, so it can't switch directly to <b>{switchDirty.branch}</b>.
                Do you want to <b>bring these changes along</b> to that branch? (equivalent to stash → switch → re-apply).</>,
                <>Nhánh <b>{status?.branch}</b> đang có thay đổi chưa commit nên không chuyển thẳng sang <b>{switchDirty.branch}</b> được.
                Bạn có muốn <b>mang các thay đổi này theo</b> sang nhánh đó không? (tương đương stash → đổi nhánh → áp lại).</>
              )}
            </div>
            <div className="toolbar">
              <span className="grow" />
              <button onClick={() => setSwitchDirty(null)}>{tr("Cancel", "Huỷ")}</button>
              <button className="primary" onClick={() => doSwitchBring(switchDirty)}>{tr("Bring along & switch", "Mang theo & chuyển")}</button>
            </div>
          </div>
        </Modal>
      )}
      {mergeOpen && (
        <Modal title={tr(`⇄ Merge into ${status?.branch ?? "current branch"}`, `⇄ Merge vào ${status?.branch ?? "nhánh hiện tại"}`)} width={520} onClose={() => setMergeOpen(false)}>
          <div className="form account-form">
            <div className="muted small">
              {tr(
                <>Pick a source branch to merge into <b>{status?.branch}</b>. If there are conflicts, the merge will stop for you to resolve.</>,
                <>Chọn nhánh nguồn để hợp nhất vào <b>{status?.branch}</b>. Nếu có xung đột, merge sẽ dừng để bạn giải quyết.</>
              )}
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
      {loaded && !history.length && <div className="muted small pad">{tr("No commits yet", "Chưa có commit nào")}</div>}
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
                title={tr("Include this file in the commit", "Đưa file này vào commit")}
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
      {lines.length > MAX_DIFF_LINES && <div className="meta">{tr(`… ${lines.length - MAX_DIFF_LINES} more lines (diff too large)`, `… còn ${lines.length - MAX_DIFF_LINES} dòng (diff quá lớn)`)}</div>}
    </div>
  );
});

function ago(unix: number) {
  const s = Math.floor(Date.now() / 1000) - unix;
  if (s < 60) return t("just now", "vừa xong");
  if (s < 3600) return `${Math.floor(s / 60)} ${t("min", "phút")}`;
  if (s < 86400) return `${Math.floor(s / 3600)} ${t("h", "giờ")}`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} ${t("d", "ngày")}`;
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
    const dir = await openDialog({ directory: true, title: t("Pick a folder to hold the repo", "Chọn thư mục chứa repo") });
    if (typeof dir === "string") setParent(dir);
  };

  const clone = async () => {
    if (!url.trim()) return setError(tr("Enter a repo URL", "Nhập URL repo"));
    if (!parent.trim()) return setError(tr("Pick a destination folder", "Chọn thư mục đích"));
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
          {tr("Destination folder", "Thư mục đích")}
          <div className="form-row">
            <input className="grow mono" value={parent} placeholder="vd. D:\projects" onChange={(e) => setParent(e.target.value)} />
            <button onClick={chooseParent}>{tr("Browse…", "Chọn…")}</button>
          </div>
        </label>
        <label>
          {tr("Subfolder name", "Tên thư mục con")}
          <input className="mono" value={folder} placeholder={suggested || tr("auto from URL", "tự lấy từ URL")} onChange={(e) => setFolder(e.target.value)} />
        </label>
        {parent && (folder || suggested) && (
          <div className="muted small mono">→ {parent}\{folder || suggested}</div>
        )}
        <div className="toolbar">
          <button className="primary" disabled={busy} onClick={() => void clone()}>{busy ? tr("Cloning…", "Đang clone…") : "Clone"}</button>
          {busy && <span className="muted small ellipsis progress-text">⏳ {progress}</span>}
        </div>
        {error && <div className="error-box pre">⚠ {error}</div>}
        <div className="muted small">
          {tr(
            <>Private repos show the Git Credential Manager login window. If you've never logged in, open <b>Git account</b> (the ⚙ button in the repo list) to save your account first.</>,
            <>Repo riêng tư sẽ hiện cửa sổ đăng nhập của Git Credential Manager. Chưa đăng nhập bao giờ thì vào <b> Tài khoản Git</b> (nút ⚙ trong danh sách repo) để lưu tài khoản trước.</>
          )}
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
      log(`[git] ${tr("sign out", "đăng xuất")} ${host.trim()}`);
      await loadAccount(host);
    } catch (e) {
      setError(errText(e));
    }
  };

  const saveIdentity = async () => {
    try {
      await git.setIdentity(name, email);
      setSavedIdent(tr("✓ Saved name & email (global)", "✓ Đã lưu tên & email (global)"));
      log(`[git] ${tr("update user.name / user.email", "cập nhật user.name / user.email")}`);
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
    if (!username.trim() || !token) return setCredMsg({ ok: false, text: tr("Username and token are required", "Cần username và token") });
    try {
      const login = await git.storeCredential(host.trim(), username.trim(), token);
      setToken("");
      setCredMsg({ ok: true, text: tr(`✓ Signed in: ${login}`, `✓ Đăng nhập thành công: ${login}`) });
      log(`[git] ${tr("sign in", "đăng nhập")} ${host.trim()} ${tr("as", "với")} ${login}`);
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
        <h3>{tr("Identity (used for commits)", "Danh tính (dùng cho commit)")}</h3>
        <div className="form-row">
          <label className="grow">{tr("Name", "Tên")}<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nguyen Van A" /></label>
          <label className="grow">Email<input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="a@example.com" /></label>
        </div>
        <div className="toolbar">
          <button className="primary" onClick={() => void saveIdentity()}>{tr("Save identity", "Lưu danh tính")}</button>
          {savedIdent && <span className="muted small">{savedIdent}</span>}
        </div>

        <div className="form-sep" />

        <h3>{tr("Sign in (push / pull / clone private repos)", "Đăng nhập (push / pull / clone repo riêng tư)")}</h3>

        {/* Thẻ tài khoản đang đăng nhập cho host hiện tại. */}
        <div className="account-card">
          {accLoading ? (
            <span className="muted small">{tr("Checking", "Đang kiểm tra")} {host}…</span>
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
              <button onClick={() => void signOut()}>{tr("Sign out", "Đăng xuất")}</button>
            </>
          ) : (
            <span className="muted small grow">{tr(<>Not signed in to <b className="mono">{host}</b>. Enter a token below to sign in.</>, <>Chưa đăng nhập với <b className="mono">{host}</b>. Nhập token bên dưới để đăng nhập.</>)}</span>
          )}
          <button className="icon-btn" title={tr("Re-check", "Kiểm tra lại")} onClick={() => void loadAccount(host)}>↻</button>
        </div>

        <div className="muted small">
          {ident?.helper
            ? tr(<>Credential helper: <b className="mono">{ident.helper}</b> — your password/token will be remembered.</>, <>Credential helper: <b className="mono">{ident.helper}</b> — mật khẩu/token sẽ được nhớ.</>)
            : tr(<>⚠ No credential helper enabled, so git won't remember your login. <button className="link" onClick={() => void enableManager()}>Enable Git Credential Manager</button></>, <>⚠ Chưa bật credential helper nên git sẽ không nhớ đăng nhập. <button className="link" onClick={() => void enableManager()}>Bật Git Credential Manager</button></>)}
        </div>
        <div className="form-row">
          <label style={{ width: 180 }}>Host<input className="mono" value={host} onChange={(e) => setHost(e.target.value)} /></label>
          <label className="grow">Username<input value={username} onChange={(e) => setUsername(e.target.value)} placeholder={tr("git username", "tên đăng nhập git")} /></label>
        </div>
        <label>
          Personal Access Token
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={tr("paste token here", "dán token vào đây")} />
        </label>
        {tokenUrl && (
          <div className="muted small">
            {tr("Create a token at:", "Tạo token tại:")} <span className="mono">{tokenUrl}</span> ({tr("scope", "quyền")} <span className="mono">repo</span>). {tr("Use the token instead of a password.", "Dùng token thay mật khẩu.")}
          </div>
        )}
        <div className="toolbar">
          <button className="primary" onClick={() => void saveCredential()}>{account?.signedIn ? tr("Sign in again", "Đăng nhập lại") : tr("Sign in", "Đăng nhập")}</button>
          {credMsg && <span className={credMsg.ok ? "muted small" : "danger-text small"}>{credMsg.text}</span>}
        </div>
        <div className="muted small">
          {tr(
            <>The token is passed straight to <span className="mono">git credential approve</span> and stored by your machine's credential helper (Windows Credential Manager). DevStation never writes the token to any file.</>,
            <>Token được chuyển thẳng cho <span className="mono">git credential approve</span> và lưu bởi credential helper của máy (Windows Credential Manager). DevStation không ghi token ra file nào.</>
          )}
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
          <p className="muted">{tr("Pick a repository to open:", "Chọn một repository để mở:")}</p>
          <div className="empty-repo-list">
            {repos.map((r) => (
              <button key={r.path} className="empty-repo" onClick={() => openRepo(r)} title={r.path}>
                <span className="grow ellipsis">▤ {r.name}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <p className="muted">{tr("No repositories yet.", "Chưa có repository nào.")}</p>
      )}
      <div className="toolbar">
        <button onClick={() => void addRepos().catch(() => {})}>{tr("＋ Add existing repo", "＋ Thêm repo có sẵn")}</button>
        <button className="primary" onClick={openClone}>{tr("⬇ Clone from URL", "⬇ Clone từ URL")}</button>
        <button onClick={openAccount}>{tr("⚙ Git account", "⚙ Tài khoản Git")}</button>
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
        <Modal title={tr("⚙ Git account", "⚙ Tài khoản Git")} width={560} onClose={closeAccount}>
          <AccountView />
        </Modal>
      )}
      {cloneOpen && (
        <Modal title={tr("⬇ Clone repository", "⬇ Clone repository")} width={620} onClose={closeClone}>
          <CloneView onClose={closeClone} />
        </Modal>
      )}
    </>
  );
}

const gitApp: AppModule = {
  View: GitRoot,
  commands: () => [
    { id: "git.add", group: "Git", title: t("Add existing repo", "Thêm repo có sẵn"), run: () => void addRepos().catch(() => {}) },
    { id: "git.clone", group: "Git", title: t("Clone repository from URL", "Clone repository từ URL"), run: openClone },
    { id: "git.account", group: "Git", title: t("Git account (login, identity)", "Tài khoản Git (đăng nhập, danh tính)"), run: openAccount },
    ...useRepos.getState().repos.map((r) => ({
      id: `git.open.${r.path}`,
      group: "Git",
      title: `${t("Open repo:", "Mở repo:")} ${r.name}`,
      run: () => openRepo(r),
    })),
  ],
};

export default gitApp;
