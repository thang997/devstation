import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";

export interface ComboItem {
  /** Chữ hiển thị trong danh sách. */
  label: string;
  /** Giá trị điền vào ô khi chọn (mặc định = label). */
  insert?: string;
  /** Chữ mờ bên phải (vd. độ dài mặc định). */
  hint?: string;
}

/**
 * Ô nhập có gợi ý (combobox) — gõ để lọc, ↑/↓ chọn, Enter/Tab điền, Esc đóng; nút ▾ mở toàn bộ danh sách.
 * Danh sách render qua portal (position: fixed) để không bị ô bảng / modal cắt — cùng kiểu menu với `Picker`.
 * Vẫn gõ tự do được giá trị không có trong danh sách (vd. `varchar(100)`).
 */
export function Combo({ value, onChange, items, filter, placeholder, className, autoFocus, disabled, onKeyDown, onBlur }: {
  value: string;
  onChange: (v: string) => void;
  items: ComboItem[];
  /** Lọc theo chữ gõ (mặc định: chứa, không phân biệt hoa thường). */
  filter?: (items: ComboItem[], text: string) => ComboItem[];
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  /** Phím mà danh sách KHÔNG dùng (Enter/Esc khi danh sách đóng…) — để ô sửa trong lưới commit/huỷ. */
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  /** Rời ô (sau khi danh sách đóng). */
  onBlur?: () => void;
}) {
  const [open, setOpen] = useState(false);
  /** true = đang lọc theo chữ gõ; false = mở bằng nút ▾ → hiện đủ danh sách. */
  const [typed, setTyped] = useState(false);
  const [hi, setHi] = useState(0);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; width: number; maxHeight: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  const shown = !typed || !value.trim()
    ? items
    : filter ? filter(items, value) : items.filter((i) => i.label.toLowerCase().includes(value.trim().toLowerCase()));

  const place = () => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    const w = Math.max(r.width, 220);
    const below = window.innerHeight - r.bottom - 8;
    const above = r.top - 8;
    const up = below < 220 && above > below;
    setPos({
      left: Math.max(4, Math.min(r.left, window.innerWidth - w - 8)),
      ...(up ? { bottom: window.innerHeight - r.top + 2 } : { top: r.bottom + 2 }),
      width: w,
      maxHeight: Math.max(120, Math.min(320, (up ? above : below) - 4)),
    });
  };

  useEffect(() => {
    if (!open) return;
    place();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !menu.current?.contains(t)) setOpen(false);
    };
    const onScroll = (e: Event) => {
      if (menu.current && e.target instanceof Node && menu.current.contains(e.target)) return;
      setOpen(false);
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("resize", onScroll);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  // Mở bằng ▾ → tô sẵn mục trùng giá trị hiện tại; gõ chữ → tô mục đầu.
  useEffect(() => {
    if (!open) return;
    const cur = typed ? 0 : Math.max(0, shown.findIndex((i) => (i.insert ?? i.label).toLowerCase() === value.trim().toLowerCase()));
    setHi(cur);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, typed, value]);

  useLayoutEffect(() => {
    if (open) menu.current?.querySelector(".combo-item.hi")?.scrollIntoView({ block: "nearest" });
  }, [open, hi]);

  const pick = (it: ComboItem) => {
    onChange(it.insert ?? it.label);
    setOpen(false);
    // Kiểu có độ dài mặc định (varchar(255)) → chọn sẵn phần số để gõ đè ngay.
    requestAnimationFrame(() => {
      const el = input.current;
      if (!el) return;
      el.focus();
      const m = /\(([^)]*)\)/.exec(el.value);
      if (m && m.index !== undefined) el.setSelectionRange(m.index + 1, m.index + 1 + m[1].length);
    });
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) { setTyped(false); setOpen(true); return; }
      const n = shown.length;
      if (n) setHi((h) => (h + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
    } else if ((e.key === "Enter" || e.key === "Tab") && open && shown[hi]) {
      if (e.key === "Enter") e.preventDefault();
      pick(shown[hi]);
    } else if (e.key === "Escape" && open) {
      e.stopPropagation(); // không đóng luôn modal chứa ô này
      setOpen(false);
    } else onKeyDown?.(e);
  };

  return (
    <div className={`combo ${className ?? ""}`} ref={box}>
      <input
        ref={input}
        className="cell-input mono"
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        disabled={disabled}
        spellCheck={false}
        onChange={(e) => { onChange(e.target.value); setTyped(true); setOpen(true); }}
        onKeyDown={onKey}
        onBlur={() => { setOpen(false); onBlur?.(); }}
      />
      <button type="button" className="combo-btn" tabIndex={-1} disabled={disabled}
        onMouseDown={(e) => { e.preventDefault(); input.current?.focus(); setTyped(false); setOpen((o) => !o); }}>
        <ChevronDown />
      </button>
      {open && pos && shown.length > 0 && createPortal(
        <div ref={menu} className="picker-menu combo-menu" onMouseDown={(e) => e.preventDefault()}
          style={{ position: "fixed", left: pos.left, top: pos.top, bottom: pos.bottom, minWidth: pos.width, maxHeight: pos.maxHeight }}>
          <div className="picker-list">
            {shown.map((it, i) => (
              <div key={it.label} className={`picker-item combo-item mono ${i === hi ? "hi" : ""}`}
                onMouseEnter={() => setHi(i)}
                onMouseDown={(e) => { e.preventDefault(); pick(it); }}>
                <span className="grow ellipsis">{it.label}</span>
                {it.hint && <span className="muted small">{it.hint}</span>}
              </div>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
