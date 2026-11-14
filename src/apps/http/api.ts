import { invoke, isTauri } from "@tauri-apps/api/core";

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

const needApp = new Error("Cần chạy trong app (npm run app:dev).");

export function sendHttp(req: HttpReq): Promise<HttpResp> {
  if (!isTauri()) return Promise.reject(new Error("Cần chạy trong app (npm run app:dev) — trình duyệt bị chặn CORS, không gửi được."));
  return invoke<HttpResp>("http_send", { req });
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
