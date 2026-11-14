// Icon SVG dùng chung (nhẹ, eager) — để cả launcher (shell) lẫn app db dùng chung một hình.

/** Icon database: hình trụ 3 tầng màu xanh (kiểu Navicat/DBeaver). inline-block để không gây xuống dòng. */
export function DbIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden
      style={{ flex: "0 0 auto", display: "inline-block", verticalAlign: "middle" }}>
      <path d="M3 3.5 L3 12.5 C3 13.6 5.24 14.4 8 14.4 C10.76 14.4 13 13.6 13 12.5 L13 3.5 Z" fill="#2f81f7" />
      <ellipse cx="8" cy="3.5" rx="5" ry="1.95" fill="#58a6ff" />
      <path d="M3 6.7 C3 7.8 5.24 8.6 8 8.6 C10.76 8.6 13 7.8 13 6.7" fill="none" stroke="#0b1220" strokeOpacity="0.4" strokeWidth="0.9" />
      <path d="M3 9.7 C3 10.8 5.24 11.6 8 11.6 C10.76 11.6 13 10.8 13 9.7" fill="none" stroke="#0b1220" strokeOpacity="0.4" strokeWidth="0.9" />
    </svg>
  );
}

/** Icon bảng: khung lưới (header + 1 cột chia) theo màu chữ hiện tại. */
export function TableIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden
      style={{ flex: "0 0 auto", display: "inline-block", verticalAlign: "middle", color: "var(--muted)" }}>
      <rect x="2.3" y="3.3" width="11.4" height="9.4" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.1" />
      <line x1="2.3" y1="6.4" x2="13.7" y2="6.4" stroke="currentColor" strokeWidth="1.1" />
      <line x1="7" y1="6.4" x2="7" y2="12.7" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}
