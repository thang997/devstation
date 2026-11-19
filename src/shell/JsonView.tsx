import { memo, useMemo, type ReactNode } from "react";

/**
 * Nhận diện + hiển thị JSON đẹp (thụt lề 2, tô màu khoá / chuỗi / số / true-false-null).
 * Dùng cho giá trị string của Redis; có thể dùng lại ở chỗ khác.
 */

/** Chuỗi là JSON object/array hợp lệ → giá trị đã parse; không phải → undefined. */
export function parseJsonValue(text: string | null | undefined): unknown {
  if (!text) return undefined;
  const t = text.trim();
  if (!(t.startsWith("{") && t.endsWith("}")) && !(t.startsWith("[") && t.endsWith("]"))) return undefined;
  try { return JSON.parse(t); } catch { return undefined; }
}

const TOKEN = /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
/** Quá dài thì không tô màu (tạo hàng trăm nghìn span sẽ chậm) — vẫn thụt lề. */
const HIGHLIGHT_MAX = 300_000;

function highlight(src: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0, i = 0;
  for (const m of src.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) out.push(src.slice(last, at));
    if (m[1] !== undefined) {
      if (m[2] !== undefined) { out.push(<span key={i++} className="js-key">{m[1]}</span>, m[2]); }
      else out.push(<span key={i++} className="js-str">{m[1]}</span>);
    } else if (m[3] !== undefined) out.push(<span key={i++} className={m[3] === "null" ? "js-null" : "js-bool"}>{m[3]}</span>);
    else out.push(<span key={i++} className="js-num">{m[4]}</span>);
    last = at + m[0].length;
  }
  if (last < src.length) out.push(src.slice(last));
  return out;
}

export const JsonView = memo(function JsonView({ value, className }: { value: unknown; className?: string }) {
  const text = useMemo(() => JSON.stringify(value, null, 2), [value]);
  const nodes = useMemo(() => (text.length > HIGHLIGHT_MAX ? [text] : highlight(text)), [text]);
  return <pre className={`json-view mono ${className ?? ""}`}>{nodes}</pre>;
});
