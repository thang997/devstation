import { X } from "lucide-react";
import { createContext, useContext, useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useT } from "../store/lang";

/**
 * Lớp chứa modal của MỘT app (AppHost cung cấp). Modal mở trong app được portal vào đây →
 * chỉ phủ vùng làm việc của app đó: thanh tab app + status bar vẫn bấm được, chuyển sang app khác
 * rồi quay lại thì modal vẫn còn nguyên. `undefined` = ngoài app (modal cấp Shell, phủ toàn cửa sổ).
 */
export const ModalLayerContext = createContext<{ el: HTMLElement | null } | undefined>(undefined);

/**
 * Hộp thoại nổi (overlay): nền mờ, đóng khi bấm ra ngoài / Escape / nút ×.
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
  const tr = useT();
  const layer = useContext(ModalLayerContext);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Modal của app đang ẩn (đã chuyển sang tab app khác) thì không phản ứng phím Esc.
      if (layer?.el?.closest(".app-host")?.hasAttribute("hidden")) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, layer]);

  const box = (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" style={{ width }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="grow">{title}</span>
          <button className="icon-btn" title={tr("shell.closeEsc")} onClick={onClose}><X /></button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
  if (!layer) return box; // modal cấp Shell
  return layer.el ? createPortal(box, layer.el) : null; // lớp chưa gắn (lần render đầu) → chờ
}
