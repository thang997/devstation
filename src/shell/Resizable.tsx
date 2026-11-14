import { useCallback, useRef, useState } from "react";

/**
 * Kích thước một khối, nhớ trong localStorage. Kẹp trong [min, max].
 * Nhận cả giá trị mới lẫn hàm cập nhật (như setState) để kéo liên tục không bị mất delta.
 */
export function useSplitSize(key: string, initial: number, min: number, max: number) {
  const [size, setSize] = useState(() => {
    const saved = Number(localStorage.getItem(`split.${key}`));
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
 */
export function Splitter({
  axis,
  onResize,
  onReset,
  title = "Kéo để đổi kích thước · double-click để trả lại mặc định",
}: {
  axis: "x" | "y";
  onResize: (delta: number) => void;
  onReset?: () => void;
  title?: string;
}) {
  const last = useRef(0);
  const acc = useRef(0);
  const raf = useRef<number | null>(null);
  const dragging = useRef(false);
  const resize = useRef(onResize);
  resize.current = onResize;

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
        acc.current += d;
        if (raf.current === null) raf.current = requestAnimationFrame(flush);
      }}
      onPointerUp={(e) => {
        dragging.current = false;
        e.currentTarget.releasePointerCapture(e.pointerId);
        document.body.classList.remove("resizing");
        if (raf.current !== null) cancelAnimationFrame(raf.current);
        flush();
      }}
      onPointerCancel={() => {
        dragging.current = false;
        document.body.classList.remove("resizing");
        acc.current = 0;
      }}
      onDoubleClick={() => onReset?.()}
    />
  );
}
