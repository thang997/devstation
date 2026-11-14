import { useSyncExternalStore } from "react";
import { isTauri } from "@tauri-apps/api/core";
import type { Update } from "@tauri-apps/plugin-updater";
import { Modal } from "./Modal";
import { useT } from "../store/lang";

/**
 * Tự cập nhật (tauri-plugin-updater): khi mở app đọc latest.json trên GitHub Releases,
 * có bản mới hơn thì hiện nút ở status bar → modal tải + cài (kiểm chữ ký) → khởi động lại.
 * Không chạy ở `app:dev` và ngoài Tauri.
 */

type State =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "none" }
  | { kind: "available"; update: Update }
  | { kind: "downloading"; update: Update; done: number; total: number }
  | { kind: "error"; message: string };

let state: State = { kind: "idle" };
let modalOpen = false;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const set = (s: State) => { state = s; emit(); };
const subscribe = (cb: () => void) => { subs.add(cb); return () => { subs.delete(cb); }; };

export const useUpdateState = () => useSyncExternalStore(subscribe, () => state);
const useModalOpen = () => useSyncExternalStore(subscribe, () => modalOpen);
export const openUpdateModal = () => { modalOpen = true; emit(); };
const closeUpdateModal = () => { modalOpen = false; emit(); };

/** Kiểm tra bản mới. `manual` = người dùng bấm (báo cả khi không có / lỗi). */
export async function checkForUpdate(manual = false) {
  if (!isTauri() || import.meta.env.DEV) {
    if (manual) set({ kind: "error", message: "Chỉ kiểm tra cập nhật được ở bản đã cài (không phải app:dev)." });
    if (manual) openUpdateModal();
    return;
  }
  if (state.kind === "checking" || state.kind === "downloading") return;
  set({ kind: "checking" });
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (update) set({ kind: "available", update });
    else set({ kind: "none" });
  } catch (e) {
    // Lỗi mạng khi tự kiểm tra lúc mở app → im lặng; chỉ báo khi người dùng tự bấm.
    set(manual ? { kind: "error", message: String(e) } : { kind: "idle" });
  }
  if (manual) openUpdateModal();
}

async function installUpdate(update: Update) {
  set({ kind: "downloading", update, done: 0, total: 0 });
  try {
    let done = 0;
    let total = 0;
    await update.downloadAndInstall((ev) => {
      if (ev.event === "Started") total = ev.data.contentLength ?? 0;
      else if (ev.event === "Progress") done += ev.data.chunkLength;
      set({ kind: "downloading", update, done, total });
    });
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (e) {
    set({ kind: "error", message: String(e) });
  }
}

const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;

/** Nút ở status bar — chỉ hiện khi có bản mới / đang tải. */
export function UpdateButton() {
  const s = useUpdateState();
  const tr = useT();
  if (s.kind !== "available" && s.kind !== "downloading") return null;
  return (
    <button className="sb-update" onClick={openUpdateModal} title={tr("A new version is available", "Có phiên bản mới")}>
      ⬆ {s.kind === "downloading" ? tr("Updating…", "Đang cập nhật…") : `v${s.update.version}`}
    </button>
  );
}

/** Modal cập nhật — đặt một lần ở Shell. */
export function UpdateHost() {
  const open = useModalOpen();
  const s = useUpdateState();
  const tr = useT();
  if (!open) return null;
  const downloading = s.kind === "downloading";
  return (
    <Modal title={tr("⬆ Software update", "⬆ Cập nhật phần mềm")} width={480} onClose={() => { if (!downloading) closeUpdateModal(); }}>
      <div className="form account-form" style={{ maxWidth: "none" }}>
        {s.kind === "checking" && <div className="muted">{tr("Checking…", "Đang kiểm tra…")}</div>}
        {s.kind === "none" && <div>{tr("You're on the latest version.", "Bạn đang dùng phiên bản mới nhất.")}</div>}
        {s.kind === "error" && <div className="error-box pre">{s.message}</div>}
        {(s.kind === "available" || s.kind === "downloading") && (
          <>
            <div>
              {tr("New version", "Phiên bản mới")} <b>v{s.update.version}</b>
              <span className="muted"> ({tr("current", "đang dùng")} v{s.update.currentVersion})</span>
            </div>
            {s.update.body && <pre className="sql-preview mono" style={{ maxHeight: 200, overflow: "auto", whiteSpace: "pre-wrap" }}>{s.update.body}</pre>}
            {downloading && (
              <div>
                <div className="update-bar"><div style={{ width: s.total ? `${Math.min(100, (s.done / s.total) * 100)}%` : "30%" }} /></div>
                <div className="muted small">{s.total ? `${mb(s.done)} / ${mb(s.total)}` : mb(s.done)} — {tr("the app restarts when done", "xong sẽ tự khởi động lại")}</div>
              </div>
            )}
          </>
        )}
        <div className="toolbar">
          <span className="grow" />
          {s.kind === "available" ? (
            <>
              <button onClick={closeUpdateModal}>{tr("Later", "Để sau")}</button>
              <button className="primary" onClick={() => void installUpdate(s.update)}>{tr("Update & restart", "Cập nhật & khởi động lại")}</button>
            </>
          ) : (
            <button disabled={downloading} onClick={closeUpdateModal}>{tr("Close", "Đóng")}</button>
          )}
        </div>
      </div>
    </Modal>
  );
}
