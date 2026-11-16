import { invoke, isTauri } from "@tauri-apps/api/core";
import { confirmDialog } from "./confirm";
import { t } from "../store/lang";

/**
 * Xuất / nhập toàn bộ cấu hình (localStorage) ra file JSON — để chuyển dữ liệu
 * giữa bản dev (origin localhost:1430) và bản cài (tauri.localhost), hoặc sang máy khác.
 * Gồm: kết nối DB/Redis, SSH host/folder/tunnel, HTTP collection + biến, repo Git, query đã lưu,
 * theme/ngôn ngữ, kích thước khung… KHÔNG gồm mật khẩu (nằm trong keyring của hệ điều hành).
 */

interface ConfigFile {
  app: "DevStation";
  format: 1;
  exportedAt: string;
  data: Record<string, string>;
}

const stamp = () => new Date().toISOString().slice(0, 10).replace(/-/g, "");

/** Trả về đường dẫn đã lưu, hoặc null nếu huỷ. */
export async function exportConfig(): Promise<string | null> {
  if (!isTauri()) throw new Error(t("Only available inside the app.", "Chỉ dùng được trong app."));
  const data: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k != null) data[k] = localStorage.getItem(k) ?? "";
  }
  const file: ConfigFile = { app: "DevStation", format: 1, exportedAt: new Date().toISOString(), data };
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({
    title: t("Export DevStation config", "Xuất cấu hình DevStation"),
    defaultPath: `devstation-config-${stamp()}.json`,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (typeof path !== "string") return null;
  await invoke("write_text_file", { path, content: JSON.stringify(file, null, 2) });
  return path;
}

/** Nhập file cấu hình → ghi đè các mục trùng khoá rồi tải lại app. Trả về false nếu huỷ. */
export async function importConfig(): Promise<boolean> {
  if (!isTauri()) throw new Error(t("Only available inside the app.", "Chỉ dùng được trong app."));
  const { open } = await import("@tauri-apps/plugin-dialog");
  const path = await open({
    title: t("Import DevStation config", "Nhập cấu hình DevStation"),
    multiple: false,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (typeof path !== "string") return false;
  const text = await invoke<string>("http_read_file", { path });
  let file: ConfigFile;
  try { file = JSON.parse(text); } catch { throw new Error(t("Not a valid JSON file.", "File không phải JSON hợp lệ.")); }
  if (file?.app !== "DevStation" || typeof file.data !== "object" || !file.data) {
    throw new Error(t("This is not a DevStation config file.", "Đây không phải file cấu hình DevStation."));
  }
  const keys = Object.keys(file.data);
  const ok = await confirmDialog({
    title: t("Import config", "Nhập cấu hình"),
    confirmLabel: t("Import", "Nhập"),
    danger: false,
    message: t(
      `Import ${keys.length} config entries (exported ${file.exportedAt.slice(0, 16).replace("T", " ")})?\nExisting entries with the same name are overwritten; the app reloads afterwards. Passwords are not included.`,
      `Nhập ${keys.length} mục cấu hình (xuất lúc ${file.exportedAt.slice(0, 16).replace("T", " ")})?\nMục trùng tên sẽ bị ghi đè, xong app tự tải lại. Mật khẩu không nằm trong file.`,
    ),
  });
  if (!ok) return false;
  for (const k of keys) localStorage.setItem(k, String(file.data[k]));
  location.reload();
  return true;
}
