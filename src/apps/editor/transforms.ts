/**
 * Phép chuyển đổi văn bản của Editor (thuần, không phụ thuộc CodeMirror) — áp cho đoạn đang chọn hoặc cả file.
 * Làm đẹp / thu gọn: JSON (native), XML (@prettier/plugin-xml), JS/TS/CSS/HTML/Markdown/YAML (Prettier),
 * SQL (sql-formatter) — các thư viện nặng chỉ tải khi dùng lần đầu.
 */
import type { LangId } from "./langs";
import { lintJson, type JsonErrKind } from "./jsonLint";

/** Lỗi chuyển đổi hiển thị cho người dùng (không phải lỗi lập trình). */
export class TransformError extends Error {}

/* ── Base64 / URL / JWT ── */

const utf8 = new TextEncoder();
const utf8d = new TextDecoder("utf-8", { fatal: true });

export function b64encode(s: string): string {
  const bytes = utf8.encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Decode Base64 (cả base64url, bỏ khoảng trắng / xuống dòng, tự thêm `=`). Kết quả không phải UTF-8 → lỗi. */
export function b64decode(s: string): string {
  let t = s.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!t) return "";
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(t)) throw new TransformError("notBase64");
  t = t.replace(/=+$/, "");
  t += "=".repeat((4 - (t.length % 4)) % 4);
  let bin: string;
  try { bin = atob(t); } catch { throw new TransformError("notBase64"); }
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  try { return utf8d.decode(bytes); } catch { throw new TransformError("notText"); }
}

export const urlEncode = (s: string) => encodeURIComponent(s);
export function urlDecode(s: string): string {
  try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch { throw new TransformError("badUrl"); }
}

/** JWT → header + payload dạng JSON đẹp (không kiểm chữ ký — dùng tool JWT để kiểm). */
export function jwtDecode(s: string): string {
  const parts = s.trim().split(".");
  if (parts.length < 2) throw new TransformError("notJwt");
  const part = (p: string) => {
    try { return JSON.stringify(JSON.parse(b64decode(p)), null, 2); } catch { throw new TransformError("notJwt"); }
  };
  return `// header\n${part(parts[0])}\n// payload\n${part(parts[1])}\n`;
}

/** Decode xong mà ra JSON thì làm đẹp luôn (tiện xem payload). */
export function prettyIfJson(s: string): string {
  const t = s.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return s;
  try { return JSON.stringify(JSON.parse(t), null, 2); } catch { return s; }
}

/* ── Dòng / chữ ── */

const splitLines = (s: string) => s.split(/\r?\n/);
const eolOf = (s: string) => (s.includes("\r\n") ? "\r\n" : "\n");
export const toUpper = (s: string) => s.toUpperCase();
export const toLower = (s: string) => s.toLowerCase();
export function sortLines(s: string, desc = false): string {
  const lines = splitLines(s).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  return (desc ? lines.reverse() : lines).join(eolOf(s));
}
export function uniqueLines(s: string): string {
  const seen = new Set<string>();
  return splitLines(s).filter((l) => (seen.has(l) ? false : (seen.add(l), true))).join(eolOf(s));
}
export const trimTrailing = (s: string) => splitLines(s).map((l) => l.replace(/[ \t]+$/, "")).join(eolOf(s));
export const joinLines = (s: string) => splitLines(s).map((l) => l.trim()).filter(Boolean).join(" ");
export const removeEmptyLines = (s: string) => splitLines(s).filter((l) => l.trim() !== "").join(eolOf(s));

/* ── Làm đẹp / thu gọn ── */

type PrettierParser = "babel" | "typescript" | "css" | "scss" | "less" | "html" | "markdown" | "yaml" | "xml";
const PRETTIER: Partial<Record<LangId, PrettierParser>> = {
  javascript: "babel", typescript: "typescript", css: "css", html: "html", markdown: "markdown", yaml: "yaml", xml: "xml",
};

/** Ngôn ngữ làm đẹp được. */
export const canFormat = (lang: LangId) => lang === "json" || lang === "sql" || lang in PRETTIER;
export const canMinify = (lang: LangId) => lang === "json" || lang === "xml" || lang === "css" || lang === "html" || lang === "sql";

async function prettier(text: string, parser: PrettierParser, tabWidth: number): Promise<string> {
  const p = await import("prettier/standalone");
  const plugins: unknown[] = [];
  if (parser === "babel") plugins.push(await import("prettier/plugins/babel"), await import("prettier/plugins/estree"));
  else if (parser === "typescript") plugins.push(await import("prettier/plugins/typescript"), await import("prettier/plugins/estree"));
  else if (parser === "css" || parser === "scss" || parser === "less") plugins.push(await import("prettier/plugins/postcss"));
  else if (parser === "html") plugins.push(await import("prettier/plugins/html"), await import("prettier/plugins/babel"), await import("prettier/plugins/estree"), await import("prettier/plugins/postcss"));
  else if (parser === "markdown") plugins.push(await import("prettier/plugins/markdown"));
  else if (parser === "yaml") plugins.push(await import("prettier/plugins/yaml"));
  else if (parser === "xml") plugins.push((await import("@prettier/plugin-xml")).default);
  try {
    return await p.format(text, {
      parser,
      plugins: plugins as never[],
      tabWidth,
      printWidth: 120,
      // XML: giữ khoảng trắng trong nội dung text như cũ (không gộp/ngắt chữ).
      ...(parser === "xml" ? { xmlWhitespaceSensitivity: "ignore", xmlSelfClosingSpace: true } : {}),
    } as never);
  } catch (e) {
    throw new TransformError(String((e as Error).message ?? e).split("\n")[0]);
  }
}

export async function formatText(text: string, lang: LangId, tabWidth = 2): Promise<string> {
  if (lang === "json") {
    try { return JSON.stringify(JSON.parse(text), null, tabWidth); } catch (e) { throw new TransformError((e as Error).message); }
  }
  if (lang === "sql") {
    const { format } = await import("sql-formatter");
    try { return format(text, { language: "sql", tabWidth, keywordCase: "upper" }); } catch (e) { throw new TransformError((e as Error).message); }
  }
  const parser = PRETTIER[lang];
  if (!parser) throw new TransformError("cannotFormat");
  const out = await prettier(text, parser, tabWidth);
  // Prettier luôn thêm xuống dòng cuối: đang làm đẹp một đoạn chọn (không có \n cuối) thì bỏ đi.
  return text.endsWith("\n") ? out : out.replace(/\n$/, "");
}

export function minifyText(text: string, lang: LangId): string {
  if (lang === "json") {
    try { return JSON.stringify(JSON.parse(text)); } catch (e) { throw new TransformError((e as Error).message); }
  }
  if (lang === "xml" || lang === "html") {
    // Bỏ comment + khoảng trắng giữa các thẻ (không đụng nội dung text bên trong thẻ).
    return text.replace(/<!--[\s\S]*?-->/g, "").replace(/>\s+</g, "><").trim();
  }
  if (lang === "css") {
    return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").replace(/\s*([{}:;,>])\s*/g, "$1").replace(/;}/g, "}").trim();
  }
  if (lang === "sql") {
    // Gộp khoảng trắng ngoài chuỗi '...' / "..." và bỏ comment -- / /* */.
    let out = "", q = "";
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { out += c; if (c === q) q = ""; continue; }
      if (c === "'" || c === '"' || c === "`") { q = c; out += c; continue; }
      if (c === "-" && text[i + 1] === "-") { while (i < text.length && text[i] !== "\n") i++; out += " "; continue; }
      if (c === "/" && text[i + 1] === "*") { const e = text.indexOf("*/", i + 2); i = e < 0 ? text.length : e + 1; out += " "; continue; }
      out += /\s/.test(c) ? " " : c;
    }
    return out.replace(/ {2,}/g, " ").trim();
  }
  throw new TransformError("cannotMinify");
}

/* ── Kiểm lỗi cú pháp (XML / JSON / JS) → vị trí lỗi để gạch chân + nhảy tới ── */

export interface SyntaxIssue {
  /** Đoạn gạch chân. */
  from: number;
  to: number;
  /** Chỗ đặt con trỏ khi bấm Check (thiếu dấu → chỗ cần gõ dấu). */
  caret: number;
  /** Bôi đen đoạn lỗi thay vì chỉ đặt con trỏ (dấu thừa, token sai). */
  select: boolean;
  line: number;
  col: number;
  /** JSON: loại lỗi (UI dịch ra câu dễ hiểu); XML/JS: thông báo gốc của parser. */
  kind?: JsonErrKind;
  expect?: "]" | "}";
  message: string;
}

const lineCol = (text: string, pos: number) => {
  let line = 1, col = 1;
  for (let k = 0; k < pos && k < text.length; k++) { if (text.charCodeAt(k) === 10) { line++; col = 1; } else col++; }
  return { line, col };
};
const issueAt = (text: string, from: number, message: string): SyntaxIssue => {
  const f = Math.min(Math.max(0, from), text.length);
  return { from: f, to: Math.min(text.length, f + 1), caret: f, select: false, message, ...lineCol(text, f) };
};

/** Offset của dòng `line` (1-based), cột `col` (1-based). */
function offsetOf(text: string, line: number, col: number): number {
  let off = 0;
  for (let l = 1; l < line; l++) {
    const n = text.indexOf("\n", off);
    if (n < 0) return text.length;
    off = n + 1;
  }
  return Math.min(text.length, off + Math.max(0, col - 1));
}

export async function checkSyntax(text: string, lang: LangId): Promise<SyntaxIssue | null> {
  if (!text.trim()) return null;
  if (lang === "json") {
    try { JSON.parse(text); return null; } catch (e) {
      // Thông báo + vị trí của trình duyệt khó hiểu (trỏ vào token SAU chỗ thiếu) → tự dò lại cho chính xác.
      const r = lintJson(text);
      if (!r) return issueAt(text, 0, (e as Error).message);
      const select = !["missingComma", "missingColon", "unexpectedEnd", "empty"].includes(r.kind);
      return { from: r.from, to: r.to, caret: r.caret, select, line: r.line, col: r.col, kind: r.kind, expect: r.expect, message: (e as Error).message };
    }
  }
  if (lang === "xml") {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    const err = doc.getElementsByTagName("parsererror")[0];
    if (!err) return null;
    const msg = (err.textContent ?? "").replace(/\s+/g, " ").trim();
    const m = /line (\d+) at column (\d+)/i.exec(msg) ?? /line (\d+)[^\d]+(\d+)/i.exec(msg);
    return issueAt(text, m ? offsetOf(text, +m[1], +m[2]) : 0, msg.replace(/^This page contains the following errors:\s*/i, "").replace(/Below is a rendering.*$/i, "").replace(/^error on line \d+ at column \d+:\s*/i, ""));
  }
  if (lang === "javascript") {
    const { parse } = await import("acorn");
    try {
      parse(text, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true });
      return null;
    } catch (e) {
      const err = e as Error & { pos?: number };
      return issueAt(text, err.pos ?? 0, err.message.replace(/\s*\(\d+:\d+\)$/, ""));
    }
  }
  return null;
}
