import { Swap } from "../../shell/Swap";
import { copyText } from "../../shell/clipboard";
import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowUp, Check, Container, Copy, CornerLeftUp, Database, Disc, Download, Eye, File, FileArchive, FileAudio,
  FileCode, FileCog, FileImage, FilePlus, FileSpreadsheet, FileText, FileVideo, Folder, FolderOpen, FolderPlus,
  GitBranch, Globe, Hammer, KeyRound, Link, Lock, Package, Pencil, Plus, Presentation, RefreshCw, Save, Trash2, TriangleAlert, Upload, X,
  type LucideIcon,
} from "lucide-react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Modal } from "../../shell/Modal";
import { ContextMenu, type CtxItem } from "../../shell/ContextMenu";
import { confirmDialog } from "../../shell/confirm";
import { listNav, rowKey } from "../../shell/listNav";
import { useT } from "../../store/lang";
import { Loading, Spinner } from "../../shell/Loading";
import { sftp, errText, isPermDenied, sudoFs, type FsDriver, type SftpCfg, type SftpEntry, type SftpPreview } from "./api";

/** Chặn preview ở ~2MB — file lớn hơn chỉ cho Download. */
const PREVIEW_MAX = 2 * 1024 * 1024;

function human(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}

function joinPath(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir.replace(/\/+$/, "")}/${name}`;
}
function parentPath(p: string): string {
  const t = p.replace(/\/+$/, "");
  if (t === "" || !t.includes("/")) return "/";
  const i = t.lastIndexOf("/");
  return i <= 0 ? "/" : t.slice(0, i);
}
function baseName(local: string): string {
  return local.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? local;
}
/** Giá trị đặc biệt: hiện chip thay cho emoji (terminal `>_`, Excel). */
const TERM_GLYPH = "\u0000term";
const XLS_GLYPH = "\u0000xls";

/** Nhóm loại file → icon lucide + màu (class `.sftp-ic.k-<nhóm>`). */
type FileKind =
  | "dir" | "link" | "image" | "video" | "audio" | "archive" | "pdf" | "doc" | "sheet" | "slide" | "text"
  | "config" | "code" | "db" | "web" | "disk" | "key" | "lock" | "docker" | "make" | "git" | "file";

const KIND_ICON: Record<FileKind, LucideIcon> = {
  dir: Folder, link: Link, image: FileImage, video: FileVideo, audio: FileAudio, archive: FileArchive,
  pdf: FileText, doc: FileText, sheet: FileSpreadsheet, slide: Presentation, text: FileText, config: FileCog,
  code: FileCode, db: Database, web: Globe, disk: Disc, key: KeyRound, lock: Lock, docker: Container,
  make: Hammer, git: GitBranch, file: File,
};

const byExt = (kind: FileKind | typeof TERM_GLYPH | typeof XLS_GLYPH, exts: string) =>
  Object.fromEntries(exts.split(" ").map((x) => [x, kind]));

/** Loại file theo đuôi. */
const EXT_ICON: Record<string, FileKind | typeof TERM_GLYPH | typeof XLS_GLYPH> = {
  ...byExt("image", "png jpg jpeg gif bmp webp svg ico tif tiff"),
  ...byExt("video", "mp4 mkv avi mov webm flv"),
  ...byExt("audio", "mp3 wav flac ogg m4a aac"),
  ...byExt("archive", "zip tar gz tgz bz2 xz zst 7z rar"),
  ...byExt("archive", "deb rpm apk jar war"),
  ...byExt("pdf", "pdf"),
  ...byExt("doc", "doc docx odt"),
  // Excel: chip vuông xanh chữ "X" (xem FileIcon)
  ...byExt(XLS_GLYPH, "xls xlsx xlsm"),
  ...byExt("sheet", "csv ods"),
  ...byExt("slide", "ppt pptx"),
  ...byExt("text", "md markdown txt log rst adoc"),
  ...byExt("config", "json jsonc yaml yml toml ini cfg conf config properties env xml"),
  ...byExt("code", "js jsx mjs cjs ts tsx py rs go rb php java class kt c h cpp cc cxx hpp cs"),
  // Script shell: chip `>_` kiểu terminal (giống Termius) — xem class `.sftp-ic.term`.
  ...byExt(TERM_GLYPH, "sh bash zsh fish ps1 bat cmd"),
  ...byExt("db", "sql db sqlite sqlite3"),
  ...byExt("web", "html htm css scss sass less vue svelte"),
  ...byExt("disk", "so iso img dmg"),
  ...byExt("key", "pem key pub ppk crt cer p12 pfx"),
  ...byExt("lock", "lock"),
};
// Gói phần mềm dùng icon hộp riêng (khác file nén).
const PACKAGE_EXT = new Set(["deb", "rpm", "apk", "jar", "war"]);

/** Ô icon của một hàng file: icon lucide theo loại, hoặc chip `>_` cho file script. */
function FileIcon({ entry }: { entry: SftpEntry }): ReactNode {
  const ic = fileIcon(entry);
  if (ic === TERM_GLYPH) return <span className="sftp-ic term">&gt;_</span>;
  if (ic === XLS_GLYPH) return <span className="sftp-ic xls">X</span>;
  const name = entry.name.toLowerCase();
  const Ic = ic === "archive" && PACKAGE_EXT.has(name.slice(name.lastIndexOf(".") + 1)) ? Package : KIND_ICON[ic];
  return <span className={`sftp-ic k-${ic}`}><Ic /></span>;
}

/** Loại icon cho một mục trong danh sách file. */
function fileIcon(e: SftpEntry): FileKind | typeof TERM_GLYPH | typeof XLS_GLYPH {
  if (e.kind === "dir") return "dir";
  if (e.kind === "link") return "link";
  const name = e.name.toLowerCase();
  // Vài tên file đặc biệt không dựa vào đuôi.
  if (name === "dockerfile" || name.startsWith("docker-compose")) return "docker";
  if (name === "makefile" || name === "cmakelists.txt") return "make";
  if (name === ".gitignore" || name === ".gitattributes" || name === ".gitmodules") return "git";
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1) : "";
  return EXT_ICON[ext] ?? "file";
}

/** Chuẩn hoá path remote tuyệt đối: gộp `.`/`..`, bỏ `//`. */
function normalize(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { parts.pop(); continue; }
    parts.push(seg);
  }
  return "/" + parts.join("/");
}

/** Hành động của một hàng file — truyền qua ref ổn định để `SftpRow` (memo) không vẽ lại khi panel đổi state
 *  (chọn, gõ đường dẫn, busy, preview…). Thư mục hàng nghìn mục chỉ vẽ lại hàng đổi `sel`. */
interface SftpRowApi {
  select: (name: string) => void;
  /** `kbd`: mở bằng bàn phím (Enter) → sau khi tải xong focus hàng đầu. */
  open: (e: SftpEntry, kbd?: boolean) => void;
  rename: (name: string) => void;
  menu: (ev: React.MouseEvent, e: SftpEntry) => void;
  /** Backspace: lên thư mục cha (`kbd` → focus lại hàng thư mục vừa rời). */
  up: (kbd?: boolean) => void;
  /** Delete: xoá (có hỏi xác nhận). */
  del: (e: SftpEntry) => void;
}

const SftpRow = memo(function SftpRow({ e, sel, api }: { e: SftpEntry; sel: boolean; api: { current: SftpRowApi } }) {
  return (
    <div
      className={`sftp-row ${sel ? "sel" : ""}`}
      tabIndex={0}
      data-name={e.name}
      title={`${e.perms}${e.linkTarget ? ` → ${e.linkTarget}` : ""}`}
      onClick={() => api.current.select(e.name)}
      onDoubleClick={() => api.current.open(e)}
      onKeyDown={(ev) => rowKey(ev, {
        Enter: () => api.current.open(e, true),
        F2: () => api.current.rename(e.name),
        Delete: () => api.current.del(e),
        Backspace: () => api.current.up(true),
      })}
      onContextMenu={(ev) => api.current.menu(ev, e)}
    >
      <FileIcon entry={e} />
      <span className="grow ellipsis">{e.name}</span>
      <span className="muted small sftp-size">{e.kind === "dir" ? "" : human(e.size)}</span>
      <span className="muted small sftp-time ellipsis">{e.mtime}</span>
    </div>
  );
});

/** Panel SFTP: duyệt file remote + preview, kiểu MobaXterm. Mở phiên sftp.exe riêng cho tab.
 * `followCd`: khi người dùng gõ `cd` ở terminal, panel đi theo (resolve tương đối theo cwd hiện tại).
 * memo: tab cha vẽ lại (trạng thái terminal…) không vẽ lại danh sách file. */
export const SftpPanel = memo(function SftpPanel({
  cfg,
  followCd,
  driver,
  title,
  noUpload = false,
}: {
  cfg: SftpCfg;
  followCd?: { arg: string; seq: number } | null;
  /** Nguồn file: mặc định sftp host; truyền `dockerFs(...)` để duyệt trong container. */
  driver?: FsDriver;
  /** Nhãn tiêu đề panel (mặc định "Files"). */
  title?: ReactNode;
  /** Ẩn nút upload (container chưa hỗ trợ upload). */
  noUpload?: boolean;
}) {
  const tr = useT();
  const drv = driver ?? sftp;
  // ── Thư mục cần quyền root: phiên SFTP chạy bằng user SSH (không phải root như terminal đã `sudo`) → "Permission denied".
  //    Hỏi một lần cho mỗi phiên panel rồi làm lại bằng sudo (lệnh ssh một-lần, tự điền mật khẩu SSH đã lưu). Chỉ host — container dùng docker exec.
  const sudoOk = useRef(false);
  const viaSudo = async (path: string, normal: () => Promise<void>, sudo: () => Promise<void>) => {
    try {
      await normal();
    } catch (er) {
      if (driver || !isPermDenied(er)) throw er;
      if (!sudoOk.current) {
        const ok = await confirmDialog({
          title: tr("ssh.sudoTitle"),
          message: tr("ssh.sudoAsk", { path, user: cfg.user }),
          confirmLabel: tr("ssh.sudoRetry"),
          danger: false,
        });
        if (!ok) throw new Error(tr("ssh.sftpNoPermission", { path, user: cfg.user }));
        sudoOk.current = true;
      }
      await sudo();
    }
  };
  /** File tạm trên /tmp (user SSH ghi được) để sudo chép vào chỗ cần quyền root. */
  const tmpPath = (name: string) => `/tmp/.ds-up-${Date.now().toString(36)}-${name.replace(/[^\w.-]/g, "_")}`;
  const [sid, setSid] = useState<string | null>(null);
  const [opening, setOpening] = useState(true);
  const [openErr, setOpenErr] = useState("");
  const [cwd, setCwd] = useState("/");
  const [pathEdit, setPathEdit] = useState("/");
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: CtxItem[] } | null>(null);
  const [preview, setPreview] = useState<{ e: SftpEntry; p: SftpPreview } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [mkOpen, setMkOpen] = useState(false);
  const [mkName, setMkName] = useState("");
  // Tạo file mới: lưu thư mục đích (mặc định cwd; chuột phải folder thì là folder đó) + tên.
  const [mkFileDir, setMkFileDir] = useState<string | null>(null);
  const [mkFileName, setMkFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const homeRef = useRef("/");
  const cwdRef = useRef("/");
  cwdRef.current = cwd;
  const listRef = useRef<HTMLDivElement>(null);
  /** Điều hướng bằng bàn phím đang chờ tải xong: `path` đích + tên hàng cần focus (null = hàng đầu).
   *  Chỉ áp dụng khi load xong đúng `path` → chuột / cd ở terminal không bị cướp focus. */
  const kbdNav = useRef<{ path: string; focus: string | null } | null>(null);

  /** Mở phiên sftp một lần cho tab (cfg cố định theo tab). */
  const openSession = useCallback(() => {
    let alive = true;
    let myId: string | null = null;
    setOpening(true);
    setOpenErr("");
    (async () => {
      try {
        const id = await drv.open(cfg);
        if (!alive) {
          void drv.close(id);
          return;
        }
        myId = id;
        setSid(id);
        const home = (await drv.home(id).catch(() => "/")) || "/";
        if (!alive) return;
        homeRef.current = home;
        setCwd(home);
        setPathEdit(home);
      } catch (e) {
        if (alive) setOpenErr(errText(e));
      } finally {
        if (alive) setOpening(false);
      }
    })();
    return () => {
      alive = false;
      if (myId) void drv.close(myId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => openSession(), [openSession]);

  const load = useCallback(async (id: string, path: string) => {
    setLoading(true);
    setErr("");
    try {
      setEntries(await drv.list(id, path));
    } catch (e) {
      setErr(errText(e));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (sid) void load(sid, cwd);
    setPathEdit(cwd);
    setSel(null);
  }, [sid, cwd, load]);

  const go = (path: string) => setCwd(path || "/");

  // Tải xong sau khi điều hướng bằng bàn phím → focus hàng đầu / hàng thư mục vừa rời (thư mục rỗng → focus khung).
  useEffect(() => {
    const nav = kbdNav.current;
    if (loading || !nav || nav.path !== cwd) return;
    kbdNav.current = null;
    const list = listRef.current;
    if (!list) return;
    const rows = Array.from(list.querySelectorAll<HTMLElement>(".sftp-row[data-name]"));
    const row = (nav.focus != null && rows.find((r) => r.dataset.name === nav.focus)) || rows[0];
    if (row) {
      row.focus();
      row.scrollIntoView({ block: "nearest" });
      setSel(row.dataset.name ?? null);
    } else list.focus();
  }, [loading, cwd]);

  // Đi theo lệnh `cd` gõ ở terminal. Để phiên sftp tự resolve + kiểm tra (đúng cả path tương đối/symlink);
  // chỉ điều hướng khi thư mục hợp lệ, cd sai thì bỏ qua (không nhảy, không báo lỗi).
  const lastCd = useRef(0);
  useEffect(() => {
    if (!sid || !followCd || followCd.seq === lastCd.current) return;
    lastCd.current = followCd.seq;
    const seq = followCd.seq;
    const raw = followCd.arg.trim();
    if (raw === "-") return; // thư mục trước — không suy ra được
    // Tự giãn `~` sang path tuyệt đối (sftp không nở ~); phần còn lại để sftp resolve theo cwd hiện tại.
    const arg = raw === "" || raw === "~"
      ? homeRef.current
      : raw.startsWith("~/")
        ? normalize(`${homeRef.current}/${raw.slice(2)}`)
        : raw;
    (async () => {
      try {
        const target = await drv.cd(sid, cwdRef.current, arg);
        if (lastCd.current === seq) go(target); // bỏ nếu đã có cd mới hơn
      } catch {
        /* thư mục không hợp lệ → không điều hướng */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid, followCd?.seq]);

  const doPreview = async (e: SftpEntry) => {
    if (!sid) return;
    setBusy(true);
    try {
      const p = await drv.read(sid, joinPath(cwd, e.name), PREVIEW_MAX);
      setPreview({ e, p });
    } catch (er) {
      setErr(errText(er));
    } finally {
      setBusy(false);
    }
  };

  /** Link: thử coi là thư mục (list được thì vào), không thì preview như file. */
  const openLink = async (e: SftpEntry) => {
    if (!sid) return;
    const path = joinPath(cwd, e.name);
    try {
      await drv.list(sid, path);
      go(path);
    } catch {
      void doPreview(e);
    }
  };

  const openEntry = (e: SftpEntry, kbd = false) => {
    if (kbd && e.kind !== "file") kbdNav.current = { path: joinPath(cwd, e.name), focus: null };
    if (e.kind === "dir") go(joinPath(cwd, e.name));
    else if (e.kind === "link") void openLink(e);
    else void doPreview(e);
  };

  /** Tải về: file → chọn tên file (save dialog); thư mục → chọn thư mục cha rồi `get -r`. */
  const download = async (e: SftpEntry) => {
    if (!sid) return;
    const isDir = e.kind === "dir";
    const local = isDir
      ? await openDialog({ directory: true, title: tr("ssh.downloadFolderInto", { name: e.name }) })
      : await saveDialog({ defaultPath: e.name });
    if (typeof local !== "string") return;
    setBusy(true);
    try {
      await drv.get(sid, joinPath(cwd, e.name), local, isDir);
    } catch (er) {
      setErr(errText(er));
    } finally {
      setBusy(false);
    }
  };

  const upload = async () => {
    if (!sid) return;
    const local = await openDialog({ multiple: false });
    if (typeof local !== "string") return;
    setBusy(true);
    try {
      const dest = joinPath(cwd, baseName(local));
      await viaSudo(dest, () => drv.put(sid, local, dest), async () => {
        const tmp = tmpPath(baseName(local));
        await drv.put(sid, local, tmp);
        await sudoFs(cfg, "install", tmp, dest);
      });
      await load(sid, cwd);
    } catch (er) {
      setErr(errText(er));
    } finally {
      setBusy(false);
    }
  };

  const del = async (e: SftpEntry) => {
    if (!sid) return;
    const ok = await confirmDialog({
      message: e.kind === "dir"
        ? tr("ssh.deleteFolderMustBeEmpty", { name: e.name })
        : tr("ssh.deleteThisCannotBeUndone", { name: e.name }),
    });
    if (!ok) return;
    setBusy(true);
    try {
      const path = joinPath(cwd, e.name);
      await viaSudo(path, () => (e.kind === "dir" ? drv.rmdir(sid, path) : drv.rm(sid, path)), () => sudoFs(cfg, e.kind === "dir" ? "rmdir" : "rm", path));
      await load(sid, cwd);
    } catch (er) {
      setErr(errText(er));
    } finally {
      setBusy(false);
    }
  };

  const doRename = async (e: SftpEntry, name: string) => {
    setRenaming(null);
    const nm = name.trim();
    if (!sid || !nm || nm === e.name) return;
    setBusy(true);
    try {
      const from = joinPath(cwd, e.name);
      const to = joinPath(cwd, nm);
      await viaSudo(from, () => drv.rename(sid, from, to), () => sudoFs(cfg, "rename", from, to));
      await load(sid, cwd);
    } catch (er) {
      setErr(errText(er));
    } finally {
      setBusy(false);
    }
  };

  const doMkdir = async () => {
    const nm = mkName.trim();
    setMkOpen(false);
    setMkName("");
    if (!sid || !nm) return;
    setBusy(true);
    try {
      const path = joinPath(cwd, nm);
      await viaSudo(path, () => drv.mkdir(sid, path), () => sudoFs(cfg, "mkdir", path));
      await load(sid, cwd);
    } catch (er) {
      setErr(errText(er));
    } finally {
      setBusy(false);
    }
  };

  /** Tạo file rỗng trong `mkFileDir`. Nếu file tạo trong cwd thì refresh để thấy ngay. */
  const doMkFile = async () => {
    const dir = mkFileDir;
    const nm = mkFileName.trim();
    setMkFileDir(null);
    setMkFileName("");
    if (!sid || dir === null || !nm) return;
    setBusy(true);
    try {
      const path = joinPath(dir, nm);
      await viaSudo(path, () => drv.touch(sid, path), () => sudoFs(cfg, "touch", path));
      if (dir === cwd) await load(sid, cwd);
    } catch (er) {
      setErr(errText(er));
    } finally {
      setBusy(false);
    }
  };

  const entryMenu = (e: SftpEntry): CtxItem[] => [
    ...(e.kind !== "dir"
      ? [
          { id: "preview", icon: <Eye />, label: tr("ssh.preview"), action: () => void doPreview(e) },
          { id: "dl", icon: <Download />, label: tr("ssh.download"), action: () => void download(e) },
        ]
      : [
          { id: "open", icon: <FolderOpen />, label: tr("ssh.open"), action: () => openEntry(e) },
          { id: "newfile", icon: <FilePlus />, label: tr("ssh.newFileHere"), action: () => { setMkFileDir(joinPath(cwd, e.name)); setMkFileName(""); } },
          { id: "dl", icon: <Download />, label: tr("ssh.downloadFolderRecursive"), action: () => void download(e) },
        ]),
    { id: "rename", icon: <Pencil />, label: tr("ssh.renameF2"), action: () => setRenaming(e.name) },
    { id: "copy", icon: <Copy />, label: tr("ssh.copyPath"), action: () => void copyText(joinPath(cwd, e.name)) },
    { id: "s1", sep: true },
    { id: "del", icon: <Trash2 />, label: tr("ssh.delete"), danger: true, action: () => void del(e) },
  ];

  /** Menu chuột phải vùng trống (không trúng file/folder): thao tác trên thư mục hiện tại. */
  const emptyMenu = (): CtxItem[] => [
    { id: "newfile", icon: <FilePlus />, label: tr("ssh.newFile"), action: () => { setMkFileDir(cwd); setMkFileName(""); } },
    { id: "newdir", icon: <FolderPlus />, label: tr("ssh.newFolder2"), action: () => { setMkName(""); setMkOpen(true); } },
    { id: "reload", icon: <RefreshCw />, label: tr("ssh.reload"), action: () => sid && void load(sid, cwd) },
    ...(!noUpload
      ? [{ id: "upload", icon: <Upload />, label: tr("ssh.uploadToCurrentFolder"), action: () => void upload() }]
      : []),
  ];

  // Ref ổn định cho SftpRow (memo) — nội dung cập nhật mỗi lần vẽ; menu dựng lúc chuột phải.
  const rowApi = useRef<SftpRowApi>(null as unknown as SftpRowApi);
  rowApi.current = {
    select: setSel,
    open: openEntry,
    rename: setRenaming,
    menu: (ev, e) => { ev.preventDefault(); ev.stopPropagation(); setSel(e.name); setMenu({ x: ev.clientX, y: ev.clientY, items: entryMenu(e) }); },
    up: (kbd) => {
      if (cwd === "/") return;
      const parent = parentPath(cwd);
      if (kbd) kbdNav.current = { path: parent, focus: baseName(cwd) };
      go(parent);
    },
    del: (e) => void del(e),
  };

  /** Mục đang chọn (để nút tải xuống trên toolbar tác động đúng). */
  const selEntry = sel ? entries.find((e) => e.name === sel) ?? null : null;

  if (opening) {
    return (
      <div className="sftp-panel">
        <Loading label={tr("ssh.connectingSftp")} />
      </div>
    );
  }
  if (openErr) {
    return (
      <div className="sftp-panel">
        <div className="sftp-center col">
          <div className="error-box pre"><TriangleAlert /> {openErr}</div>
          <button className="primary" onClick={openSession}><RefreshCw />{tr("ssh.retry")}</button>
        </div>
      </div>
    );
  }

  return (
    <div className="sftp-panel">
      <div className="sftp-bar">
        <span className="sftp-title ellipsis">{title ?? tr("ssh.files")}</span>
        <span className="grow" />
        <button className="icon-btn" title={tr("ssh.up")} disabled={cwd === "/"} onClick={() => go(parentPath(cwd))}><ArrowUp /></button>
        <button className="icon-btn" title={tr("ssh.refresh2")} onClick={() => sid && void load(sid, cwd)}><RefreshCw /></button>
        <button className="icon-btn" title={tr("ssh.newFolder")} onClick={() => { setMkName(""); setMkOpen(true); }}><FolderPlus /></button>
        <button className="icon-btn" title={tr("ssh.newFile2")} onClick={() => { setMkFileDir(cwd); setMkFileName(""); }}><FilePlus /></button>
        <button
          className="icon-btn"
          title={selEntry?.kind === "dir"
            ? tr("ssh.downloadSelectedFolderRecursive")
            : tr("ssh.downloadSelectedFile")}
          disabled={!selEntry || busy}
          onClick={() => selEntry && void download(selEntry)}
        >
          <Download />
        </button>
        {!noUpload && <button className="icon-btn" title={tr("ssh.uploadFile")} onClick={() => void upload()}><Upload /></button>}
      </div>

      <form
        className="sftp-path"
        onSubmit={(e) => { e.preventDefault(); go(pathEdit.trim() || "/"); }}
      >
        <input className="mono grow" aria-label={tr("ssh.currentPath")} value={pathEdit} onChange={(e) => setPathEdit(e.target.value)} spellCheck={false} />
      </form>

      {err && <div className="error-box pre sftp-err"><TriangleAlert /> {err}</div>}

      {loading ? (
        <Loading />
      ) : (
      <div
        ref={listRef}
        className="sftp-list"
        tabIndex={-1}
        onKeyDown={(ev) => {
          // Thư mục rỗng: khung được focus → Backspace vẫn lên được thư mục cha.
          if (ev.key === "Backspace" && ev.target === ev.currentTarget) { ev.preventDefault(); rowApi.current.up(true); return; }
          listNav(ev, { row: ".sftp-row[tabindex]", select: true });
        }}
        onContextMenu={(ev) => { ev.preventDefault(); setMenu({ x: ev.clientX, y: ev.clientY, items: emptyMenu() }); }}
      >
        {/* Header cột + hàng ".." gộp trong một khối STICKY để luôn dính trên đỉnh khi cuộn. */}
        <div className="sftp-sticky">
          <div className="sftp-head">
            <span className="sftp-ic" />
            <span className="grow">{tr("ssh.name2")}</span>
            <span className="sftp-size">{tr("ssh.size")}</span>
            <span className="sftp-time">{tr("ssh.lastModified")}</span>
          </div>
          {/* Hàng ".." quay lại thư mục cha (ẩn khi ở gốc). Click/double-click đều lên. */}
          {cwd !== "/" && (
            <div
              className="sftp-row sftp-up"
              title={tr("ssh.parentFolder")}
              onClick={() => go(parentPath(cwd))}
              onDoubleClick={() => go(parentPath(cwd))}
            >
              <span className="sftp-ic"><CornerLeftUp /></span>
              <span className="grow">..</span>
            </div>
          )}
        </div>
        {!entries.length && <div className="muted small pad">{tr("ssh.emptyFolder")}</div>}
        {entries.map((e) =>
          renaming === e.name ? (
            <div key={e.name} className="sftp-row" onClick={(ev) => ev.stopPropagation()}>
              <FileIcon entry={e} />
              <input
                autoFocus
                className="tree-rename grow"
                defaultValue={e.name}
                onFocus={(ev) => ev.currentTarget.select()}
                onBlur={(ev) => void doRename(e, ev.target.value)}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter") ev.currentTarget.blur();
                  if (ev.key === "Escape") setRenaming(null);
                }}
              />
            </div>
          ) : (
            <SftpRow key={e.name} e={e} sel={sel === e.name} api={rowApi} />
          ),
        )}
      </div>
      )}

      {busy && <Loading variant="row" className="sftp-busy" label={tr("ssh.working")} />}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}

      {mkOpen && (
        <Modal title={tr("ssh.newFolder")} width={420} onClose={() => setMkOpen(false)}>
          <div className="form account-form">
            <label>{tr("ssh.folderName")}
              <input
                autoFocus
                value={mkName}
                onChange={(e) => setMkName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void doMkdir(); if (e.key === "Escape") setMkOpen(false); }}
              />
            </label>
            <div className="toolbar">
              <span className="grow" />
              <button onClick={() => setMkOpen(false)}><X />{tr("ssh.cancel")}</button>
              <button className="primary" disabled={!mkName.trim()} onClick={() => void doMkdir()}><Plus />{tr("ssh.create")}</button>
            </div>
          </div>
        </Modal>
      )}

      {mkFileDir !== null && (
        <Modal title={tr("ssh.newFile2")} width={460} onClose={() => setMkFileDir(null)}>
          <div className="form account-form">
            <div className="muted small ellipsis">{tr("ssh.in2")} <span className="mono">{mkFileDir}</span></div>
            <label>{tr("ssh.fileName")}
              <input
                autoFocus
                value={mkFileName}
                onChange={(e) => setMkFileName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void doMkFile(); if (e.key === "Escape") setMkFileDir(null); }}
              />
            </label>
            <div className="toolbar">
              <span className="grow" />
              <button onClick={() => setMkFileDir(null)}><X />{tr("ssh.cancel")}</button>
              <button className="primary" disabled={!mkFileName.trim()} onClick={() => void doMkFile()}><Plus />{tr("ssh.create")}</button>
            </div>
          </div>
        </Modal>
      )}

      {preview && sid && (
        <PreviewModal
          entry={preview.e}
          p={preview.p}
          busy={busy}
          onClose={() => setPreview(null)}
          onDownload={() => void download(preview.e)}
          onSave={async (text) => {
            const path = joinPath(cwd, preview.e.name);
            await viaSudo(path, () => drv.write(sid, path, text), async () => {
              const tmp = tmpPath(preview.e.name);
              await drv.write(sid, tmp, text);
              await sudoFs(cfg, "install", tmp, path);
            });
            setPreview((x) => (x ? { ...x, p: { ...x.p, data: text, size: new TextEncoder().encode(text).length } } : x));
            void load(sid, cwd);
          }}
        />
      )}
    </div>
  );
});

/** Modal xem file: text thì sửa được (Edit → textarea, Ctrl+S lưu, giữ kiểu xuống dòng CRLF/LF của file gốc).
 *  State gõ phím nằm trong component này → không vẽ lại danh sách file. */
function PreviewModal({ entry, p, busy, onClose, onDownload, onSave }: {
  entry: SftpEntry;
  p: SftpPreview;
  busy: boolean;
  onClose: () => void;
  onDownload: () => void;
  onSave: (text: string) => Promise<void>;
}) {
  const tr = useT();
  const crlf = p.kind === "text" && p.data.includes("\r\n");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);
  const orig = p.kind === "text" ? (crlf ? p.data.replace(/\r\n/g, "\n") : p.data) : "";
  const dirty = editing && draft !== orig;

  const startEdit = () => { setDraft(orig); setErr(""); setEditing(true); };
  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setErr("");
    try {
      await onSave(crlf ? draft.replace(/\n/g, "\r\n") : draft);
      setEditing(false);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setSaving(false);
    }
  };
  const close = async () => {
    if (dirty && !(await confirmDialog({ message: tr("ssh.discardEdits"), confirmLabel: tr("ssh.discardEditsOk") }))) return;
    onClose();
  };
  const cancelEdit = async () => {
    if (dirty && !(await confirmDialog({ message: tr("ssh.discardEdits"), confirmLabel: tr("ssh.discardEditsOk") }))) return;
    setEditing(false);
    setErr("");
  };
  /** Copy nội dung (đang bôi đen một đoạn trong khung xem thì chỉ copy đoạn đó). */
  const copy = async () => {
    const sel = window.getSelection();
    const inPreview = !!sel?.anchorNode && !!sel.anchorNode.parentElement?.closest(".sftp-text");
    if (await copyText((inPreview && sel!.toString()) || (editing ? draft : p.data))) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <Modal title={entry.name} width={editing ? 980 : 820} onClose={() => void close()}>
      <div className="sftp-preview">
        {p.kind === "text" && (editing
          ? <textarea
              className="mono sftp-edit"
              value={draft}
              autoFocus
              spellCheck={false}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); void save(); }
                else if (e.key === "Tab" && !e.shiftKey) {
                  e.preventDefault();
                  const t = e.currentTarget, a = t.selectionStart, b = t.selectionEnd;
                  t.setRangeText("\t", a, b, "end");
                  setDraft(t.value);
                }
              }}
            />
          : <pre className="mono sftp-text">{p.data}</pre>)}
        {p.kind === "image" && (
          <div className="sftp-img"><img src={`data:${p.mime};base64,${p.data}`} alt={entry.name} /></div>
        )}
        {p.kind === "binary" && <div className="muted pad">{tr("ssh.binaryFileCanTPreview")} ({human(p.size)})</div>}
        {p.kind === "toolarge" && <div className="muted pad">{tr("ssh.fileTooLargeToPreview")} ({human(p.size)}).</div>}
      </div>
      {err && <div className="error-box">{err}</div>}
      <div className="toolbar">
        <span className="muted small">{human(p.size)}{crlf ? " · CRLF" : ""}{dirty ? ` · ${tr("ssh.unsavedEdits")}` : ""}</span>
        <span className="grow" />
        {p.kind === "text" && (
          <button onClick={() => void copy()} title={tr("ssh.copyContentHint")}>
            <Swap on={copied} a={<><Check /> {tr("ssh.copied")}</>} b={<><Copy /> {tr("ssh.copyContent")}</>} />
          </button>
        )}
        {editing ? (
          <>
            <button disabled={saving} onClick={() => void cancelEdit()}><X />{tr("ssh.cancelEdit")}</button>
            <button className="primary" disabled={!dirty || saving} onClick={() => void save()} title="Ctrl+S">
              {saving ? <Spinner /> : <Save />}{tr("ssh.saveFile")}
            </button>
          </>
        ) : (
          <>
            <button onClick={() => void close()}><X />{tr("ssh.close")}</button>
            {p.kind === "text" && <button onClick={startEdit}><Pencil />{tr("ssh.editFile")}</button>}
            <button className="primary" disabled={busy} onClick={onDownload}><Download /> {tr("ssh.download2")}</button>
          </>
        )}
      </div>
    </Modal>
  );
}
