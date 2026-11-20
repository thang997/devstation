import { useSyncExternalStore } from "react";
import { Check, CircleX } from "lucide-react";
import { t } from "../store/lang";

/** Thông báo nhỏ sau khi copy (một cái mỗi cửa sổ, `<CopyToast/>` đặt ở Shell). */
interface Toast { id: number; ok: boolean; text: string }

let current: Toast | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let seq = 0;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

function show(ok: boolean, text: string) {
  current = { id: ++seq, ok, text };
  emit();
  clearTimeout(timer);
  timer = setTimeout(() => { current = null; emit(); }, ok ? 1600 : 3000);
}

/** Đoạn xem trước gọn một dòng (tối đa ~60 ký tự). */
function preview(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > 60 ? `${one.slice(0, 57)}…` : one;
}

/** Copy vào clipboard + hiện thông báo "Đã copy" (hoặc lỗi). Dùng cho MỌI nút/menu Copy. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    show(true, preview(text));
    return true;
  } catch {
    show(false, "");
    return false;
  }
}

export function CopyToast() {
  const toast = useSyncExternalStore(
    (f) => { subs.add(f); return () => subs.delete(f); },
    () => current,
  );
  if (!toast) return null;
  return (
    <div key={toast.id} className={`copy-toast${toast.ok ? "" : " bad"}`} role="status">
      {toast.ok ? <Check /> : <CircleX />}
      <span>{toast.ok ? t("shell.copied") : t("shell.copyFailed")}</span>
      {toast.text && <span className="copy-toast-text mono">{toast.text}</span>}
    </div>
  );
}
