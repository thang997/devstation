import { invoke, isTauri } from "@tauri-apps/api/core";
import { t } from "../../store/lang";

/** Một dòng header trong trình soạn request. `on`=false thì không gửi. */
export interface Header {
  name: string;
  value: string;
  on: boolean;
}

/** Cấu hình xác thực; header Authorization/API key được tính lúc gửi (hỗ trợ {{biến}}). */
export interface Auth {
  type: "none" | "bearer" | "basic" | "apikey";
  token: string;
  username: string;
  password: string;
  /** Tên header cho kiểu API key. */
  key: string;
  value: string;
}

export const NO_AUTH: Auth = { type: "none", token: "", username: "", password: "", key: "", value: "" };

export interface HttpReq {
  method: string;
  url: string;
  headers: { name: string; value: string }[];
  body: string | null;
  insecure: boolean;
  /** Id để hủy bằng `cancelHttp`. */
  id?: string;
  /** Giới hạn thời gian cả request (giây); 0 = không giới hạn. Mặc định 30. */
  timeoutSecs?: number;
}

export interface HttpResp {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
  bodyBytes: number;
  timeMs: number;
  truncated: boolean;
}

const needApp = new Error(t("http.needApp"));

export function sendHttp(req: HttpReq): Promise<HttpResp> {
  if (!isTauri()) return Promise.reject(new Error(t("http.needAppCors")));
  return invoke<HttpResp>("http_send", { req });
}

/** Hủy request đang gửi (id truyền trong `sendHttp`). */
export const cancelHttp = (id: string) => invoke<void>("http_cancel", { id }).catch(() => {});

/** Rust báo hết giờ / bị hủy bằng mã → UI dịch ra câu theo ngôn ngữ. */
export function httpErrText(msg: string): string {
  const m = /^__TIMEOUT__:(\d+)/.exec(msg);
  if (m) return Number(m[1]) > 0 ? t("http.timedOut", { s: m[1] }) : t("http.timedOutNoLimit");
  if (msg === "__CANCELLED__") return t("http.cancelled");
  return msg;
}

export interface ImportedFile {
  name: string;
  content: string;
}

export function readFile(path: string): Promise<string> {
  if (!isTauri()) return Promise.reject(needApp);
  return invoke<string>("http_read_file", { path });
}

export function readDir(dir: string): Promise<ImportedFile[]> {
  if (!isTauri()) return Promise.reject(needApp);
  return invoke<ImportedFile[]>("http_read_dir", { dir });
}

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
