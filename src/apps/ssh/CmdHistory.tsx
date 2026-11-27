import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, History, Pencil, RefreshCw, Server, StickyNote, Trash2, X } from "lucide-react";
import { Modal } from "../../shell/Modal";
import { Loading } from "../../shell/Loading";
import { copyText } from "../../shell/clipboard";
import { confirmDialog } from "../../shell/confirm";
import { listNav, rowKey } from "../../shell/listNav";
import { useT } from "../../store/lang";
import { ssh, errText, type ConnectCfg } from "./api";
import { clearCommands, removeCommand, setNote, useCmdHistory, useCmdNotes } from "./cmdHistoryStore";
import { cmdKind, KIND_ORDER, type CmdKind } from "./cmdKind";
import type { TKey } from "../../store/lang";

/** Nhãn loại tác vụ (đoán theo tên lệnh — xem cmdKind.ts). */
const KIND_KEY: Record<CmdKind, TKey> = {
  read: "ssh.kindRead", write: "ssh.kindWrite", modify: "ssh.kindModify", delete: "ssh.kindDelete",
  service: "ssh.kindService", install: "ssh.kindInstall", network: "ssh.kindNetwork",
};
/** Cache theo nội dung lệnh (phân loại thuần, gọi lại cho mỗi lần lọc/vẽ). */
const kindCache = new Map<string, CmdKind | null>();
const kindOf = (cmd: string) => {
  let k = kindCache.get(cmd);
  if (k === undefined) { k = cmdKind(cmd); kindCache.set(cmd, k); }
  return k;
};

type Src = "app" | "server";
interface Row { cmd: string; ts?: number; n?: number }

/** Lịch sử lệnh của host: lệnh đã gõ trong app (+ thời gian, số lần) hoặc `~/.bash_history` trên server; copy, ghi chú. */
export function CmdHistoryModal({ hostKey, title, cfg, allowServer, onClose }: {
  hostKey: string;
  title: string;
  cfg: ConnectCfg;
  /** Tab exec vào container: lịch sử server là của host, không phải container → ẩn. */
  allowServer: boolean;
  onClose: () => void;
}) {
  const tr = useT();
  const local = useCmdHistory(hostKey);
  const notes = useCmdNotes(hostKey);
  const [src, setSrc] = useState<Src>("app");
  const [q, setQ] = useState("");
  const [onlyNoted, setOnlyNoted] = useState(false);
  /** Lọc theo loại tác vụ (null = tất cả, "none" = chưa nhận ra). */
  const [kindF, setKindF] = useState<CmdKind | "none" | null>(null);
  const [server, setServer] = useState<string[] | null>(null);
  const [serverErr, setServerErr] = useState("");
  const [serverBusy, setServerBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  const loadServer = () => {
    setServerBusy(true);
    setServerErr("");
    ssh.shellHistory(cfg)
      .then((v) => setServer(v))
      .catch((e) => setServerErr(errText(e)))
      .finally(() => setServerBusy(false));
  };
  useEffect(() => { if (src === "server" && server == null && !serverBusy) loadServer(); }, [src]); // eslint-disable-line react-hooks/exhaustive-deps

  const base: Row[] = useMemo(() => (src === "app" ? local : (server ?? []).map((cmd) => ({ cmd }))), [src, local, server]);
  /** Số lệnh mỗi loại (trên toàn danh sách nguồn, chưa lọc) cho các nút lọc. */
  const counts = useMemo(() => {
    const c = new Map<CmdKind | "none", number>();
    for (const r of base) { const k = kindOf(r.cmd) ?? "none"; c.set(k, (c.get(k) ?? 0) + 1); }
    return c;
  }, [base]);
  const rows: Row[] = useMemo(() => {
    const k = q.trim().toLowerCase();
    return base.filter((r) => {
      const note = notes[r.cmd];
      if (onlyNoted && !note) return false;
      if (kindF && (kindOf(r.cmd) ?? "none") !== kindF) return false;
      return !k || r.cmd.toLowerCase().includes(k) || (note ?? "").toLowerCase().includes(k);
    });
  }, [base, q, notes, onlyNoted, kindF]);

  const api = useRef({
    copy: (cmd: string) => void copyText(cmd),
    edit: (cmd: string) => setEditing(cmd),
    remove: (cmd: string) => removeCommand(hostKey, cmd),
    save: (cmd: string, note: string) => { setNote(hostKey, cmd, note); setEditing(null); },
    cancel: () => setEditing(null),
  });
  api.current.remove = (cmd) => removeCommand(hostKey, cmd);
  api.current.save = (cmd, note) => { setNote(hostKey, cmd, note); setEditing(null); };

  const copyAll = () => void copyText(rows.map((r) => r.cmd).join("\n"));
  const clear = () =>
    void confirmDialog({ message: tr("ssh.cmdHistClearConfirm", { host: title }), danger: true, confirmLabel: tr("ssh.cmdHistClear") })
      .then((ok) => ok && clearCommands(hostKey));

  return (
    <Modal title={<><History /> {tr("ssh.cmdHistTitle")}</>} width={820} onClose={onClose}>
      <div className="form cmdh">
        <div className="toolbar">
          <span className="mono muted small grow ellipsis">{title}</span>
          <div className="subtabs">
            <button className={src === "app" ? "on" : ""} onClick={() => setSrc("app")}><History />{tr("ssh.cmdHistApp")} ({local.length})</button>
            {allowServer && (
              <button className={src === "server" ? "on" : ""} onClick={() => setSrc("server")} title={tr("ssh.cmdHistServerHint")}><Server />{tr("ssh.cmdHistServer")}</button>
            )}
          </div>
        </div>
        <div className="toolbar">
          <input className="grow" autoFocus placeholder={tr("ssh.cmdHistSearch")} value={q} onChange={(e) => setQ(e.target.value)} />
          <label className="check small"><input type="checkbox" checked={onlyNoted} onChange={(e) => setOnlyNoted(e.target.checked)} />{tr("ssh.cmdHistOnlyNoted")}</label>
          <button disabled={!rows.length} onClick={copyAll} title={tr("ssh.cmdHistCopyAllHint")}><Copy />{tr("ssh.cmdHistCopyAll")}</button>
          {src === "server" && <button disabled={serverBusy} onClick={loadServer}><RefreshCw />{tr("ssh.refresh")}</button>}
          {src === "app" && <button className="danger" disabled={!local.length} onClick={clear}><Trash2 />{tr("ssh.cmdHistClear")}</button>}
        </div>
        <div className="cmdh-kinds" role="group" aria-label={tr("ssh.kindFilter")}>
          <button className={`cmdh-chip ${kindF == null ? "on" : ""}`} onClick={() => setKindF(null)}>{tr("ssh.kindAll")} <span className="muted">{base.length}</span></button>
          {KIND_ORDER.filter((k) => counts.get(k)).map((k) => (
            <button key={k} className={`cmdh-chip k-${k} ${kindF === k ? "on" : ""}`} onClick={() => setKindF(kindF === k ? null : k)}>
              <i className="cmdh-dot" />{tr(KIND_KEY[k])} <span className="muted">{counts.get(k)}</span>
            </button>
          ))}
          {counts.get("none") ? (
            <button className={`cmdh-chip ${kindF === "none" ? "on" : ""}`} onClick={() => setKindF(kindF === "none" ? null : "none")} title={tr("ssh.kindOtherHint")}>
              {tr("ssh.kindOther")} <span className="muted">{counts.get("none")}</span>
            </button>
          ) : null}
        </div>
        {src === "server" && serverErr && <div className="error-box">{serverErr}</div>}
        <div className="cmdh-list" role="listbox" onKeyDown={(e) => listNav(e, { row: ".cmdh-row" })}>
          {src === "server" && serverBusy && !server ? <Loading /> : rows.length === 0 ? (
            <div className="muted small pad">
              {q || onlyNoted ? tr("ssh.cmdHistNoMatch") : src === "app" ? tr("ssh.cmdHistEmpty") : tr("ssh.cmdHistServerEmpty")}
            </div>
          ) : (
            rows.map((r) => (
              <CmdRow
                key={r.cmd}
                cmd={r.cmd}
                ts={r.ts}
                n={r.n}
                note={notes[r.cmd] ?? ""}
                editing={editing === r.cmd}
                removable={src === "app"}
                api={api}
              />
            ))
          )}
        </div>
        <div className="muted small">{tr("ssh.cmdHistFooter")}</div>
      </div>
    </Modal>
  );
}

type RowApi = React.MutableRefObject<{
  copy: (cmd: string) => void;
  edit: (cmd: string) => void;
  remove: (cmd: string) => void;
  save: (cmd: string, note: string) => void;
  cancel: () => void;
}>;

const CmdRow = memo(function CmdRow({ cmd, ts, n, note, editing, removable, api }: {
  cmd: string; ts?: number; n?: number; note: string; editing: boolean; removable: boolean; api: RowApi;
}) {
  const tr = useT();
  return (
    <div
      className="cmdh-row"
      tabIndex={0}
      role="option"
      aria-selected={false}
      onDoubleClick={() => api.current.copy(cmd)}
      onKeyDown={(e) => rowKey(e, {
        Enter: () => api.current.copy(cmd),
        F2: () => api.current.edit(cmd),
        Delete: removable ? () => api.current.remove(cmd) : undefined,
      })}
    >
      <div className="cmdh-main">
        <div className="cmdh-line">
          <KindTag cmd={cmd} />
          <code className="cmdh-cmd" title={cmd}>{cmd}</code>
        </div>
        {editing ? (
          <NoteEditor initial={note} onSave={(v) => api.current.save(cmd, v)} onCancel={api.current.cancel} />
        ) : note ? (
          <div className="cmdh-note" onClick={() => api.current.edit(cmd)} title={tr("ssh.cmdHistEditNote")}><StickyNote />{note}</div>
        ) : null}
      </div>
      <div className="cmdh-meta muted small">
        {n && n > 1 ? <span>×{n}</span> : null}
        {ts ? <span title={new Date(ts).toLocaleString()}>{fmtTime(ts)}</span> : null}
      </div>
      <div className="row-actions">
        <button className="icon-btn" title={tr("ssh.cmdHistCopy")} onClick={() => api.current.copy(cmd)}><Copy /></button>
        <button className="icon-btn" title={note ? tr("ssh.cmdHistEditNote") : tr("ssh.cmdHistAddNote")} onClick={() => api.current.edit(cmd)}><Pencil /></button>
        {removable && <button className="icon-btn" title={tr("ssh.cmdHistRemove")} onClick={() => api.current.remove(cmd)}><Trash2 /></button>}
      </div>
    </div>
  );
});

function KindTag({ cmd }: { cmd: string }) {
  const tr = useT();
  const k = kindOf(cmd);
  return k ? <span className={`cmdh-kind k-${k}`}>{tr(KIND_KEY[k])}</span> : <span className="cmdh-kind none" />;
}

function NoteEditor({ initial, onSave, onCancel }: { initial: string; onSave: (v: string) => void; onCancel: () => void }) {
  const tr = useT();
  const [v, setV] = useState(initial);
  return (
    <div className="cmdh-note-edit" onDoubleClick={(e) => e.stopPropagation()}>
      <input
        autoFocus
        value={v}
        placeholder={tr("ssh.cmdHistNotePlaceholder")}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") onSave(v);
          else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
        }}
      />
      <button className="icon-btn" title={tr("ssh.save")} onClick={() => onSave(v)}><Check /></button>
      <button className="icon-btn" title={tr("ssh.cancel")} onClick={onCancel}><X /></button>
    </div>
  );
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === now.toDateString() ? hm : `${d.toLocaleDateString()} ${hm}`;
}
