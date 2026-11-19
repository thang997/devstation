import type { CSSProperties, ReactNode } from "react";
import { useT } from "../store/lang";

/**
 * Hiển thị "đang tải" DÙNG CHUNG cho mọi app — một kiểu vòng xoay, một màu, một cách đặt chữ.
 * - `center` (mặc định): chiếm chỗ trống còn lại, vòng xoay + chữ ở GIỮA (màn hình đang kết nối, panel trống).
 * - `row`: một dòng nhỏ trong danh sách / cây (đang tải thêm, đang mở node).
 * - `inline`: nằm cùng dòng chữ (toolbar, thanh trạng thái).
 * Trong nút bấm dùng `<Spinner />` thay icon.
 */
export function Spinner({ className }: { className?: string }) {
  return <span className={`spinner ${className ?? ""}`} aria-hidden />;
}

export function Loading({ label, variant = "center", className, style, title }: {
  label?: ReactNode;
  variant?: "center" | "row" | "inline";
  className?: string;
  style?: CSSProperties;
  title?: string;
}) {
  const tr = useT();
  const text = label ?? tr("shell.loadingDots");
  const cls = `loading loading-${variant} ${className ?? ""}`;
  if (variant === "inline") return <span className={cls} style={style} title={title}><Spinner /><span className="loading-text">{text}</span></span>;
  return <div className={cls} style={style} title={title}><Spinner /><span className="loading-text">{text}</span></div>;
}
