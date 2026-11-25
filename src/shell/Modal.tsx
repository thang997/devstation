import { X } from "lucide-react";
import { createContext, useContext, useEffect, useId, useRef, type ReactNode } from "react";
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
  const boxRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Mở: nhớ phần tử đang focus, đưa focus vào modal (nếu bên trong chưa có ô autoFocus). Đóng: trả focus lại.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => {
      const el = boxRef.current;
      if (el && !el.contains(document.activeElement)) el.focus();
    }, 0);
    return () => { clearTimeout(t); if (prev && prev.isConnected) prev.focus(); };
  }, []);
  /** Tab / Shift+Tab xoay vòng trong modal, không lọt ra phía sau nền mờ. */
  const trapTab = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const el = boxRef.current;
    if (!el) return;
    const f = Array.from(el.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
      .filter((x) => x.offsetParent !== null);
    if (!f.length) { e.preventDefault(); return; }
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === el)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Ô bên trong đã xử lý Esc (huỷ sửa tại chỗ…) → không đóng modal.
      if (e.defaultPrevented) return;
      // Modal của app đang ẩn (đã chuyển sang tab app khác) thì không phản ứng phím Esc.
      if (layer?.el?.closest(".app-host")?.hasAttribute("hidden")) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, layer]);

  const box = (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" ref={boxRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        style={{ width }} onMouseDown={(e) => e.stopPropagation()} onKeyDown={trapTab}>
        <div className="modal-head">
          <span className="grow" id={titleId}>{title}</span>
          <button className="icon-btn" title={tr("shell.closeEsc")} aria-label={tr("shell.closeEsc")} onClick={onClose}><X /></button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
  if (!layer) return box; // modal cấp Shell
  return layer.el ? createPortal(box, layer.el) : null; // lớp chưa gắn (lần render đầu) → chờ
}
