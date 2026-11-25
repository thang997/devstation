import { useSyncExternalStore } from "react";
import { Check, Trash2, X } from "lucide-react";
import { Modal } from "./Modal";
import { t, useT } from "../store/lang";

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
      title: opts.title ?? t("shell.confirm"),
      message: opts.message,
      confirmLabel: opts.confirmLabel ?? t("shell.delete"),
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
  const tr = useT();
  const req = useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => current);
  if (!req) return null;
  return (
    <Modal title={req.title} width={420} onClose={() => close(false)}>
      <div className="form account-form">
        <div style={{ whiteSpace: "pre-line" }}>{req.message}</div>
        <div className="toolbar">
          <span className="grow" />
          <button onClick={() => close(false)}><X />{tr("shell.cancel")}</button>
          <button className={`primary ${req.danger ? "danger" : ""}`} autoFocus onClick={() => close(true)}>{req.danger ? <Trash2 /> : <Check />}{req.confirmLabel}</button>
        </div>
      </div>
    </Modal>
  );
}
