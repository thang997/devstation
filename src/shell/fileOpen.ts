import { invoke, isTauri } from "@tauri-apps/api/core";
import { useWorkbench } from "../store/workbench";
import { isMainWindow, launchApp, windowAppParam } from "./windows";

/**
 * Mở file từ Explorer (double-click .pdf khi đã đặt DevStation làm app mở PDF):
 * - App chưa chạy: Rust đọc tham số dòng lệnh vào hàng đợi → cửa sổ main vào thẳng app PDF (chờ trước lần vẽ đầu).
 * - App đang chạy: tauri-plugin-single-instance chuyển tham số sang tiến trình này → Rust xếp hàng + phát
 *   `pdf-open-request` tới MỘT cửa sổ (ưu tiên cửa sổ app PDF, rồi main) → cửa sổ đó mở/đưa app PDF lên trước
 *   rồi báo ĐÚNG cửa sổ chứa app PDF lấy file (cùng cửa sổ: sự kiện DOM `ds-pdf-pending`; cửa sổ khác: `emitTo` +
 *   `pdf-pending`; cửa sổ mới mở: module PDF tự lấy khi nạp).
 *   PHẢI nghe theo cửa sổ (`getCurrentWebviewWindow().listen`) — `listen()` toàn cục nhận cả sự kiện gửi cho cửa sổ
 *   khác → trước đây MỌI cửa sổ cùng mở app PDF (3 cửa sổ PDF, mỗi cái giữ một bản file 127 MB).
 * File nhẹ, nằm trong bundle chính: KHÔNG import code app PDF.
 */
export async function initFileOpen() {
  if (!isTauri()) return;
  const { emitTo } = await import("@tauri-apps/api/event");
  const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const me = getCurrentWebviewWindow();
  await me.listen("pdf-open-request", async () => {
    const target = await launchApp("pdf");
    if (target === me.label) window.dispatchEvent(new Event("ds-pdf-pending"));
    else if (target) await emitTo(target, "pdf-pending");
  });
  if (!windowAppParam && (await isMainWindow()) && (await invoke<boolean>("pdf_has_pending").catch(() => false))) {
    useWorkbench.getState().openApp("pdf");
  }
}
