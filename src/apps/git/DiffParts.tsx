import { renderLog } from "../../shell/renderDebug";
import { memo, useEffect, useMemo, useState } from "react";
import { Splitter, useSplitSize } from "../../shell/Resizable";
import { useT } from "../../store/lang";
import { ChevronDown, ChevronRight, Copy } from "lucide-react";
import type { Commit } from "./api";
import { parseDiff, type DiffFile } from "./diffParse";
export { parseDiff };

/**
 * Hiển thị diff dễ đọc (kiểu GitHub Desktop): tách output `git diff` / `git show` thành từng file,
 * mỗi dòng có cột số dòng CŨ | MỚI, dòng thêm/xoá tô màu cả hàng, header hunk gọn.
 * Commit: phần đầu là thông tin commit (tiêu đề, thân, tác giả, thời gian, hash), dưới là
 * danh sách file thay đổi (trạng thái A/M/D/R + số dòng +/−) và diff của file đang chọn.
 */

const MAX_LINES = 5000;

/** Thân diff của MỘT file: gutter số dòng cũ | mới, tô màu cả hàng. */
export const DiffBody = memo(function DiffBody({ file }: { file: DiffFile }) {
  renderLog("DiffBody");
  const tr = useT();
  if (file.binary) return <div className="empty">{tr("git.binaryFileNoPreview")}</div>;
  if (!file.lines.length) return <div className="empty">{file.status === "R" ? tr("git.renamedOnly") : tr("git.noTextualDifference")}</div>;
  const shown = file.lines.slice(0, MAX_LINES);
  const maxNo = shown.reduce((m, l) => Math.max(m, l.o ?? 0, l.n ?? 0), 0);
  const gw = `${String(maxNo).length + 1}ch`;
  return (
    <div className="dv mono">
      <div className="dv-inner">
        {shown.map((l, i) =>
          l.k === "hunk" ? (
            <div key={i} className="dv-l dv-hunk">
              <span className="dv-g" style={{ width: gw }}>⋯</span>
              <span className="dv-g" style={{ width: gw }}>⋯</span>
              <span className="dv-t">{l.t || " "}</span>
            </div>
          ) : (
            <div key={i} className={`dv-l dv-${l.k}`}>
              <span className="dv-g" style={{ width: gw }}>{l.o ?? ""}</span>
              <span className="dv-g" style={{ width: gw }}>{l.n ?? ""}</span>
              <span className="dv-s">{l.k === "add" ? "+" : l.k === "del" ? "−" : " "}</span>
              <span className="dv-t">{l.t || " "}</span>
            </div>
          ),
        )}
        {file.lines.length > MAX_LINES && <div className="dv-l dv-note"><span className="dv-t">{tr("git.moreLinesDiffTooLarge", { p: file.lines.length - MAX_LINES })}</span></div>}
      </div>
    </div>
  );
});

/** Diff một file đang thay đổi (working tree). Không phải diff chuẩn (lỗi / thông báo) → hiện chữ thô. */
export const FileDiff = memo(function FileDiff({ text }: { text: string }) {
  renderLog("FileDiff");
  const parsed = useMemo(() => parseDiff(text), [text]);
  if (!parsed.files.length) return <div className="dv mono"><div className="dv-raw">{text}</div></div>;
  if (parsed.files.length === 1) return <DiffBody file={parsed.files[0]} />;
  return (
    <div className="dv-multi">
      {parsed.files.map((f, i) => (
        <div key={i}>
          <div className="dv-fhead mono">{f.path}</div>
          <DiffBody file={f} />
        </div>
      ))}
    </div>
  );
});

const STATUS_KEY = { A: "git.statusAdded", M: "git.statusModified", D: "git.statusDeleted", R: "git.statusRenamed", C: "git.statusCopied" } as const;

/** Tách phần thông tin commit (`git show --format=fuller`): người viết, ngày, message. */
function parseHead(head: string[]) {
  const get = (k: string) => head.find((l) => l.startsWith(`${k}:`))?.slice(k.length + 1).trim() ?? "";
  const msg: string[] = [];
  let started = false;
  for (const l of head) {
    if (l.startsWith("    ")) { started = true; msg.push(l.slice(4)); }
    else if (started && l === "") msg.push("");
    else if (started) break; // tới phần --stat
  }
  while (msg.length && !msg[msg.length - 1].trim()) msg.pop();
  const subject = msg[0] ?? "";
  const body = msg.slice(1).join("\n").replace(/^\n+/, "");
  return { author: get("Author"), committer: get("Commit"), merge: get("Merge"), subject, body };
}

/** memo: gõ message commit / tiến trình ở RepoView không vẽ lại khung commit (danh sách file + diff). */
export const CommitView = memo(function CommitView({ text, commit, onCopy }: { text: string; commit: Commit; onCopy: (s: string) => void }) {
  renderLog("CommitView");
  const tr = useT();
  const { head, files } = useMemo(() => parseDiff(text), [text]);
  const info = useMemo(() => parseHead(head), [head]);
  const [sel, setSel] = useState(0);
  const [listW, setListW] = useSplitSize("git.commitFiles", 280, 160, 600);
  /** Phần thông tin commit thu gọn (mặc định) / mở rộng — nhớ lại lựa chọn. */
  const [open, setOpen] = useState(() => localStorage.getItem("git.commitHeadOpen") === "1");
  const toggle = () => setOpen((v) => { localStorage.setItem("git.commitHeadOpen", v ? "0" : "1"); return !v; });
  useEffect(() => setSel(0), [commit.hash]);
  const [add, del] = useMemo(() => [files.reduce((a, f) => a + f.add, 0), files.reduce((a, f) => a + f.del, 0)], [files]);
  const file = files[Math.min(sel, files.length - 1)];
  // Không parse được (lỗi git…) → hiện chữ thô.
  if (!files.length && !info.subject) return <div className="dv mono"><div className="dv-raw">{text}</div></div>;
  const date = new Date(commit.time * 1000);
  const authorName = info.author.replace(/\s*<.*>$/, "") || commit.author;
  const email = /<(.*)>/.exec(info.author)?.[1] ?? "";
  const committerName = info.committer.replace(/\s*<.*>$/, "");
  return (
    <div className="cv">
      <div className={`cv-head ${open ? "open" : ""}`}>
        <div className="cv-subject-row" onClick={toggle} title={open ? tr("git.collapseCommitInfo") : tr("git.expandCommitInfo")}>
          <span className="cv-caret">{open ? <ChevronDown /> : <ChevronRight />}</span>
          <span className={`cv-subject ${open ? "" : "ellipsis"}`}>{info.subject || commit.subject}</span>
          {!open && (
            <span className="cv-mini muted small">
              {info.body && <span className="cv-more" title={info.body}>…</span>}
              <span>{authorName}</span>
              <span title={date.toString()}>· {date.toLocaleString()}</span>
              <span className="mono">· {commit.short}</span>
              <span>· {files.length} {tr("git.files")}</span>
              <span className="cv-add">+{add}</span>
              <span className="cv-del">−{del}</span>
            </span>
          )}
        </div>
        {open && info.body && <div className="cv-body">{info.body}</div>}
        {open && <div className="cv-meta muted small">
          <span className="cv-avatar">{(authorName[0] ?? "?").toUpperCase()}</span>
          <b className="cv-author" title={email}>{authorName}</b>
          {committerName && committerName !== authorName && <span>· {tr("git.committedBy", { name: committerName })}</span>}
          <span title={date.toString()}>· {date.toLocaleString()}</span>
          <span className="mono cv-hash" title={tr("git.copyFullHash")} onClick={() => onCopy(commit.hash)}>· {commit.short} <Copy /></span>
          {info.merge && <span className="mono">· merge {info.merge}</span>}
          <span className="grow" />
          <span>{tr("git.filesChangedCount", { n: files.length })}</span>
          <span className="cv-add">+{add}</span>
          <span className="cv-del">−{del}</span>
        </div>}
      </div>
      {files.length ? (
        <div className="cv-split">
          <div className="cv-files" style={{ width: listW }}>
            {files.map((f, i) => <CvFileRow key={`${f.path}${i}`} f={f} i={i} on={i === sel} onSelect={setSel} />)}
          </div>
          <Splitter axis="x" live="prev" min={160} max={600} onResize={(d) => setListW((w) => w + d)} onReset={() => setListW(280)} />
          <div className="cv-diff">
            {file && (
              <>
                <div className="dv-fhead mono ellipsis">{file.oldPath ? `${file.oldPath} → ` : ""}{file.path}</div>
                <DiffBody file={file} />
              </>
            )}
          </div>
        </div>
      ) : <div className="empty">{tr("git.noTextualDifference")}</div>}
    </div>
  );
});

/** Một dòng file của commit: memo → đổi file đang chọn / kéo splitter chỉ vẽ lại dòng đổi. */
const CvFileRow = memo(function CvFileRow({ f, i, on, onSelect }: { f: DiffFile; i: number; on: boolean; onSelect: (i: number) => void }) {
  renderLog("CvFileRow");
  const tr = useT();
  const slash = f.path.lastIndexOf("/");
  return (
    <div
      className={`cv-file ${on ? "on" : ""}`}
      onClick={() => onSelect(i)}
      title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
    >
      <span className={`cv-st st-${f.status}`} title={tr(STATUS_KEY[f.status])}>{f.status}</span>
      <span className="grow ellipsis">
        <span className="cv-fname">{f.path.slice(slash + 1)}</span>
        {slash > 0 && <span className="muted small"> {f.path.slice(0, slash)}</span>}
      </span>
      {!f.binary && <span className="cv-counts small"><span className="cv-add">+{f.add}</span> <span className="cv-del">−{f.del}</span></span>}
    </div>
  );
});
