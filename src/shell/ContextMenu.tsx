import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface CtxItem {
  id: string;
  /** Bỏ trống + sep: true để vẽ đường kẻ. */
  label?: string;
  /** Icon lucide hiện trước nhãn (`<Trash2 />`). */
  icon?: ReactNode;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  sep?: boolean;
  action?: () => void;
}

/** Menu chuột phải: định vị theo con trỏ, tự né mép màn hình, đóng khi bấm ra ngoài / Escape.
 *  Bàn phím: ↑/↓ (bỏ qua mục disabled/đường kẻ), Home/End, Enter/Space chọn, Esc/Tab đóng; mở ra focus vào menu,
 *  đóng thì trả focus về phần tử trước đó. */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: CtxItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y, visible: false });
  const [hi, setHi] = useState(-1);
  const usable = items.map((it, i) => (!it.sep && !it.disabled ? i : -1)).filter((i) => i >= 0);
  const pick = (it: CtxItem) => { if (it.disabled) return; onClose(); it.action?.(); };
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => { if (prev && prev.isConnected) prev.focus(); };
  }, []);
  const onMenuKey = (e: React.KeyboardEvent) => {
    if (!usable.length) return;
    const at = usable.indexOf(hi);
    if (e.key === "ArrowDown") { e.preventDefault(); setHi(usable[at < 0 ? 0 : (at + 1) % usable.length]); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi(usable[at < 0 ? usable.length - 1 : (at - 1 + usable.length) % usable.length]); }
    else if (e.key === "Home") { e.preventDefault(); setHi(usable[0]); }
    else if (e.key === "End") { e.preventDefault(); setHi(usable[usable.length - 1]); }
    else if ((e.key === "Enter" || e.key === " ") && hi >= 0) { e.preventDefault(); pick(items[hi]); }
    else if (e.key === "Tab") { e.preventDefault(); onClose(); }
  };

  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setPos({
      x: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)),
      y: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)),
      visible: true,
    });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      className="ctx"
      role="menu"
      tabIndex={-1}
      style={{ left: pos.x, top: pos.y, visibility: pos.visible ? "visible" : "hidden" }}
      onKeyDown={onMenuKey}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) =>
        it.sep ? (
          <div key={it.id} className="ctx-sep" role="separator" />
        ) : (
          <div
            key={it.id}
            role="menuitem"
            aria-disabled={it.disabled || undefined}
            className={`ctx-item ${it.danger ? "danger" : ""} ${it.disabled ? "disabled" : ""} ${i === hi ? "hi" : ""}`}
            onMouseEnter={() => setHi(it.disabled ? -1 : i)}
            onClick={() => pick(it)}
          >
            {it.icon !== undefined && <span className="ctx-icon">{it.icon}</span>}
            <span className="grow ellipsis">{it.label}</span>
            {it.hint && <span className="ctx-hint ellipsis">{it.hint}</span>}
          </div>
        ),
      )}
    </div>,
    document.body,
  );
}
