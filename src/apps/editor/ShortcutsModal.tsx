import { useState, useSyncExternalStore } from "react";
import { Keyboard } from "lucide-react";
import { Modal } from "../../shell/Modal";
import { useT } from "../../store/lang";
import { SHORTCUTS } from "./keys";

/** Bảng phím tắt của Editor (F1 / nút bàn phím / Ctrl+G "Editor: phím tắt") — đọc từ `SHORTCUTS` (cùng nguồn với keymap). */
let open = false;
const subs = new Set<() => void>();
export const openShortcuts = () => { open = true; subs.forEach((f) => f()); };
const close = () => { open = false; subs.forEach((f) => f()); };
const useOpen = () => useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => open);

/** Bỏ dấu tiếng Việt để lọc ("dinh dang" khớp "Định dạng"). */
const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();

function Hl({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const i = fold(text).indexOf(q);
  if (i < 0) return <>{text}</>;
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>;
}

export function ShortcutsHost() {
  const isOpen = useOpen();
  const tr = useT();
  const [q, setQ] = useState("");
  if (!isOpen) return null;
  const fq = fold(q.trim());
  const groups = SHORTCUTS.map((g) => ({
    title: tr(g.title),
    items: g.items.filter((s) => !fq || fold(tr(s.label)).includes(fq) || fold(s.keys).includes(fq)),
  })).filter((g) => g.items.length);
  return (
    <Modal title={<><Keyboard /> {tr("editor.shortcutsTitle")}</>} width={820} onClose={() => { setQ(""); close(); }}>
      <div className="form">
        <input autoFocus placeholder={tr("editor.filterShortcuts")} value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="ed-keys">
          {groups.map((g) => (
            <div key={g.title}>
              <h4>{g.title}</h4>
              {g.items.map((s) => (
                <div className="row" key={`${s.keys}-${s.label}`}>
                  <span><Hl text={tr(s.label)} q={fq} /></span>
                  {s.keys !== "—" ? <kbd><Hl text={s.keys} q={fq} /></kbd> : <span className="muted small">{tr("editor.menuOnly")}</span>}
                </div>
              ))}
            </div>
          ))}
          {!groups.length && <div className="muted">{tr("editor.noShortcutMatch")}</div>}
        </div>
        <div className="muted small">{tr("editor.shortcutsHint")}</div>
      </div>
    </Modal>
  );
}
