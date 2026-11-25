import type { KeyboardEvent } from "react";

/**
 * Điều hướng bàn phím cho danh sách: gắn vào `onKeyDown` của KHUNG chứa các hàng.
 * ↑/↓ = hàng trước/sau, Home/End = đầu/cuối. Hàng là phần tử khớp `row` (phải có `tabIndex={0}`).
 * `select: true` → sau khi chuyển focus thì `click()` hàng đó (danh sách mà click = chọn, kiểu GitHub Desktop).
 * Trả `true` nếu đã xử lý phím (đã preventDefault). Bỏ qua khi đang gõ trong ô nhập.
 */
export function listNav(e: KeyboardEvent<HTMLElement>, opts: { row: string; select?: boolean }): boolean {
  const k = e.key;
  if (k !== "ArrowDown" && k !== "ArrowUp" && k !== "Home" && k !== "End") return false;
  const t = e.target as HTMLElement;
  if (t.closest("input, textarea, select, [contenteditable=true]")) return false;
  const rows = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(opts.row)).filter((r) => r.offsetParent !== null);
  if (!rows.length) return false;
  const cur = rows.findIndex((r) => r === t || r.contains(t));
  let i: number;
  if (k === "Home") i = 0;
  else if (k === "End") i = rows.length - 1;
  else if (cur < 0) i = k === "ArrowDown" ? 0 : rows.length - 1;
  else i = Math.max(0, Math.min(rows.length - 1, cur + (k === "ArrowDown" ? 1 : -1)));
  e.preventDefault();
  const next = rows[i];
  if (next === rows[cur]) return true;
  next.focus();
  next.scrollIntoView({ block: "nearest" });
  if (opts.select) next.click();
  return true;
}

/** Enter / phím Space trên một hàng → gọi hành động (bỏ qua khi phím đến từ ô nhập / nút con). */
export function rowKey(e: KeyboardEvent<HTMLElement>, map: Partial<Record<"Enter" | " " | "Delete" | "F2" | "ArrowLeft" | "ArrowRight" | "Backspace", () => void>>): boolean {
  if (e.target !== e.currentTarget) return false;
  const fn = map[e.key as keyof typeof map];
  if (!fn) return false;
  e.preventDefault();
  fn();
  return true;
}
