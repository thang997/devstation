import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useT } from "../store/lang";

export interface PickerItem {
  id: string;
  label: string;
  /** Nhóm hiện phía trên (Local, Remote...). */
  group?: string;
  icon?: ReactNode;
  hint?: string;
  selected?: boolean;
  disabled?: boolean;
  /** Cho phép xoá mục này (hiện nút × khi rê chuột); cần Picker có onRemove. */
  removable?: boolean;
  /** Class thêm cho dòng (vd. tô màu theo method `m-GET`). */
  className?: string;
}

/**
 * Dropdown tự vẽ thay cho <select> — kiểu nút nhánh của GitHub Desktop:
 * bấm mở panel, có ô lọc, chia nhóm, đánh dấu mục đang chọn.
 */
export function Picker({
  label,
  items,
  onPick,
  onRemove,
  onItemContextMenu,
  title,
  disabled,
  filterPlaceholder,
}: {
  label: ReactNode;
  items: PickerItem[];
  onPick: (id: string) => void;
  /** Xoá một mục (× khi rê chuột). Panel vẫn mở để xoá tiếp. */
  onRemove?: (id: string) => void;
  /** Chuột phải trên một mục: panel vẫn mở (menu hiện đè lên), `close` để đóng panel khi đã chọn thao tác. */
  onItemContextMenu?: (id: string, e: ReactMouseEvent, close: () => void) => void;
  title?: string;
  disabled?: boolean;
  filterPlaceholder?: string;
}) {
  const tr = useT();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  /** Vị trí menu (viewport) — menu render qua portal để không bị khung overflow (modal/sidebar) cắt. */
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; width: number; maxHeight: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  const place = () => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    const w = Math.max(r.width, 200);
    // Thiếu chỗ bên dưới (vd. thanh phân trang sát đáy cửa sổ) → mở LÊN trên; chiều cao theo chỗ trống.
    const below = window.innerHeight - r.bottom - 8;
    const above = r.top - 8;
    const up = below < 240 && above > below;
    setPos({
      left: Math.max(4, Math.min(r.left, window.innerWidth - w - 8)),
      ...(up ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }),
      width: w,
      maxHeight: Math.max(120, Math.min(420, (up ? above : below) - 4)),
    });
  };

  useEffect(() => {
    if (!open) return;
    place();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !menu.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    // Cuộn/đổi cỡ cửa sổ → đóng cho khỏi lệch vị trí.
    // NHƯNG bỏ qua cuộn phát ra từ chính menu (danh sách dài) — nếu không, cuộn xem host sẽ tự đóng.
    const onScroll = (e: Event) => {
      const t = e.target;
      if (menu.current && t instanceof Node && menu.current.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onScroll);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  const shown = useMemo(() => {
    const w = q.trim().toLowerCase();
    return w ? items.filter((i) => i.label.toLowerCase().includes(w)) : items;
  }, [q, items]);

  // Chia nhóm theo thứ tự xuất hiện, giữ nguyên thứ tự mục.
  const groups = useMemo(() => {
    const out: { name: string; items: PickerItem[] }[] = [];
    for (const it of shown) {
      const name = it.group ?? "";
      const g = out.find((x) => x.name === name);
      if (g) g.items.push(it);
      else out.push({ name, items: [it] });
    }
    return out;
  }, [shown]);

  return (
    <div className="picker" ref={box}>
      <button
        className={`picker-btn ${open ? "open" : ""}`}
        title={title}
        disabled={disabled}
        onClick={() => { setOpen(!open); setQ(""); }}
      >
        <span className="ellipsis">{label}</span>
        <span className="caret">▾</span>
      </button>
      {open && pos && createPortal(
        <div
          ref={menu}
          className="picker-menu"
          style={{ position: "fixed", left: pos.left, top: pos.top, bottom: pos.bottom, minWidth: pos.width, maxHeight: pos.maxHeight }}
        >
          {items.length > 8 && (
            <input
              autoFocus
              className="picker-filter"
              placeholder={filterPlaceholder ?? tr("shell.filter")}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && shown[0] && !shown[0].disabled) {
                  setOpen(false);
                  onPick(shown[0].id);
                }
              }}
            />
          )}
          <div className="picker-list">
            {groups.map((g) => (
              <div key={g.name}>
                {g.name && <div className="picker-group">{g.name}</div>}
                {g.items.map((it) => (
                  <div
                    key={it.id}
                    className={`picker-item ${it.selected ? "on" : ""} ${it.disabled ? "disabled" : ""} ${it.className ?? ""}`}
                    onClick={() => {
                      if (it.disabled) return;
                      setOpen(false);
                      onPick(it.id);
                    }}
                    onContextMenu={
                      onItemContextMenu
                        ? (e) => { e.preventDefault(); e.stopPropagation(); onItemContextMenu(it.id, e, () => setOpen(false)); }
                        : undefined
                    }
                  >
                    <span className="picker-check">{it.selected ? "✓" : ""}</span>
                    {it.icon && <span className="picker-icon">{it.icon}</span>}
                    <span className="grow ellipsis">{it.label}</span>
                    {it.hint && <span className="muted small ellipsis">{it.hint}</span>}
                    {it.removable && onRemove && (
                      <button
                        className="picker-x"
                        title={tr("shell.removeFromList")}
                        onClick={(e) => { e.stopPropagation(); onRemove(it.id); }}
                      >
                        ×
                      </button>
                    )}
                  </div>
                ))}
              </div>
            ))}
            {!shown.length && <div className="muted small pad">{tr("shell.noMatchingItems")}</div>}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
