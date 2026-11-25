import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { Check, ChevronDown, X } from "lucide-react";
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
 * Bàn phím: ↓/Enter/Space trên nút mở panel; trong panel ↑/↓/Home/End chọn mục (bỏ qua disabled), Enter chọn,
 * Esc/Tab đóng và trả focus về nút.
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
  keepOpen,
  autoOpen,
  onClose,
  onOpen,
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
  /** Chọn xong vẫn để menu mở (chọn nhiều mục liên tiếp, vd. nhiều cột). */
  keepOpen?: boolean;
  /** Mở sẵn khi vừa hiện (vd. double-click một ô để sửa). */
  autoOpen?: boolean;
  /** Panel vừa đóng (chọn xong / bấm ra ngoài / Esc). */
  onClose?: () => void;
  /** Panel vừa mở (vd. nạp dữ liệu phụ lười, chỉ khi người dùng cần xem). */
  onOpen?: () => void;
}) {
  const tr = useT();
  const [open, setOpen] = useState(!!autoOpen);
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current && !open) onClose?.();
    if (!wasOpen.current && open) onOpen?.();
    wasOpen.current = open;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const [q, setQ] = useState("");
  /** Vị trí menu (viewport) — menu render qua portal để không bị khung overflow (modal/sidebar) cắt. */
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; width: number; maxHeight: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  /** Mục đang được chọn bằng phím (id). */
  const [hi, setHi] = useState<string | null>(null);

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
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); btn.current?.focus(); } };
    // Cuộn/đổi cỡ cửa sổ → đóng cho khỏi lệch vị trí.
    // NHƯNG bỏ qua cuộn phát ra từ chính menu (danh sách dài) — nếu không, cuộn xem host sẽ tự đóng.
    const onScroll = (e: Event) => {
      const t = e.target;
      if (menu.current && t instanceof Node && menu.current.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onScroll);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
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

  /** Thứ tự hiển thị thực (theo nhóm) — để ↑/↓ đi đúng thứ tự trên màn hình. */
  const flat = useMemo(() => groups.flatMap((g) => g.items).filter((i) => !i.disabled), [groups]);
  // Mở panel / đổi bộ lọc → chọn sẵn mục đang chọn (hoặc mục đầu).
  useEffect(() => {
    if (!open) return;
    setHi((cur) => (cur && flat.some((i) => i.id === cur) ? cur : (flat.find((i) => i.selected) ?? flat[0])?.id ?? null));
  }, [open, flat]);
  useEffect(() => {
    if (!open || !hi) return;
    menu.current?.querySelector(`[data-pid="${CSS.escape(hi)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [hi, open]);
  const choose = (it: PickerItem) => {
    if (it.disabled) return;
    if (!keepOpen) { setOpen(false); btn.current?.focus(); }
    onPick(it.id);
  };
  const navKey = (e: React.KeyboardEvent) => {
    if (!flat.length) return;
    const at = flat.findIndex((i) => i.id === hi);
    const go = (i: number) => { e.preventDefault(); setHi(flat[(i + flat.length) % flat.length].id); };
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at < 0 ? flat.length - 1 : at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(flat.length - 1);
    else if (e.key === "Enter" || (e.key === " " && (e.target as HTMLElement).tagName !== "INPUT")) {
      const it = flat[at >= 0 ? at : 0];
      if (it) { e.preventDefault(); choose(it); }
    } else if (e.key === "Tab") { setOpen(false); }
  };
  // Panel không có ô lọc → focus vào panel để nhận phím.
  useEffect(() => {
    if (open && pos && items.length <= 8) menu.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, !!pos]);

  // Bề rộng nút cố định theo mục DÀI NHẤT (kẹp 28 ký tự) → chọn mục khác không làm nút co giãn, xô lệch
  // các thứ bên cạnh. Chữ dài hơn thì cắt "…".
  const minCh = useMemo(() => Math.min(28, items.reduce((m, it) => Math.max(m, it.label.length), 0)), [items]);

  return (
    <div className="picker" ref={box}>
      <button
        className={`picker-btn ${open ? "open" : ""}`}
        style={minCh ? { minWidth: `calc(${minCh}ch + 34px)` } : undefined}
        ref={btn}
        title={title}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => { setOpen(!open); setQ(""); }}
        onKeyDown={(e) => { if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); setOpen(true); setQ(""); } }}
      >
        <span className="ellipsis grow">{label}</span>
        <span className="caret"><ChevronDown /></span>
      </button>
      {open && pos && createPortal(
        <div
          ref={menu}
          className="picker-menu"
          role="listbox"
          tabIndex={-1}
          onKeyDown={navKey}
          style={{ position: "fixed", left: pos.left, top: pos.top, bottom: pos.bottom, minWidth: pos.width, maxHeight: pos.maxHeight }}
        >
          {items.length > 8 && (
            <input
              autoFocus
              className="picker-filter"
              placeholder={filterPlaceholder ?? tr("shell.filter")}
              value={q}
              onChange={(e) => setQ(e.target.value)}

            />
          )}
          <div className="picker-list">
            {groups.map((g) => (
              <div key={g.name}>
                {g.name && <div className="picker-group">{g.name}</div>}
                {g.items.map((it) => (
                  <div
                    key={it.id}
                    data-pid={it.id}
                    role="option"
                    aria-selected={!!it.selected}
                    aria-disabled={it.disabled || undefined}
                    className={`picker-item ${it.selected ? "on" : ""} ${it.disabled ? "disabled" : ""} ${hi === it.id ? "hi" : ""} ${it.className ?? ""}`}
                    onMouseMove={() => { if (!it.disabled && hi !== it.id) setHi(it.id); }}
                    onClick={() => choose(it)}
                    onContextMenu={
                      onItemContextMenu
                        ? (e) => { e.preventDefault(); e.stopPropagation(); onItemContextMenu(it.id, e, () => setOpen(false)); }
                        : undefined
                    }
                  >
                    <span className="picker-check">{it.selected ? <Check /> : null}</span>
                    {it.icon && <span className="picker-icon">{it.icon}</span>}
                    <span className="grow ellipsis">{it.label}</span>
                    {it.hint && <span className="muted small ellipsis">{it.hint}</span>}
                    {it.removable && onRemove && (
                      <button
                        className="picker-x"
                        title={tr("shell.removeFromList")}
                        aria-label={tr("shell.removeFromList")}
                        onClick={(e) => { e.stopPropagation(); onRemove(it.id); }}
                      >
                        <X />
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
