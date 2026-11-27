import { invoke, isTauri } from "@tauri-apps/api/core";

/** File đọc từ đĩa: Rust tự nhận encoding (BOM UTF-8/UTF-16, UTF-8, không thì Windows-1252) và kiểu xuống dòng. */
export interface ReadFile {
  text: string;
  /** "utf-8" | "utf-16le" | "utf-16be" | "windows-1252" */
  encoding: string;
  bom: boolean;
  /** "\r\n" | "\n" — kiểu xuống dòng chiếm đa số trong file. */
  eol: "\r\n" | "\n";
  size: number;
  /** Có byte không giải mã được (file nhị phân / sai encoding) → cảnh báo trước khi lưu đè. */
  lossy: boolean;
}

export const editorApi = {
  read: (path: string) => invoke<ReadFile>("editor_read", { path }),
  /** Ghi file: `text` đã đúng kiểu xuống dòng; Rust mã hoá theo `encoding` (+ BOM). */
  write: (path: string, text: string, encoding: string, bom: boolean) => invoke<void>("editor_write", { path, text, encoding, bom }),
  /** Bản nháp của tab chưa lưu (giữ qua lần tắt/mở app) — `%LOCALAPPDATA%/DevStation/editor-session/<id>.txt`. */
  draftPut: (id: string, text: string) => invoke<void>("editor_draft_put", { id, text }),
  draftGet: (id: string) => invoke<string | null>("editor_draft_get", { id }),
  draftDel: (id: string) => invoke<void>("editor_draft_del", { id }),
  /** Xoá bản nháp không còn tab nào dùng. */
  draftGc: (keep: string[]) => invoke<void>("editor_draft_gc", { keep }),
};

export const inTauri = isTauri;
