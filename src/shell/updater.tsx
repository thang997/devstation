import { useSyncExternalStore } from "react";
import { Clock, Download, RotateCw, X } from "lucide-react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { Modal } from "./Modal";
import { Spinner } from "./Loading";
import { t, useT } from "../store/lang";

/**
 * Tự cập nhật kiểu GitHub Desktop — tải + giữ bản mới ở PHÍA RUST (`src-tauri/src/update.rs`):
 *   cửa sổ main kiểm tra latest.json (lúc mở + mỗi 30 phút) → có bản mới thì Rust TỰ TẢI NGẦM (kiểm chữ ký, status bar
 *   không hiện gì) → xong phát `ds-update` tới mọi cửa sổ → status bar hiện "⬇ vX" → bấm → modal ghi chú:
 *   "Khởi động lại ngay" = cài (NSIS quiet) + mở lại; "Muộn hơn" = giữ bản đã tải, TẮT HẲN APP LÀ CÀI LUÔN (không mở
 *   lại) → lần mở sau là bản mới. Trước đây byte bản mới nằm trong cửa sổ main (API JS) → tắt app là mất.
 * Không chạy ở `app:dev` và ngoài Tauri.
 */

/** Thông tin bản mới (từ Rust `UpdInfo`). */
interface UpdInfo { version: string; currentVersion: string; body?: string | null }
interface UpdStatus { phase: "idle" | "downloading" | "ready"; info: UpdInfo | null; done: number; total: number }

type State =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "none" }
  | { kind: "downloading"; update: UpdInfo; done: number; total: number }
  | { kind: "ready"; update: UpdInfo }
  | { kind: "installing"; update: UpdInfo }
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
export const openUpdateModal = () => { modalOpen = true; emit(); pollWhileDownloading(); };
const closeUpdateModal = () => { modalOpen = false; emit(); };

const enabled = isTauri() && !import.meta.env.DEV;

/** Áp trạng thái từ Rust (không đè trạng thái "đang cài" / lỗi người dùng đang xem). */
function apply(st: UpdStatus) {
  if (state.kind === "installing") return;
  if (st.phase === "ready" && st.info) set({ kind: "ready", update: st.info });
  else if (st.phase === "downloading" && st.info) set({ kind: "downloading", update: st.info, done: st.done, total: st.total });
}

// Mọi cửa sổ: đồng bộ trạng thái lúc mở (bản mới có thể đã tải xong từ trước) + nghe `ds-update` của Rust.
if (enabled) {
  void invoke<UpdStatus>("update_status").then(apply).catch(() => {});
  void import("@tauri-apps/api/event").then(({ listen }) => listen<UpdStatus>("ds-update", (e) => apply(e.payload))).catch(() => {});
}

/** Modal đang mở lúc tải (người dùng bấm kiểm tra) → đọc tiến trình mỗi 500ms cho thanh %; status bar không hiện %. */
let polling = false;
function pollWhileDownloading() {
  if (!enabled || polling) return;
  polling = true;
  const tick = async () => {
    if (!modalOpen || state.kind !== "downloading") { polling = false; return; }
    apply(await invoke<UpdStatus>("update_status").catch(() => ({ phase: "idle", info: null, done: 0, total: 0 } as UpdStatus)));
    setTimeout(() => void tick(), 500);
  };
  void tick();
}

/** Kiểm tra bản mới (Rust tự tải ngầm nếu có). `manual` = người dùng bấm (mở modal báo kết quả, kể cả lỗi / đã mới nhất). */
export async function checkForUpdate(manual = false) {
  if (!enabled) {
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
  if (manual) setTimeout(pollWhileDownloading, 800); // check xong mới bắt đầu tải → theo dõi tiến trình trong modal
  try {
    const st = await invoke<UpdStatus>("update_check");
    if (st.phase === "idle") set({ kind: "none" });
    else apply(st);
  } catch (e) {
    // Lỗi mạng khi tự kiểm tra → im lặng (thử lại ở lần định kỳ sau); chỉ báo khi người dùng tự bấm.
    set(manual ? { kind: "error", message: String(e) } : { kind: "idle" });
  }
}

/** "Khởi động lại ngay": Rust cài bản đã tải + mở lại app (Windows: app thoát ngay, trình cài quiet mở lại). */
async function restartToUpdate(update: UpdInfo) {
  set({ kind: "installing", update });
  try {
    await invoke("update_install");
  } catch (e) {
    set({ kind: "error", message: String(e) });
  }
}

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

/** Nút ở status bar: đang tải ngầm → KHÔNG hiện gì; tải xong → "⬇ v<mới>", bấm → modal ghi chú cập nhật +
 *  "Khởi động lại ngay" (cài bản đã tải sẵn); đang cài → spinner. */
export function UpdateButton() {
  const s = useUpdateState();
  const tr = useT();
  if (s.kind === "ready") {
    return (
      <button className="sb-update" onClick={openUpdateModal} title={tr("shell.updateReady", { version: s.update.version })}>
        <Download /> v{s.update.version}
      </button>
    );
  }
  if (s.kind === "installing") {
    return (
      <button className="sb-update" onClick={openUpdateModal} title={tr("shell.installing")}>
        <Spinner /> {tr("shell.installing")}
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
            {s.kind === "ready" && <div className="muted small">{tr("shell.restartWarning")} {tr("shell.laterInstallsOnExit")}</div>}
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
