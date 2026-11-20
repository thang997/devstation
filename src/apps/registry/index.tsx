import { renderLog } from "../../shell/renderDebug";
import { copyText } from "../../shell/clipboard";
import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChevronsDown, CircleCheck, Copy, Download, Globe, KeyRound, Lock, LogIn, Package, Pencil, Play, Plug, Plus, RefreshCw, Save, Square, Tag, Trash2, TriangleAlert, X } from "lucide-react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { AppModule, Tab } from "../types";
import { useWorkbench } from "../../store/workbench";
import { TabbedLayout } from "../../shell/TabbedLayout";
import { Modal } from "../../shell/Modal";
import { Picker } from "../../shell/Picker";
import { Loading as SharedLoading } from "../../shell/Loading";
import { ContextMenu, type CtxItem } from "../../shell/ContextMenu";
import { confirmDialog } from "../../shell/confirm";
import { Splitter, useSplitSize } from "../../shell/Resizable";
import { hostOf, newConn, sessionPasswords, useConns, type RegConn } from "./connections";
import { t, useT } from "../../store/lang";

/* ── Kiểu dữ liệu từ Rust (src-tauri/src/registry.rs) ── */
interface RegInfo { user: string; version: string }
interface Page<T> { items: T[]; total: number }
interface RegProject { name: string; public: boolean; repoCount: number }
interface RegRepo { name: string; artifactCount: number; pullCount: number; updateTime: string }
interface RegArtifact { digest: string; size: number; pushTime: string; tags: string[]; platform: string; platforms: string[]; created: string }
interface RegCfg { url: string; user: string; password: string; insecure: boolean }

async function call<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error(t("registry.mustRunInsideTheApp"));
  return invoke<T>(cmd, args);
}
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function human(n: number) {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}
const fmtTime = (s: string) => {
  const d = new Date(s);
  return isNaN(d.getTime()) || d.getFullYear() < 2000 ? "" : d.toLocaleString();
};

function openSession(c: RegConn) {
  useWorkbench.getState().openTab({
    id: `registry:${c.id}`,
    appId: "registry",
    title: c.name,
    payload: { connId: c.id },
    danger: c.env === "prod",
  });
}

/* ── Danh sách lượt tải (store cấp module: chuyển tab không mất) ── */
interface Job {
  job: string;
  label: string;
  dest: string;
  phase: string;
  done: number;
  total: number;
  layersDone: number;
  layersTotal: number;
  error?: string;
  size?: number;
  startedAt: number;
  /** Byte/giây tức thời (phase download/zip). */
  speed?: number;
  /** Đã tải xong vào thư mục tạm, chờ người dùng chọn nơi lưu. */
  pending?: { kind: "tar" | "zip"; files: string[]; name: string; batch?: string; skipped?: number };
}
let jobs: Job[] = [];
const jobSubs = new Set<() => void>();
const setJobs = (f: (j: Job[]) => Job[]) => { jobs = f(jobs); jobSubs.forEach((s) => s()); };
const patchJob = (id: string, p: Partial<Job>) => setJobs((js) => js.map((j) => (j.job === id ? { ...j, ...p } : j)));
function useJobs() {
  return useSyncExternalStore((cb) => { jobSubs.add(cb); return () => { jobSubs.delete(cb); }; }, () => jobs);
}
let listening = false;
function ensureListener() {
  if (listening || !isTauri()) return;
  listening = true;
  void listen<{ job: string; phase: string; done: number; total: number; layersDone: number; layersTotal: number }>("registry-pull", (ev) => {
    const p = ev.payload;
    const cur = jobs.find((j) => j.job === p.job && !j.error && j.phase !== "done" && j.phase !== "unsaved" && j.phase !== "saving");
    if (!cur) return;
    // Tốc độ TỨC THỜI (trung bình trượt giữa hai mẫu ~400ms), không phải trung bình từ lúc bắt đầu.
    const now = Date.now();
    const last = samples.get(p.job);
    let speed = cur.speed ?? 0;
    if (last && p.phase === last.phase && now > last.t) {
      const inst = Math.max(0, p.done - last.done) / ((now - last.t) / 1000);
      speed = speed ? speed * 0.6 + inst * 0.4 : inst;
    } else speed = 0;
    samples.set(p.job, { t: now, done: p.done, phase: p.phase });
    patchJob(p.job, { phase: p.phase, done: p.done, total: p.total, layersDone: p.layersDone, layersTotal: p.layersTotal, speed });
  });
}
const samples = new Map<string, { t: number; done: number; phase: string }>();

const fileNameFor = (repo: string, a: RegArtifact, platform?: string) => {
  const base = repo.split("/").pop() || "image";
  const suffix = a.tags[0] || a.digest.replace("sha256:", "").slice(0, 12);
  return `${base}_${suffix}${platform ? `_${platform.replace(/\//g, "-")}` : ""}.tar`.replace(/[\\/:*?"<>|]/g, "_");
};
const newJobId = () => `j${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const addJob = (job: string, label: string, dest: string, phase = "manifest") =>
  setJobs((js) => [{ job, label, dest, phase, done: 0, total: 0, layersDone: 0, layersTotal: 0, startedAt: Date.now() }, ...js]);

/** Thư mục tạm của app (`%TEMP%/devstation-registry/out`): tải xong mới hỏi nơi lưu. */
let tempDirP: Promise<string> | null = null;
const tempDir = () => (tempDirP ??= call<string>("registry_temp_dir", {}).catch((e) => { tempDirP = null; throw e; }));
const joinPath = (dir: string, ...parts: string[]) => {
  const sep = dir.includes("\\") ? "\\" : "/";
  return [dir.replace(/[\\/]+$/, ""), ...parts].join(sep);
};

/** Chạy registry_pull cho một job đã thêm vào danh sách (ghi vào `dest` trong thư mục tạm). Trả về size hoặc null khi lỗi. */
async function runPull(job: string, cfg: RegCfg, repo: string, a: RegArtifact, platform: string | undefined, dest: string): Promise<number | null> {
  ensureListener();
  const tag = a.tags[0] ?? "";
  const label = `${repo}:${tag || a.digest.slice(0, 19)}${platform ? ` (${platform})` : ""}`;
  patchJob(job, { label, phase: "manifest", startedAt: Date.now() });
  try {
    const size = await call<number>("registry_pull", { cfg, repo, reference: a.digest, tag: tag || null, platform: platform ?? null, dest, job });
    patchJob(job, { phase: "unsaved", size, done: size, total: size });
    return size;
  } catch (e) {
    patchJob(job, { error: errText(e) });
    return null;
  }
}

/** Hỏi nơi lưu cho job đã tải xong (`pending`): .tar → chuyển file; zip → gom các .tar vào file zip đã chọn.
 *  Bấm Huỷ ở hộp thoại → job ở trạng thái "chưa lưu" (nút Lưu… để hỏi lại, ✕ để bỏ file tạm). */
async function saveJob(jobId: string) {
  const j = jobs.find((x) => x.job === jobId);
  const p = j?.pending;
  if (!j || !p) return;
  const isZip = p.kind === "zip";
  const dest = await saveDialog({
    title: t(isZip ? "registry.saveZipAs" : "registry.saveImageAs"),
    defaultPath: p.name,
    filters: isZip ? [{ name: "Zip", extensions: ["zip"] }] : [{ name: "Docker image (docker load)", extensions: ["tar"] }],
  });
  if (typeof dest !== "string") { patchJob(jobId, { phase: "unsaved", error: undefined }); return; }
  ensureListener();
  samples.delete(jobId);
  patchJob(jobId, { phase: isZip ? "zip" : "saving", error: undefined, done: 0, speed: 0, dest });
  try {
    const size = isZip
      ? await call<number>("registry_zip", { files: p.files, dest, job: jobId, cleanup: p.batch })
      : await call<number>("registry_move", { src: p.files[0], dest });
    patchJob(jobId, { phase: "done", size, pending: undefined });
    useWorkbench.getState().log(`✓ ${j.label} → ${dest} (${human(size)})`);
    if (isZip && p.skipped) useWorkbench.getState().log(`⚠ ${t("registry.zipSkipped", { n: p.skipped })}`);
  } catch (e) {
    patchJob(jobId, { phase: "unsaved", error: errText(e) });
  }
}

/** Bỏ job: còn file tạm chưa lưu thì xoá luôn. */
function dismissJob(j: Job) {
  if (j.pending) void call("registry_discard", { paths: j.pending.files }).catch(() => {});
  setJobs((js) => js.filter((x) => x.job !== j.job));
}

async function startDownload(cfg: RegCfg, repo: string, a: RegArtifact, platform?: string) {
  const job = newJobId();
  const name = fileNameFor(repo, a, platform);
  addJob(job, `${repo}:${a.tags[0] || a.digest.slice(0, 19)}`, "");
  let dest: string;
  try { dest = joinPath(await tempDir(), job, name); } catch (e) { patchJob(job, { error: errText(e) }); return; }
  patchJob(job, { dest });
  if ((await runPull(job, cfg, repo, a, platform, dest)) == null) return;
  patchJob(job, { pending: { kind: "tar", files: [dest], name } });
  await saveJob(job);
}

/** Tải image MỚI NHẤT (theo push time) của nhiều repository; chạy tất cả repo song song (mỗi repo 4 layer song song).
 *  Tải hết vào thư mục tạm rồi mới hỏi nơi lưu: 1 repo → .tar, nhiều repo → gom vào MỘT file .zip.
 *  Image multi-arch → nền tảng mặc định linux/amd64 (phía Rust). */
async function startBulkDownload(cfg: RegCfg, repos: string[]) {
  const queue = repos.map((repo) => {
    const job = newJobId();
    addJob(job, repo, "", "queued");
    return { job, repo };
  });
  const ids = queue.map((q) => q.job);
  let batch: string;
  try { batch = joinPath(await tempDir(), newJobId()); } catch (e) { ids.forEach((id) => patchJob(id, { error: errText(e) })); return; }
  const names = new Map<string, string>();
  const worker = async () => {
    for (let it = queue.shift(); it; it = queue.shift()) {
      const { job, repo } = it;
      if (cancelledQueued.delete(job)) continue;
      patchJob(job, { phase: "manifest" });
      try {
        const project = repo.split("/")[0];
        const page = await call<Page<RegArtifact>>("registry_artifacts", { cfg, project, repo, page: 1 });
        const a = page.items[0];
        if (!a) { patchJob(job, { error: t("registry.noArtifactsIn", { repo }) }); continue; }
        // Bấm hủy lúc đang đọc danh sách artifact → không bắt đầu tải.
        if (jobs.find((j) => j.job === job)?.error) continue;
        const name = fileNameFor(repo, a);
        names.set(job, name);
        const dest = joinPath(batch, name);
        patchJob(job, { dest });
        await runPull(job, cfg, repo, a, undefined, dest);
      } catch (e) {
        patchJob(job, { error: errText(e) });
      }
    }
  };
  // Chạy TẤT CẢ repo song song (layer chung chỉ tải một lần nhờ BlobLease phía Rust).
  await Promise.all(queue.map(() => worker()));
  const ok = jobs.filter((j) => ids.includes(j.job) && j.phase === "unsaved" && !j.error);
  if (!ok.length) return;
  if (repos.length === 1) {
    patchJob(ok[0].job, { pending: { kind: "tar", files: [ok[0].dest], name: names.get(ok[0].job) ?? "image.tar" } });
    await saveJob(ok[0].job);
    return;
  }
  const d = new Date(), p2 = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
  const project = repos[0].split("/")[0] || "images";
  const name = `${project}_images_${stamp}.zip`.replace(/[\\/:*?"<>|]/g, "_");
  const zjob = newJobId();
  const size = ok.reduce((n, j) => n + (j.size ?? 0), 0);
  // Các dòng .tar đã tải gộp thành MỘT dòng zip (dòng lỗi giữ lại).
  setJobs((js) => [
    { job: zjob, label: t("registry.zipLabel", { name, n: ok.length }), dest: batch, phase: "unsaved", done: size, total: size, size,
      layersDone: 0, layersTotal: 0, startedAt: Date.now(),
      pending: { kind: "zip", files: ok.map((j) => j.dest), name, batch, skipped: ids.length - ok.length } },
    ...js.filter((j) => !ok.some((o) => o.job === j.job)),
  ]);
  await saveJob(zjob);
}
/** Job còn trong hàng đợi bị bấm hủy (chưa gọi Rust). */
const cancelledQueued = new Set<string>();

/* ── Form kết nối (modal) ── */
let formReq: { connId?: string; seq: number } | null = null;
let formSeq = 0;
const formSubs = new Set<() => void>();
const openForm = (connId?: string) => { formReq = { connId, seq: ++formSeq }; formSubs.forEach((f) => f()); };
const closeForm = () => { formReq = null; formSubs.forEach((f) => f()); };
const useFormReq = () => useSyncExternalStore((cb) => { formSubs.add(cb); return () => { formSubs.delete(cb); }; }, () => formReq);

function ConnForm({ connId, onClose }: { connId?: string; onClose: () => void }) {
  const tr = useT();
  const { conns, save, remove } = useConns();
  const editing = conns.find((c) => c.id === connId);
  const [c, setC] = useState<RegConn>(editing ?? newConn());
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const set = (p: Partial<RegConn>) => setC((x) => ({ ...x, ...p }));

  useEffect(() => {
    // Sửa kết nối: nạp mật khẩu đã lưu để "Kiểm tra" chạy được ngay.
    if (editing) void call<string | null>("registry_get_password", { id: editing.id }).then((p) => { if (p) setPassword(p); }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const test = async () => {
    setStatus({ ok: true, text: tr("registry.testing") });
    try {
      const info = await call<RegInfo>("registry_login", { cfg: { url: c.url, user: c.user, password, insecure: c.insecure } });
      setStatus({ ok: true, text: tr("registry.connectedOk", { version: info.version || "?", user: info.user || tr("registry.anonymous") }) });
    } catch (e) {
      setStatus({ ok: false, text: errText(e) });
    }
  };
  const submit = () => {
    if (!c.name.trim()) return setStatus({ ok: false, text: tr("registry.enterName") });
    if (!/^https?:\/\/.+/.test(c.url.trim())) return setStatus({ ok: false, text: tr("registry.enterUrl") });
    const conn = { ...c, name: c.name.trim(), url: c.url.trim().replace(/\/+$/, ""), user: c.user.trim() };
    save(conn);
    if (password) sessionPasswords.set(conn.id, password);
    if (conn.savePw) { if (password) void call("registry_save_password", { id: conn.id, password }).catch(() => {}); }
    else void call("registry_forget_password", { id: conn.id }).catch(() => {});
    onClose();
    openSession(conn);
  };

  return (
    <Modal title={editing ? tr("registry.editConnection") : tr("registry.newConnection")} width={560} onClose={onClose}>
      <div className="form account-form">
        <label>{tr("registry.name")}<input value={c.name} onChange={(e) => set({ name: e.target.value })} placeholder="Harbor company" autoFocus /></label>
        <label>URL<input className="mono" value={c.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://harbor.example.com" /></label>
        <div className="form-row">
          <label className="grow">{tr("registry.user")}<input className="mono" value={c.user} onChange={(e) => set({ user: e.target.value })} placeholder="admin / robot$ci" /></label>
          <label className="grow">{tr("registry.password")}<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        </div>
        <div className="muted small">{tr("registry.userHint")}</div>
        <label className="check"><input type="checkbox" checked={c.savePw !== false} onChange={(e) => set({ savePw: e.target.checked })} /> {tr("registry.savePassword")}</label>
        <label className="check"><input type="checkbox" checked={c.insecure} onChange={(e) => set({ insecure: e.target.checked })} /> {tr("registry.insecureTls")}</label>
        <div className="field">
          <span className="field-cap">{tr("registry.environment")}</span>
          <div className="picker-field">
            <Picker
              label={<span className="ellipsis">{c.env}</span>}
              items={(["dev", "staging", "prod"] as const).map((x) => ({ id: x, label: x, selected: c.env === x }))}
              onPick={(id) => set({ env: id as RegConn["env"] })}
            />
          </div>
        </div>
        <div className="toolbar">
          <button onClick={() => void test()}><Plug />{tr("registry.testConnection")}</button>
          <span className="grow" />
          {editing && (
            <button className="danger" onClick={() => void confirmDialog({ message: tr("registry.deleteConnectionNamed", { name: c.name }) }).then((ok) => {
              if (!ok) return;
              remove(c.id);
              void call("registry_forget_password", { id: c.id }).catch(() => {});
              onClose();
            })}><Trash2 />{tr("registry.delete")}</button>
          )}
          <button className="primary" onClick={submit}><Save />{tr("registry.saveOpen")}</button>
        </div>
        {status && <div className={status.ok ? "muted" : "error-box"}>{status.text}</div>}
      </div>
    </Modal>
  );
}

function ConnFormHost() {
  const req = useFormReq();
  return req ? <ConnForm key={req.seq} connId={req.connId} onClose={closeForm} /> : null;
}

/* ── Sidebar ── */
function Sidebar() {
  const tr = useT();
  const { conns, remove } = useConns();
  const [sel, setSel] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: CtxItem[] } | null>(null);
  const del = (c: RegConn) => void confirmDialog({ message: tr("registry.deleteConnectionNamed", { name: c.name }) }).then((ok) => {
    if (!ok) return;
    remove(c.id);
    void call("registry_forget_password", { id: c.id }).catch(() => {});
  });
  const rowMenu = (c: RegConn): CtxItem[] => [
    { id: "open", icon: <Play />, label: tr("registry.open"), action: () => openSession(c) },
    { id: "edit", icon: <Pencil />, label: tr("registry.edit"), action: () => openForm(c.id) },
    { id: "forget", icon: <KeyRound />, label: tr("registry.forgetPassword"), action: () => { sessionPasswords.delete(c.id); void call("registry_forget_password", { id: c.id }).catch(() => {}); } },
    { id: "s", sep: true },
    { id: "del", icon: <Trash2 />, label: tr("registry.delete"), danger: true, action: () => del(c) },
  ];
  return (
    <div
      className="side-list fill"
      onContextMenu={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, items: [{ id: "new", icon: <Plus />, label: tr("registry.newConnection"), action: () => openForm() }] }); } }}
    >
      <div className="side-head">
        <span>{tr("registry.connections")}</span>
        <button className="icon-btn" title={tr("registry.newConnection")} onClick={() => openForm()}><Plus /></button>
      </div>
      {conns.map((c) => (
        <div
          key={c.id}
          className={`side-item ${c.env === "prod" ? "prod" : ""} ${sel === c.id ? "sel" : ""}`}
          onClick={() => setSel(c.id)}
          onDoubleClick={() => openSession(c)}
          onContextMenu={(e) => { e.preventDefault(); setSel(c.id); setMenu({ x: e.clientX, y: e.clientY, items: rowMenu(c) }); }}
          title={`${tr("registry.doubleClickToOpen")} · ${c.url}`}
        >
          <span className="grow ellipsis">{c.name}</span>
          <span className={`env-tag ${c.env}`}>{c.env.toUpperCase()}</span>
          <button className="icon-btn small" title={tr("registry.edit")} onClick={(e) => { e.stopPropagation(); openForm(c.id); }}><Pencil /></button>
        </div>
      ))}
      {!conns.length && <div className="muted small pad">{tr("registry.noConnectionsYet")}</div>}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

/* ── Hook danh sách có lọc phía server (debounce) + nạp thêm ── */
function usePaged<T>(fetcher: ((q: string, page: number) => Promise<Page<T>>) | null, deps: unknown[]) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const seq = useRef(0);
  const load = useCallback(async (query: string, p: number) => {
    if (!fetcher) return;
    const my = ++seq.current;
    setLoading(true);
    setErr("");
    try {
      const r = await fetcher(query, p);
      if (my !== seq.current) return;
      setItems((old) => (p === 1 ? r.items : [...old, ...r.items]));
      setTotal(r.total);
      setPage(p);
    } catch (e) {
      if (my === seq.current) { setErr(errText(e)); if (p === 1) setItems([]); }
    } finally {
      if (my === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    setItems([]);
    const h = setTimeout(() => void load(q, 1), q ? 300 : 0);
    return () => clearTimeout(h);
  }, [q, load]);
  return { q, setQ, items, total, loading, err, more: () => void load(q, page + 1), reload: () => void load(q, 1) };
}

/** Đang tải — giống panel SFTP: lần đầu (chưa có dòng nào) thì spinner + chữ ở GIỮA khung; nạp thêm thì một dòng dưới danh sách. */
function Loading({ full }: { full: boolean }) {
  return <SharedLoading variant={full ? "center" : "row"} className={full ? "reg-loading-full" : "reg-loading-more"} />;
}

/* ── Hàng danh sách (memo): gõ ô lọc / tick / chọn dòng chỉ vẽ lại hàng đổi, không vẽ lại cả trăm hàng ── */
const ProjectRow = memo(function ProjectRow({ p, on, onPick }: { p: RegProject; on: boolean; onPick: (name: string) => void }) {
  renderLog("ProjectRow");
  return (
    <div className={`reg-row ${on ? "on" : ""}`} onClick={() => onPick(p.name)}>
      <span title={p.public ? "public" : "private"}>{p.public ? <Globe /> : <Lock />}</span>
      <span className="grow ellipsis">{p.name}</span>
      <span className="muted small">{p.repoCount}</span>
    </div>
  );
});

const RepoRow = memo(function RepoRow({ r, project, on, checked, onPick, onCheck }: {
  r: RegRepo; project: string; on: boolean; checked: boolean;
  onPick: (name: string) => void; onCheck: (name: string, on: boolean) => void;
}) {
  renderLog("RepoRow");
  const tr = useT();
  return (
    <div className={`reg-row ${on ? "on" : ""}`} onClick={() => onPick(r.name)} title={r.name}>
      <input type="checkbox" checked={checked} onClick={(e) => e.stopPropagation()} onChange={(e) => onCheck(r.name, e.target.checked)} />
      <span className="grow ellipsis mono">{r.name.startsWith(`${project}/`) ? r.name.slice(project.length + 1) : r.name}</span>
      <span className="muted small" title={tr("registry.artifactsPulls")}>{r.artifactCount} · <Download />{r.pullCount}</span>
    </div>
  );
});

interface ArtApi {
  download: (a: RegArtifact) => void;
  copyPull: (a: RegArtifact) => void;
  menu: (a: RegArtifact, x: number, y: number) => void;
}
const ArtRow = memo(function ArtRow({ a, api }: { a: RegArtifact; api: { get: () => ArtApi } }) {
  renderLog("ArtRow");
  const tr = useT();
  return (
    <tr onContextMenu={(e) => { e.preventDefault(); api.get().menu(a, e.clientX, e.clientY); }} onDoubleClick={() => api.get().download(a)}>
      <td>{a.tags.length ? a.tags.map((x) => <span key={x} className="reg-tag">{x}</span>) : <span className="muted small">{tr("registry.untagged")}</span>}</td>
      <td className="mono small" title={a.digest}>{a.digest.replace("sha256:", "").slice(0, 12)}</td>
      <td className="small">{a.platform || (a.platforms.length ? a.platforms.join(", ") : "")}</td>
      <td className="small">{human(a.size)}</td>
      <td className="small muted">{fmtTime(a.pushTime)}</td>
      <td className="reg-actions">
        <button className="icon-btn" title={tr("registry.copyPullCmd")} onClick={() => api.get().copyPull(a)}><Copy /></button>
        <button className="primary" title={tr("registry.downloadTarHint")} onClick={() => api.get().download(a)}><Download /></button>
      </td>
    </tr>
  );
});

/** Danh sách lượt tải: component riêng subscribe store jobs → sự kiện tiến trình (dày) chỉ vẽ lại phần này,
 *  không vẽ lại 3 cột Projects/Repositories/Artifacts. Mỗi hàng memo: chỉ job đổi mới vẽ lại. */
function JobsPanel() {
  renderLog("JobsPanel");
  const tr = useT();
  const all = useJobs();
  const shown = all.slice(0, 50);
  if (!shown.length) return null;
  // Tổng tốc độ mọi lượt đang tải: băng thông chia cho các lượt song song, con số này mới là tốc độ thật của đường mạng.
  const active = all.filter((j) => !j.error && j.phase === "download");
  const total = active.reduce((n, j) => n + (j.speed ?? 0), 0);
  return (
    <div className="reg-jobs">
      {active.length > 1 && <div className="muted small reg-jobs-total">{tr("registry.totalSpeed", { n: active.length, speed: `${human(total)}/s` })}</div>}
      {shown.map((j) => <JobRow key={j.job} j={j} />)}
    </div>
  );
}

const JobRow = memo(function JobRow({ j }: { j: Job }) {
  renderLog("JobRow");
  const tr = useT();
  const pct = j.total ? Math.min(100, (j.done / j.total) * 100) : 0;
  const speed = (j.phase === "download" || j.phase === "zip") && j.speed ? `${human(j.speed)}/s` : "";
  const unsaved = j.phase === "unsaved";
  const running = !j.error && j.phase !== "done" && !unsaved;
  const queued = j.phase === "queued";
  return (
    <div className="reg-job">
      <span className="ellipsis reg-job-name" title={j.dest}>{j.error ? <TriangleAlert /> : j.phase === "done" ? <CircleCheck /> : <Download />} {j.label}</span>
      <div className="update-bar grow"><div style={{ width: j.phase === "done" ? "100%" : `${pct}%` }} /></div>
      <span className="muted small reg-job-stat">
        {j.error ? <span style={{ color: "var(--danger)" }} title={j.error}>{j.error}</span>
          : j.phase === "done" ? human(j.size ?? j.total)
          : unsaved ? `${human(j.size ?? j.total)} · ${tr("registry.notSaved")}`
          : j.phase === "saving" ? tr("registry.phaseSaving")
          : queued ? tr("registry.phaseQueued")
          : j.phase === "manifest" ? tr("registry.phaseManifest")
          : j.phase === "pack" ? tr("registry.phasePack")
          : j.phase === "zip" ? `${tr("registry.phaseZip")} ${human(j.done)} / ${human(j.total)}${speed && ` · ${speed}`}`
          : `${human(j.done)} / ${human(j.total)} · ${j.layersDone}/${j.layersTotal} layers ${speed && `· ${speed}`}`}
      </span>
      {running
        ? <button className="icon-btn danger" title={tr("registry.cancel")} onClick={() => {
            if (queued) cancelledQueued.add(j.job);
            else void call("registry_cancel", { job: j.job });
            patchJob(j.job, { error: tr("registry.cancel") });
          }}><Square /></button>
        : <>
            {j.pending && <button className="icon-btn" title={tr("registry.saveAs")} onClick={() => void saveJob(j.job)}><Save /></button>}
            <button className="icon-btn" title={j.pending ? tr("registry.discard") : tr("registry.dismiss")} onClick={() => dismissJob(j)}><X /></button>
          </>}
    </div>
  );
});

/* ── Phiên làm việc với một Harbor ── */
function Session({ tab }: { tab: Tab }) {
  renderLog("Session");
  const tr = useT();
  const connId = String(tab.payload.connId);
  const conn = useConns((s) => s.conns.find((c) => c.id === connId));
  const [cfg, setCfg] = useState<RegCfg | null>(null);
  const [info, setInfo] = useState<RegInfo | null>(null);
  const [connecting, setConnecting] = useState(true);
  const [needPw, setNeedPw] = useState(false);
  const [pwInput, setPwInput] = useState("");
  const [error, setError] = useState("");
  const [project, setProject] = useState<string | null>(null);
  const [repo, setRepo] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: CtxItem[] } | null>(null);
  const [pickPlat, setPickPlat] = useState<RegArtifact | null>(null);
  /** Repository đã tick để tải hàng loạt (tên đầy đủ project/repo, giữ khi đổi project). */
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const toggleCheck = useCallback((name: string, on: boolean) =>
    setChecked((s) => { const n = new Set(s); if (on) n.add(name); else n.delete(name); return n; }), []);
  const pickProject = useCallback((name: string) => { setProject(name); setRepo(null); }, []);
  const artRef = useRef<ArtApi>(null!);
  const [artApi] = useState(() => ({ get: () => artRef.current }));
  const [projW, setProjW] = useSplitSize("registry-projects", 240, 160, 480);
  const [repoW, setRepoW] = useSplitSize("registry-repos", 320, 200, 640);

  const login = useCallback(async (password: string) => {
    if (!conn) return;
    const c: RegCfg = { url: conn.url, user: conn.user, password, insecure: conn.insecure };
    setConnecting(true);
    setError("");
    try {
      const i = await call<RegInfo>("registry_login", { cfg: c });
      sessionPasswords.set(conn.id, password);
      setCfg(c);
      setInfo(i);
      setNeedPw(false);
    } catch (e) {
      const m = errText(e);
      if (m.includes("401") && conn.user) { setNeedPw(true); setError(m); }
      else setError(m);
    } finally {
      setConnecting(false);
    }
  }, [conn]);

  useEffect(() => {
    if (!conn) return;
    (async () => {
      let pw = sessionPasswords.get(conn.id) ?? "";
      if (!pw && conn.user) pw = (await call<string | null>("registry_get_password", { id: conn.id }).catch(() => null)) ?? "";
      if (!pw && conn.user && conn.savePw === false) { setConnecting(false); setNeedPw(true); return; }
      await login(pw);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn?.id]);

  const projects = usePaged<RegProject>(
    cfg ? (q, p) => call<Page<RegProject>>("registry_projects", { cfg, q, page: p }) : null,
    [cfg],
  );
  const repos = usePaged<RegRepo>(
    cfg && project ? (q, p) => call<Page<RegRepo>>("registry_repos", { cfg, project, q, page: p }) : null,
    [cfg, project],
  );
  const arts = usePaged<RegArtifact>(
    cfg && project && repo ? (_q, p) => call<Page<RegArtifact>>("registry_artifacts", { cfg, project, repo, page: p }) : null,
    [cfg, project, repo],
  );

  if (!conn) return <div className="empty">{tr("registry.connectionDeleted")}</div>;
  const host = hostOf(conn.url);
  const pullCmd = (a: RegArtifact) => `docker pull ${host}/${repo}${a.tags[0] ? `:${a.tags[0]}` : `@${a.digest}`}`;
  const download = (a: RegArtifact) => {
    if (!cfg || !repo) return;
    if (a.platforms.length > 1) setPickPlat(a);
    else void startDownload(cfg, repo, a, a.platforms[0]);
  };
  const artMenu = (a: RegArtifact): CtxItem[] => [
    { id: "dl", icon: <Download />, label: tr("registry.downloadTar"), action: () => download(a) },
    { id: "s", sep: true },
    { id: "pull", icon: <Copy />, label: tr("registry.copyPullCmd"), action: () => void copyText(pullCmd(a)) },
    { id: "digest", icon: "#", label: tr("registry.copyDigest"), action: () => void copyText(a.digest) },
    ...(a.tags.length ? [{ id: "tag", icon: <Tag />, label: tr("registry.copyImageRef"), action: () => void copyText(`${host}/${repo}:${a.tags[0]}`) }] : []),
  ];
  // Hàng artifact memo: hàm mới mỗi render đi qua ref (object `artApi` giữ nguyên) để không phá memo.
  artRef.current = { download, copyPull: (a) => void copyText(pullCmd(a)), menu: (a, x, y) => setMenu({ x, y, items: artMenu(a) }) };

  if (connecting) return <SharedLoading label={<>{tr("registry.connecting")} <span className="mono">{host}</span>…</>} />;
  if (!cfg) {
    return (
      <div className="pad">
        {error && <div className="error-box pre">{error}</div>}
        <div className="toolbar"><button onClick={() => void login(sessionPasswords.get(conn.id) ?? "")}><RefreshCw />{tr("registry.retry")}</button><button onClick={() => openForm(conn.id)}><Pencil />{tr("registry.edit")}</button></div>
        {needPw && (
          <Modal title={tr("registry.enterPasswordFor", { user: conn.user, host })} width={420} onClose={() => setNeedPw(false)}>
            <div className="form">
              <input type="password" autoFocus value={pwInput} onChange={(e) => setPwInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void login(pwInput); }} />
              <div className="toolbar"><span className="grow" /><button className="primary" onClick={() => void login(pwInput)}><LogIn />{tr("registry.login")}</button></div>
            </div>
          </Modal>
        )}
      </div>
    );
  }

  return (
    <div className="reg-session">
      <div className="toolbar reg-top">
        <span className="mono ellipsis">{host}</span>
        <span className="muted small">{info?.user ? `· ${info.user}` : `· ${tr("registry.anonymous")}`}{info?.version ? ` · Harbor ${info.version}` : ""}</span>
        <span className="grow" />
        <button className="icon-btn" title={tr("registry.refresh")} onClick={() => { projects.reload(); repos.reload(); arts.reload(); }}><RefreshCw /></button>
      </div>
      <div className="reg-body">
        {/* Projects */}
        <div className="reg-pane" style={{ width: projW }}>
          <div className="pane-title">Projects <span className="muted small">{projects.total || ""}</span></div>
          <div className="side-search-row"><input className="side-search" placeholder={tr("registry.filter")} value={projects.q} onChange={(e) => projects.setQ(e.target.value)} /></div>
          <div className="reg-list">
            {projects.items.map((p) => (
              <ProjectRow key={p.name} p={p} on={project === p.name} onPick={pickProject} />
            ))}
            {projects.loading && <Loading full={!projects.items.length} />}
            {projects.err && <div className="error-box small">{projects.err}</div>}
            {!projects.loading && projects.items.length < projects.total && <button className="rkey-more" onClick={projects.more}><ChevronsDown />{tr("registry.loadMore")}</button>}
            {!projects.loading && !projects.err && !projects.items.length && <div className="muted small pad">{tr("registry.nothingFound")}</div>}
          </div>
        </div>
        <Splitter axis="x" live="prev" min={160} max={480} onResize={(d) => setProjW((w) => w + d)} onReset={() => setProjW(240)} />
        {/* Repositories */}
        <div className="reg-pane" style={{ width: repoW }}>
          <div className="pane-title reg-repo-title">
            {project && repos.items.length > 0 && (() => {
              const n = repos.items.filter((r) => checked.has(r.name)).length;
              return (
                <input
                  type="checkbox"
                  title={tr("registry.selectAllRepos")}
                  checked={n > 0 && n === repos.items.length}
                  ref={(el) => { if (el) el.indeterminate = n > 0 && n < repos.items.length; }}
                  onChange={(e) => setChecked((s) => {
                    const next = new Set(s);
                    repos.items.forEach((r) => (e.target.checked ? next.add(r.name) : next.delete(r.name)));
                    return next;
                  })}
                />
              );
            })()}
            <span>Repositories</span> <span className="muted small">{project ? repos.total || "" : ""}</span>
            <span className="grow" />
            {checked.size > 0 && (
              <>
                <button className="icon-btn small" title={tr("registry.clearSelection")} onClick={() => setChecked(new Set())}><X /></button>
                <button
                  className="primary reg-bulk"
                  title={`${tr("registry.downloadSelectedHint")}\n${[...checked].join("\n")}`}
                  onClick={() => { const list = [...checked]; setChecked(new Set()); void startBulkDownload(cfg, list); }}
                ><Download /> {tr("registry.downloadSelected", { n: checked.size })}</button>
              </>
            )}
          </div>
          {project ? (
            <>
              <div className="side-search-row"><input className="side-search" placeholder={tr("registry.filter")} value={repos.q} onChange={(e) => repos.setQ(e.target.value)} /></div>
              <div className="reg-list">
                {repos.items.map((r) => (
                  <RepoRow key={r.name} r={r} project={project} on={repo === r.name} checked={checked.has(r.name)} onPick={setRepo} onCheck={toggleCheck} />
                ))}
                {repos.loading && <Loading full={!repos.items.length} />}
                {repos.err && <div className="error-box small">{repos.err}</div>}
                {!repos.loading && repos.items.length < repos.total && <button className="rkey-more" onClick={repos.more}><ChevronsDown />{tr("registry.loadMore")}</button>}
                {!repos.loading && !repos.err && !repos.items.length && <div className="muted small pad">{tr("registry.nothingFound")}</div>}
              </div>
            </>
          ) : <div className="empty">{tr("registry.pickProject")}</div>}
        </div>
        <Splitter axis="x" live="prev" min={200} max={640} onResize={(d) => setRepoW((w) => w + d)} onReset={() => setRepoW(320)} />
        {/* Artifacts */}
        <div className="reg-pane grow">
          <div className="pane-title ellipsis">{repo ? <span className="mono">{repo}</span> : "Artifacts"} {repo && <span className="muted small">{arts.total || ""}</span>}</div>
          {repo ? (
            <div className="reg-list">
              {!(arts.loading && !arts.items.length) && <table className="grid reg-grid">
                <thead><tr><th>Tags</th><th>Digest</th><th>{tr("registry.platform")}</th><th>{tr("registry.size")}</th><th>{tr("registry.pushed")}</th><th /></tr></thead>
                <tbody>
                  {arts.items.map((a) => <ArtRow key={a.digest} a={a} api={artApi} />)}
                </tbody>
              </table>}
              {arts.loading && <Loading full={!arts.items.length} />}
              {arts.err && <div className="error-box small">{arts.err}</div>}
              {!arts.loading && arts.items.length < arts.total && <button className="rkey-more" onClick={arts.more}><ChevronsDown />{tr("registry.loadMore")}</button>}
              {!arts.loading && !arts.err && !arts.items.length && <div className="muted small pad">{tr("registry.nothingFound")}</div>}
            </div>
          ) : <div className="empty">{tr("registry.pickRepo")}</div>}
        </div>
      </div>

      <JobsPanel />

      {pickPlat && cfg && repo && (
        <Modal title={tr("registry.pickPlatform")} width={420} onClose={() => setPickPlat(null)}>
          <div className="form">
            <div className="muted small">{tr("registry.multiArchHint")}</div>
            {pickPlat.platforms.map((p) => (
              <button key={p} className={p === "linux/amd64" ? "primary" : ""} onClick={() => { const a = pickPlat; setPickPlat(null); void startDownload(cfg, repo, a, p); }}>{p}</button>
            ))}
          </div>
        </Modal>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

const registryApp: AppModule = {
  View: () => (
    <>
      <TabbedLayout
        appId="registry"
        Sidebar={Sidebar}
        TabView={Session}
        empty={
          <div className="welcome">
            <h1><Package /> Registry</h1>
            <p className="muted">{t("registry.welcome")}</p>
            <button className="primary" onClick={() => openForm()}><Plus /> {t("registry.newConnection")}</button>
          </div>
        }
      />
      <ConnFormHost />
    </>
  ),
  commands: () => [
    { id: "registry.new", group: "Registry", title: t("registry.newConnection"), run: () => openForm() },
    ...useConns.getState().conns.map((c) => ({ id: `registry.open.${c.id}`, group: "Registry", title: `${t("registry.open")} ${c.name}`, run: () => openSession(c) })),
  ],
};

export default registryApp;
