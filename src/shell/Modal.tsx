import { useEffect, type ReactNode } from "react";

/**
 * Hộp thoại nổi (overlay) giữa cửa sổ: nền mờ, đóng khi bấm ra ngoài / Escape / nút ×.
 * Dùng cho các form phụ (tài khoản Git…) thay vì mở hẳn một tab.
 */
export function Modal({
  title,
  onClose,
  children,
  width = 560,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" style={{ width }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="grow">{title}</span>
          <button className="icon-btn" title="Đóng (Esc)" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
