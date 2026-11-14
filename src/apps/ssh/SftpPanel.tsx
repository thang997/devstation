import { useCallback, useEffect, useRef, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Modal } from "../../shell/Modal";
import { ContextMenu, type CtxItem } from "../../shell/ContextMenu";
import { confirmDialog } from "../../shell/confirm";
import { useT } from "../../store/lang";
import { sftp, errText, type FsDriver, type SftpCfg, type SftpEntry, type SftpPreview } from "./api";

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

/** Icon theo loại file (emoji — không cần thư viện icon, hợp các icon sẵn có trong app). */
const EXT_ICON: Record<string, string> = {
  // Ảnh
  png: "🖼️", jpg: "🖼️", jpeg: "🖼️", gif: "🖼️", bmp: "🖼️", webp: "🖼️", svg: "🖼️", ico: "🖼️", tif: "🖼️", tiff: "🖼️",
  // Video / âm thanh
  mp4: "🎬", mkv: "🎬", avi: "🎬", mov: "🎬", webm: "🎬", flv: "🎬",
  mp3: "🎵", wav: "🎵", flac: "🎵", ogg: "🎵", m4a: "🎵", aac: "🎵",
  // Nén / gói (dùng hộp 📦 — cái kẹp 🗜️ khó hiểu)
  zip: "📦", tar: "📦", gz: "📦", tgz: "📦", bz2: "📦", xz: "📦", zst: "📦", "7z": "📦", rar: "📦",
  deb: "📦", rpm: "📦", apk: "📦", jar: "📦", war: "📦",
  // Tài liệu
  pdf: "📕", doc: "📘", docx: "📘", odt: "📘",
  // Excel: chip vuông xanh chữ "X" (xem FileIcon)
  xls: XLS_GLYPH, xlsx: XLS_GLYPH, xlsm: XLS_GLYPH,
  csv: "📊", ods: "📊",
  ppt: "📙", pptx: "📙",
  md: "📝", markdown: "📝", txt: "📝", log: "📝", rst: "📝", adoc: "📝",
  // Cấu hình / dữ liệu
  json: "⚙️", jsonc: "⚙️", yaml: "⚙️", yml: "⚙️", toml: "⚙️", ini: "⚙️", cfg: "⚙️", conf: "⚙️",
  config: "⚙️", properties: "⚙️", env: "⚙️", xml: "⚙️",
  // Mã nguồn
  js: "🟨", jsx: "🟨", mjs: "🟨", cjs: "🟨",
  ts: "🔷", tsx: "🔷",
  py: "🐍", rs: "🦀", go: "🐹", rb: "💎", php: "🐘",
  java: "☕", class: "☕", kt: "☕",
  c: "🔧", h: "🔧", cpp: "🔧", cc: "🔧", cxx: "🔧", hpp: "🔧", cs: "🔧",
  // Script shell: chip `>_` kiểu terminal (giống Termius) — xem class `.sftp-ic.term`.
  sh: TERM_GLYPH, bash: TERM_GLYPH, zsh: TERM_GLYPH, fish: TERM_GLYPH, ps1: TERM_GLYPH, bat: TERM_GLYPH, cmd: TERM_GLYPH,
  sql: "🗄️", db: "🗄️", sqlite: "🗄️", sqlite3: "🗄️",
  html: "🌐", htm: "🌐", css: "🌐", scss: "🌐", sass: "🌐", less: "🌐", vue: "🌐", svelte: "🌐",
  // Thư viện động / đĩa
  so: "💿", iso: "💿", img: "💿", dmg: "💿",
  // Khoá / chứng chỉ
  pem: "🔑", key: "🔑", pub: "🔑", ppk: "🔑", crt: "🔑", cer: "🔑", p12: "🔑", pfx: "🔑",
  // Khoá phiên bản
  lock: "🔒",
};

/** Ô icon của một hàng file: emoji thường, hoặc chip `>_` cho file script. */
function FileIcon({ entry }: { entry: SftpEntry }) {
  const ic = fileIcon(entry);
  if (ic === TERM_GLYPH) return <span className="sftp-ic term">&gt;_</span>;
  if (ic === XLS_GLYPH) return <span className="sftp-ic xls">X</span>;
  return <span className="sftp-ic">{ic}</span>;
}

/** Icon cho một mục trong danh sách file. */
function fileIcon(e: SftpEntry): string {
  if (e.kind === "dir") return "📁";
  if (e.kind === "link") return "🔗";
  const name = e.name.toLowerCase();
  // Vài tên file đặc biệt không dựa vào đuôi.
  if (name === "dockerfile" || name.startsWith("docker-compose")) return "🐳";
  if (name === "makefile" || name === "cmakelists.txt") return "🔨";
  if (name === ".gitignore" || name === ".gitattributes" || name === ".gitmodules") return "🔀";
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1) : "";
  return EXT_ICON[ext] ?? "📄";
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

/** Panel SFTP: duyệt file remote + preview, kiểu MobaXterm. Mở phiên sftp.exe riêng cho tab.
 * `followCd`: khi người dùng gõ `cd` ở terminal, panel đi theo (resolve tương đối theo cwd hiện tại). */
export function SftpPanel({
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
  title?: string;
  /** Ẩn nút upload (container chưa hỗ trợ upload). */
  noUpload?: boolean;
}) {
  const tr = useT();
  const drv = driver ?? sftp;
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

  const openEntry = (e: SftpEntry) => {
    if (e.kind === "dir") go(joinPath(cwd, e.name));
    else if (e.kind === "link") void openLink(e);
    else void doPreview(e);
  };

  /** Tải về: file → chọn tên file (save dialog); thư mục → chọn thư mục cha rồi `get -r`. */
  const download = async (e: SftpEntry) => {
    if (!sid) return;
    const isDir = e.kind === "dir";
    const local = isDir
      ? await openDialog({ directory: true, title: tr(`Download folder “${e.name}” into…`, `Tải thư mục “${e.name}” vào…`) })
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
      await drv.put(sid, local, joinPath(cwd, baseName(local)));
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
        ? tr(`Delete folder “${e.name}”? (must be empty)`, `Xoá thư mục “${e.name}”? (phải rỗng)`)
        : tr(`Delete “${e.name}”? This cannot be undone.`, `Xoá “${e.name}”? Không hoàn tác được.`),
    });
    if (!ok) return;
    setBusy(true);
    try {
      const path = joinPath(cwd, e.name);
      await (e.kind === "dir" ? drv.rmdir(sid, path) : drv.rm(sid, path));
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
      await drv.rename(sid, joinPath(cwd, e.name), joinPath(cwd, nm));
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
      await drv.mkdir(sid, joinPath(cwd, nm));
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
      await drv.touch(sid, joinPath(dir, nm));
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
          { id: "preview", icon: "👁", label: tr("Preview", "Xem trước"), action: () => void doPreview(e) },
          { id: "dl", icon: "⬇", label: tr("Download…", "Tải về…"), action: () => void download(e) },
        ]
      : [
          { id: "open", icon: "📂", label: tr("Open", "Mở"), action: () => openEntry(e) },
          { id: "newfile", icon: "📄", label: tr("New file here…", "Tạo file trong đây…"), action: () => { setMkFileDir(joinPath(cwd, e.name)); setMkFileName(""); } },
          { id: "dl", icon: "⬇", label: tr("Download folder (recursive)…", "Tải thư mục (đệ quy)…"), action: () => void download(e) },
        ]),
    { id: "rename", icon: "✎", label: tr("Rename (F2)", "Đổi tên (F2)"), action: () => setRenaming(e.name) },
    { id: "copy", icon: "⧉", label: tr("Copy path", "Copy đường dẫn"), action: () => void navigator.clipboard.writeText(joinPath(cwd, e.name)) },
    { id: "s1", sep: true },
    { id: "del", icon: "🗑", label: tr("Delete", "Xoá"), danger: true, action: () => void del(e) },
  ];

  /** Menu chuột phải vùng trống (không trúng file/folder): thao tác trên thư mục hiện tại. */
  const emptyMenu = (): CtxItem[] => [
    { id: "newfile", icon: "📄", label: tr("New file…", "Tạo file…"), action: () => { setMkFileDir(cwd); setMkFileName(""); } },
    { id: "newdir", icon: "🗂", label: tr("New folder…", "Tạo thư mục…"), action: () => { setMkName(""); setMkOpen(true); } },
    { id: "reload", icon: "↻", label: tr("Reload", "Tải lại"), action: () => sid && void load(sid, cwd) },
    ...(!noUpload
      ? [{ id: "upload", icon: "⬆", label: tr("Upload to current folder…", "Tải file lên thư mục này…"), action: () => void upload() }]
      : []),
  ];

  /** Mục đang chọn (để nút tải xuống trên toolbar tác động đúng). */
  const selEntry = sel ? entries.find((e) => e.name === sel) ?? null : null;

  if (opening) {
    return (
      <div className="sftp-panel">
        <div className="sftp-center">
          <span className="spinner" /> {tr("Connecting SFTP…", "Đang kết nối SFTP…")}
        </div>
      </div>
    );
  }
  if (openErr) {
    return (
      <div className="sftp-panel">
        <div className="sftp-center col">
          <div className="error-box pre">⚠ {openErr}</div>
          <button className="primary" onClick={openSession}>{tr("Retry", "Thử lại")}</button>
        </div>
      </div>
    );
  }

  return (
    <div className="sftp-panel">
      <div className="sftp-bar">
        <span className="sftp-title ellipsis">{title ?? tr("Files", "File")}</span>
        <span className="grow" />
        <button className="icon-btn" title={tr("Up", "Lên thư mục")} disabled={cwd === "/"} onClick={() => go(parentPath(cwd))}>↑</button>
        <button className="icon-btn" title={tr("Refresh", "Làm mới")} onClick={() => sid && void load(sid, cwd)}>↻</button>
        <button className="icon-btn" title={tr("New folder", "Thư mục mới")} onClick={() => { setMkName(""); setMkOpen(true); }}>＋</button>
        <button className="icon-btn" title={tr("New file", "File mới")} onClick={() => { setMkFileDir(cwd); setMkFileName(""); }}>📄</button>
        <button
          className="icon-btn"
          title={selEntry?.kind === "dir"
            ? tr("Download selected folder (recursive)", "Tải thư mục đang chọn (đệ quy)")
            : tr("Download selected file…", "Tải file đang chọn về…")}
          disabled={!selEntry || busy}
          onClick={() => selEntry && void download(selEntry)}
        >
          ⬇
        </button>
        {!noUpload && <button className="icon-btn" title={tr("Upload file…", "Tải file lên…")} onClick={() => void upload()}>⬆</button>}
      </div>

      <form
        className="sftp-path"
        onSubmit={(e) => { e.preventDefault(); go(pathEdit.trim() || "/"); }}
      >
        <input className="mono grow" value={pathEdit} onChange={(e) => setPathEdit(e.target.value)} spellCheck={false} />
      </form>

      {err && <div className="error-box pre sftp-err">⚠ {err}</div>}

      {loading ? (
        <div className="sftp-center"><span className="spinner" /> {tr("Loading…", "Đang tải…")}</div>
      ) : (
      <div
        className="sftp-list"
        onContextMenu={(ev) => { ev.preventDefault(); setMenu({ x: ev.clientX, y: ev.clientY, items: emptyMenu() }); }}
      >
        {/* Header cột + hàng ".." gộp trong một khối STICKY để luôn dính trên đỉnh khi cuộn. */}
        <div className="sftp-sticky">
          <div className="sftp-head">
            <span className="sftp-ic" />
            <span className="grow">{tr("NAME", "TÊN")}</span>
            <span className="sftp-size">{tr("SIZE", "KÍCH THƯỚC")}</span>
            <span className="sftp-time">{tr("LAST MODIFIED", "SỬA ĐỔI")}</span>
          </div>
          {/* Hàng ".." quay lại thư mục cha (ẩn khi ở gốc). Click/double-click đều lên. */}
          {cwd !== "/" && (
            <div
              className="sftp-row sftp-up"
              title={tr("Parent folder", "Thư mục cha")}
              onClick={() => go(parentPath(cwd))}
              onDoubleClick={() => go(parentPath(cwd))}
            >
              <span className="sftp-ic">↩</span>
              <span className="grow">..</span>
            </div>
          )}
        </div>
        {!entries.length && <div className="muted small pad">{tr("Empty folder", "Thư mục trống")}</div>}
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
            <div
              key={e.name}
              className={`sftp-row ${sel === e.name ? "sel" : ""}`}
              tabIndex={0}
              title={`${e.perms}${e.linkTarget ? ` → ${e.linkTarget}` : ""}`}
              onClick={() => setSel(e.name)}
              onDoubleClick={() => openEntry(e)}
              onKeyDown={(ev) => { if (ev.key === "F2") { ev.preventDefault(); setRenaming(e.name); } }}
              onContextMenu={(ev) => { ev.preventDefault(); ev.stopPropagation(); setSel(e.name); setMenu({ x: ev.clientX, y: ev.clientY, items: entryMenu(e) }); }}
            >
              <FileIcon entry={e} />
              <span className="grow ellipsis">{e.name}</span>
              <span className="muted small sftp-size">{e.kind === "dir" ? "" : human(e.size)}</span>
              <span className="muted small sftp-time ellipsis">{e.mtime}</span>
            </div>
          ),
        )}
      </div>
      )}

      {busy && <div className="sftp-busy"><span className="spinner" /> {tr("Working…", "Đang xử lý…")}</div>}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}

      {mkOpen && (
        <Modal title={tr("New folder", "Thư mục mới")} width={420} onClose={() => setMkOpen(false)}>
          <div className="form account-form">
            <label>{tr("Folder name", "Tên thư mục")}
              <input
                autoFocus
                value={mkName}
                onChange={(e) => setMkName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void doMkdir(); if (e.key === "Escape") setMkOpen(false); }}
              />
            </label>
            <div className="toolbar">
              <span className="grow" />
              <button onClick={() => setMkOpen(false)}>{tr("Cancel", "Huỷ")}</button>
              <button className="primary" disabled={!mkName.trim()} onClick={() => void doMkdir()}>{tr("Create", "Tạo")}</button>
            </div>
          </div>
        </Modal>
      )}

      {mkFileDir !== null && (
        <Modal title={tr("New file", "File mới")} width={460} onClose={() => setMkFileDir(null)}>
          <div className="form account-form">
            <div className="muted small ellipsis">{tr("In", "Trong")} <span className="mono">{mkFileDir}</span></div>
            <label>{tr("File name", "Tên file")}
              <input
                autoFocus
                value={mkFileName}
                onChange={(e) => setMkFileName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void doMkFile(); if (e.key === "Escape") setMkFileDir(null); }}
              />
            </label>
            <div className="toolbar">
              <span className="grow" />
              <button onClick={() => setMkFileDir(null)}>{tr("Cancel", "Huỷ")}</button>
              <button className="primary" disabled={!mkFileName.trim()} onClick={() => void doMkFile()}>{tr("Create", "Tạo")}</button>
            </div>
          </div>
        </Modal>
      )}

      {preview && (
        <Modal title={preview.e.name} width={820} onClose={() => setPreview(null)}>
          <div className="sftp-preview">
            {preview.p.kind === "text" && <pre className="mono sftp-text">{preview.p.data}</pre>}
            {preview.p.kind === "image" && (
              <div className="sftp-img"><img src={`data:${preview.p.mime};base64,${preview.p.data}`} alt={preview.e.name} /></div>
            )}
            {preview.p.kind === "binary" && (
              <div className="muted pad">{tr("Binary file — can't preview.", "File nhị phân — không xem trước được.")} ({human(preview.p.size)})</div>
            )}
            {preview.p.kind === "toolarge" && (
              <div className="muted pad">{tr("File too large to preview", "File quá lớn để xem trước")} ({human(preview.p.size)}).</div>
            )}
          </div>
          <div className="toolbar">
            <span className="muted small">{human(preview.p.size)}</span>
            <span className="grow" />
            <button onClick={() => setPreview(null)}>{tr("Close", "Đóng")}</button>
            <button className="primary" disabled={busy} onClick={() => void download(preview.e)}>⬇ {tr("Download", "Tải về")}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
