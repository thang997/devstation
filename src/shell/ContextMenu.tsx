import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface CtxItem {
  id: string;
  /** Bỏ trống + sep: true để vẽ đường kẻ. */
  label?: string;
  /** Icon nhỏ hiện trước nhãn (emoji/glyph/SVG). */
  icon?: ReactNode;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  sep?: boolean;
  action?: () => void;
}

/** Menu chuột phải: định vị theo con trỏ, tự né mép màn hình, đóng khi bấm ra ngoài / Escape. */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: CtxItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y, visible: false });

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
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      className="ctx"
      style={{ left: pos.x, top: pos.y, visibility: pos.visible ? "visible" : "hidden" }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it) =>
        it.sep ? (
          <div key={it.id} className="ctx-sep" />
        ) : (
          <div
            key={it.id}
            className={`ctx-item ${it.danger ? "danger" : ""} ${it.disabled ? "disabled" : ""}`}
            onClick={() => {
              if (it.disabled) return;
              onClose();
              it.action?.();
            }}
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
