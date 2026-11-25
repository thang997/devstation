import { useSyncExternalStore } from "react";
import { Clock, Download, RotateCw, X } from "lucide-react";
import { isTauri } from "@tauri-apps/api/core";
import type { Update } from "@tauri-apps/plugin-updater";
import { Modal } from "./Modal";
import { Spinner } from "./Loading";
import { t, useT } from "../store/lang";

/**
 * Tự cập nhật kiểu GitHub Desktop (tauri-plugin-updater):
 *   kiểm tra latest.json trên GitHub Releases (lúc mở + mỗi 30 phút) → có bản mới thì TỰ TẢI NGẦM
 *   (download, kiểm chữ ký) → status bar hiện "⟳ Restart to update" → bấm → install (NSIS chế độ quiet,
 *   không hiện cửa sổ cài) rồi app tự mở lại vào bản mới.
 * Không chạy ở `app:dev` và ngoài Tauri.
 */

type State =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "none" }
  | { kind: "downloading"; update: Update; done: number; total: number }
  | { kind: "ready"; update: Update }
  | { kind: "installing"; update: Update }
  | { kind: "error"; message: string };

let state: State = { kind: "idle" };
let modalOpen = false;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const set = (s: State) => { state = s; emit(); };
const subscribe = (cb: () => void) => { subs.add(cb); return () => { subs.delete(cb); }; };

export const useUpdateState = () => useSyncExternalStore(subscribe, () => state);

/** Version đang chạy (đọc từ binary qua getVersion; ngoài Tauri thì rỗng). Nạp một lần. */
let appVersion = "";
if (isTauri()) {
  void import("@tauri-apps/api/app")
    .then((m) => m.getVersion())
    .then((v) => { appVersion = v; emit(); })
    .catch(() => {});
}
export const useAppVersion = () => useSyncExternalStore(subscribe, () => appVersion);
const useModalOpen = () => useSyncExternalStore(subscribe, () => modalOpen);
export const openUpdateModal = () => { modalOpen = true; emit(); };
const closeUpdateModal = () => { modalOpen = false; emit(); };

/** Kiểm tra bản mới. `manual` = người dùng bấm (mở modal báo kết quả, kể cả lỗi / đã mới nhất). */
export async function checkForUpdate(manual = false) {
  if (!isTauri() || import.meta.env.DEV) {
    if (manual) { set({ kind: "error", message: t("shell.updateChecksOnlyWorkInThe") }); openUpdateModal(); }
    return;
  }
  // Đang kiểm tra / đang tải / đã tải xong → không kiểm tra lại; bấm tay thì chỉ mở modal xem tình trạng.
  if (state.kind === "checking" || state.kind === "downloading" || state.kind === "ready" || state.kind === "installing") {
    if (manual) openUpdateModal();
    return;
  }
  set({ kind: "checking" });
  if (manual) openUpdateModal();
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) { set({ kind: "none" }); return; }
    void downloadInBackground(update, manual);
  } catch (e) {
    // Lỗi mạng khi tự kiểm tra → im lặng (thử lại ở lần định kỳ sau); chỉ báo khi người dùng tự bấm.
    set(manual ? { kind: "error", message: String(e) } : { kind: "idle" });
  }
}

/** Tải bản mới ngầm (không cài) — xong thì chuyển sang "ready" chờ người dùng bấm khởi động lại. */
async function downloadInBackground(update: Update, manual: boolean) {
  let done = 0;
  let total = 0;
  set({ kind: "downloading", update, done, total });
  try {
    await update.download((ev) => {
      if (ev.event === "Started") total = ev.data.contentLength ?? 0;
      else if (ev.event === "Progress") done += ev.data.chunkLength;
      set({ kind: "downloading", update, done, total });
    });
    set({ kind: "ready", update });
  } catch (e) {
    set(manual ? { kind: "error", message: String(e) } : { kind: "idle" });
  }
}

/** Cài bản đã tải + khởi động lại. Trên Windows install() tự đóng app; trình cài (quiet) mở lại app. */
async function restartToUpdate(update: Update) {
  set({ kind: "installing", update });
  try {
    await update.install();
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch(); // macOS/Linux; Windows thường không tới đây vì app đã được đóng để cài
  } catch (e) {
    set({ kind: "error", message: String(e) });
  }
}

const pct = (done: number, total: number) => (total ? `${Math.min(100, Math.round((done / total) * 100))}%` : "");

/** Version hiện tại ở status bar — bấm để kiểm tra cập nhật. */
export function VersionLabel() {
  const v = useAppVersion();
  const tr = useT();
  if (!v) return null;
  return (
    <button className="sb-version" onClick={() => void checkForUpdate(true)} title={tr("shell.currentVersionClickToCheckFor")}>
      v{v}
    </button>
  );
}

/** Nút ở status bar: đang tải ngầm (mờ) → "⟳ Restart to update" (nổi bật). */
export function UpdateButton() {
  const s = useUpdateState();
  const tr = useT();
  if (s.kind === "downloading") {
    return (
      <button className="sb-version" onClick={openUpdateModal} title={tr("shell.downloadingInBackground")}>
        <Download /> v{s.update.version} {pct(s.done, s.total)}
      </button>
    );
  }
  if (s.kind === "ready" || s.kind === "installing") {
    return (
      <button className="sb-update" onClick={openUpdateModal} title={tr("shell.updateReady", { version: s.update.version })}>
        {s.kind === "installing" ? <Spinner /> : <RotateCw />} {s.kind === "installing" ? tr("shell.installing") : tr("shell.restartToUpdate")}
      </button>
    );
  }
  return null;
}

/** Modal cập nhật — đặt một lần ở Shell. */
export function UpdateHost() {
  const open = useModalOpen();
  const s = useUpdateState();
  const tr = useT();
  if (!open) return null;
  const busy = s.kind === "installing";
  const upd = s.kind === "downloading" || s.kind === "ready" || s.kind === "installing" ? s.update : null;
  return (
    <Modal title={tr("shell.softwareUpdate")} width={480} onClose={() => { if (!busy) closeUpdateModal(); }}>
      <div className="form account-form">
        {s.kind === "checking" && <div className="muted">{tr("shell.checking")}</div>}
        {s.kind === "none" && <div>{tr("shell.youReOnTheLatestVersion")}</div>}
        {s.kind === "error" && <div className="error-box pre">{s.message}</div>}
        {upd && (
          <>
            <div>
              {tr("shell.newVersion")} <b>v{upd.version}</b>
              <span className="muted"> ({tr("shell.current")} v{upd.currentVersion})</span>
            </div>
            {upd.body && <pre className="sql-preview mono" style={{ maxHeight: 200, overflow: "auto", whiteSpace: "pre-wrap" }}>{upd.body}</pre>}
            {s.kind === "downloading" && (
              <div>
                <div className={`update-bar${s.total ? "" : " indeterminate"}`}><div style={s.total ? { width: `${Math.min(100, (s.done / s.total) * 100)}%` } : undefined} /></div>
                <div className="muted small">{tr("shell.downloadingInBackground")}</div>
              </div>
            )}
            {s.kind === "ready" && <div className="muted small">{tr("shell.restartWarning")}</div>}
            {s.kind === "installing" && <div className="muted small">{tr("shell.installing")}</div>}
          </>
        )}
        <div className="toolbar">
          <span className="grow" />
          {s.kind === "ready" ? (
            <>
              <button onClick={closeUpdateModal}><Clock />{tr("shell.later")}</button>
              <button className="primary" onClick={() => void restartToUpdate(s.update)}><RotateCw /> {tr("shell.restartNow")}</button>
            </>
          ) : (
            <button disabled={busy} onClick={closeUpdateModal}><X />{tr("shell.close2")}</button>
          )}
        </div>
      </div>
    </Modal>
  );
}
