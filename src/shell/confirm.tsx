import { useSyncExternalStore } from "react";
import { Modal } from "./Modal";

interface Req {
  title: string;
  message: string;
  confirmLabel: string;
  danger: boolean;
  resolve: (ok: boolean) => void;
}

let current: Req | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

/** Hỏi xác nhận (dùng chung mọi app). Trả về Promise<boolean>. */
export function confirmDialog(opts: {
  title?: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    // Nếu có hộp cũ chưa trả lời → coi như huỷ nó.
    current?.resolve(false);
    current = {
      title: opts.title ?? "Xác nhận",
      message: opts.message,
      confirmLabel: opts.confirmLabel ?? "Xoá",
      danger: opts.danger ?? true,
      resolve,
    };
    emit();
  });
}

function close(ok: boolean) {
  const c = current;
  current = null;
  emit();
  c?.resolve(ok);
}

/** Đặt một lần ở gốc app (Shell). */
export function ConfirmHost() {
  const req = useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => current);
  if (!req) return null;
  return (
    <Modal title={req.title} width={420} onClose={() => close(false)}>
      <div className="form account-form">
        <div className="muted small">{req.message}</div>
        <div className="toolbar">
          <span className="grow" />
          <button onClick={() => close(false)}>Huỷ</button>
          <button className={`primary ${req.danger ? "danger" : ""}`} autoFocus onClick={() => close(true)}>{req.confirmLabel}</button>
        </div>
      </div>
    </Modal>
  );
}
