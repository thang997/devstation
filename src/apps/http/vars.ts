import { useSyncExternalStore } from "react";

/** Biến môi trường dùng chung cho mọi request: thay {{tên}} lúc gửi, set bằng Script sau response. */
const KEY = "devstation.http.vars";

function load(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

let vars: Record<string, string> = load();
const subs = new Set<() => void>();

function commit(next: Record<string, string>) {
  vars = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(vars));
  } catch {
    /* hết chỗ */
  }
  subs.forEach((f) => f());
}

export function getVars(): Record<string, string> {
  return vars;
}

export function setVar(name: string, value: string) {
  commit({ ...vars, [name]: value });
}

export function removeVar(name: string) {
  const next = { ...vars };
  delete next[name];
  commit(next);
}

export function useVars(): Record<string, string> {
  return useSyncExternalStore(
    (cb) => { subs.add(cb); return () => { subs.delete(cb); }; },
    () => vars,
  );
}

/** Thay mọi {{tên}} trong chuỗi bằng giá trị biến (thiếu thì để rỗng). */
export function substitute(text: string, v: Record<string, string> = vars): string {
  return text.replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, (_, name) => v[name] ?? "");
}

/**
 * Chạy script TRƯỚC khi gửi (pre-request — giống Postman "Pre-request Script").
 * Có sẵn: `req` {method, url, body, headers} (đọc), `vars`, `setVar(tên,giá trị)`, `getVar(tên)`.
 * Thường dùng để tính timestamp/nonce/chữ ký rồi `setVar` để chèn qua {{tên}} vào URL/header/body.
 */
export function runPreScript(
  src: string,
  req: { method: string; url: string; body: string; headers: Record<string, string> },
): { ok: boolean; message: string } {
  let count = 0;
  const setVarLocal = (n: string, val: unknown) => { setVar(String(n), val == null ? "" : String(val)); count++; };
  const getVarLocal = (n: string) => vars[n] ?? "";
  try {
    const fn = new Function("req", "vars", "setVar", "getVar", `"use strict";\n${src}`);
    fn({ ...req }, { ...vars }, setVarLocal, getVarLocal);
    return { ok: true, message: count ? `Pre-script xong — đã đặt ${count} biến` : "Pre-script chạy xong" };
  } catch (e) {
    return { ok: false, message: `Lỗi pre-script: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * Chạy script sau response (giống phần Tests của Postman nhưng tối giản).
 * Có sẵn: `resp` {status, headers, body}, `json` (body đã parse hoặc null),
 * `setVar(tên, giá trị)`, `getVar(tên)`, `vars`.
 */
export function runScript(
  src: string,
  resp: { status: number; headers: [string, string][]; body: string },
): { ok: boolean; message: string } {
  let json: unknown = null;
  try {
    json = JSON.parse(resp.body);
  } catch {
    /* body không phải JSON — json = null */
  }
  const headersObj: Record<string, string> = {};
  for (const [k, val] of resp.headers) headersObj[k.toLowerCase()] = val;

  let count = 0;
  const setVarLocal = (n: string, val: unknown) => { setVar(String(n), val == null ? "" : String(val)); count++; };
  const getVarLocal = (n: string) => vars[n] ?? "";

  try {
    // Script của chính người dùng, chạy local — chấp nhận new Function cho công cụ dev.
    const fn = new Function("resp", "json", "vars", "setVar", "getVar", `"use strict";\n${src}`);
    fn({ status: resp.status, headers: headersObj, body: resp.body }, json, { ...vars }, setVarLocal, getVarLocal);
    return { ok: true, message: count ? `Script xong — đã đặt ${count} biến` : "Script chạy xong" };
  } catch (e) {
    return { ok: false, message: `Lỗi script: ${e instanceof Error ? e.message : String(e)}` };
  }
}
