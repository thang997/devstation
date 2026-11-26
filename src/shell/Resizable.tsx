import { useCallback, useRef, useState } from "react";
import { t } from "../store/lang";

/**
 * Kích thước một khối, nhớ trong localStorage. Kẹp trong [min, max].
 * Nhận cả giá trị mới lẫn hàm cập nhật (như setState) để kéo liên tục không bị mất delta.
 */
export function useSplitSize(key: string, initial: number, min: number, max: number) {
  const [size, setSize] = useState(() => {
    // Chưa lưu → null; Number(null) = 0 (hữu hạn) sẽ bị kẹp về min thay vì dùng `initial`.
    const raw = localStorage.getItem(`split.${key}`);
    const saved = raw === null || raw === "" ? NaN : Number(raw);
    // Kẹp cả hai đầu: giá trị cũ/hỏng (vd. > max sau khi đổi bố cục) không được làm vỡ layout.
    return Number.isFinite(saved) ? Math.max(min, Math.min(max, saved)) : initial;
  });
  const latest = useRef(size);
  const timer = useRef<number | undefined>(undefined);

  const set = useCallback(
    (next: number | ((prev: number) => number)) => {
      const raw = typeof next === "function" ? next(latest.current) : next;
      const n = Math.round(Math.max(min, Math.min(max, raw)));
      if (n === latest.current) return;
      latest.current = n;
      setSize(n);
      // Kéo chuột bắn sự kiện liên tục — ghi localStorage mỗi lần sẽ làm giật.
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => localStorage.setItem(`split.${key}`, String(n)), 300);
    },
    [key, min, max],
  );

  return [size, set] as const;
}

/**
 * Thanh kéo giữa hai khối. `axis="x"`: kéo ngang (đổi bề rộng), `axis="y"`: kéo dọc (đổi chiều cao).
 * Delta được gộp lại và áp dụng tối đa một lần mỗi khung hình để kéo mượt.
 * Double-click để trả về kích thước mặc định.
 *
 * `live` ("prev" | "next" = khối bị đổi cỡ nằm trước / sau thanh kéo): khi đang kéo chỉ đổi `style.width/height`
 * của khối đó trực tiếp trên DOM (kẹp trong [min, max]), KHÔNG gọi React mỗi khung hình; thả chuột mới gọi
 * `onResize(tổng delta)` một lần. Dùng cho bố cục nặng (app DB với bảng kết quả lớn) — kéo không còn lag vì
 * cả cây component không phải vẽ lại liên tục.
 */
export function Splitter({
  axis,
  onResize,
  onReset,
  title,
  live,
  min = 0,
  max = Infinity,
}: {
  axis: "x" | "y";
  onResize: (delta: number) => void;
  onReset?: () => void;
  title?: string;
  live?: "prev" | "next";
  min?: number;
  max?: number;
}) {
  title ??= t("shell.dragToResizeDoubleClickTo");
  const last = useRef(0);
  const acc = useRef(0);
  const raf = useRef<number | null>(null);
  const dragging = useRef(false);
  const resize = useRef(onResize);
  resize.current = onResize;
  /** Chế độ live: khối đang đổi cỡ, cỡ lúc bắt đầu, tổng delta. */
  const liveEl = useRef<HTMLElement | null>(null);
  const start = useRef(0);
  const total = useRef(0);
  const prop = axis === "x" ? "width" : "height";
  const preview = () => {
    raf.current = null;
    const el = liveEl.current;
    if (!el) return;
    const d = live === "prev" ? total.current : -total.current;
    el.style[prop] = `${Math.round(Math.max(min, Math.min(max, start.current + d)))}px`;
  };

  const flush = () => {
    raf.current = null;
    const d = acc.current;
    acc.current = 0;
    if (d) resize.current(d);
  };

  return (
    <div
      className={`splitter ${axis}`}
      title={title}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        dragging.current = true;
        last.current = axis === "x" ? e.clientX : e.clientY;
        total.current = 0;
        if (live) {
          const el = (live === "prev" ? e.currentTarget.previousElementSibling : e.currentTarget.nextElementSibling) as HTMLElement | null;
          liveEl.current = el;
          start.current = el ? el.getBoundingClientRect()[prop] : 0;
        }
        e.currentTarget.setPointerCapture(e.pointerId);
        document.body.classList.add("resizing");
      }}
      onPointerMove={(e) => {
        if (!dragging.current) {
          // Rê chuột qua vạch (không kéo) cũng đổi con trỏ.
          return;
        }
        const cur = axis === "x" ? e.clientX : e.clientY;
        const d = cur - last.current;
        if (d === 0) return;
        last.current = cur;
        if (liveEl.current) {
          total.current += d;
          if (raf.current === null) raf.current = requestAnimationFrame(preview);
          return;
        }
        acc.current += d;
        if (raf.current === null) raf.current = requestAnimationFrame(flush);
      }}
      onPointerUp={(e) => {
        dragging.current = false;
        e.currentTarget.releasePointerCapture(e.pointerId);
        document.body.classList.remove("resizing");
        if (raf.current !== null) cancelAnimationFrame(raf.current);
        raf.current = null;
        if (liveEl.current) {
          // Thả chuột: chốt vào state một lần (React đặt lại đúng style theo state đã kẹp).
          liveEl.current = null;
          const d = total.current;
          total.current = 0;
          if (d) resize.current(d);
          return;
        }
        flush();
      }}
      onPointerCancel={() => {
        dragging.current = false;
        if (liveEl.current) { liveEl.current.style[prop] = `${Math.round(start.current)}px`; liveEl.current = null; total.current = 0; }
        document.body.classList.remove("resizing");
        acc.current = 0;
      }}
      onDoubleClick={() => onReset?.()}
    />
  );
}
