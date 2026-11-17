import { useSyncExternalStore } from "react";
import { t } from "../../store/lang";

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

/** Biến động kiểu Postman: {{$guid}}, {{$timestamp}}, {{$isoTimestamp}}, {{$randomInt}}… (mỗi lần thay một giá trị mới). */
function dynamicVar(name: string): string | undefined {
  switch (name) {
    case "$guid":
    case "$randomUUID":
      return crypto.randomUUID();
    case "$timestamp":
      return String(Math.floor(Date.now() / 1000));
    case "$isoTimestamp":
      return new Date().toISOString();
    case "$randomInt":
      return String(Math.floor(Math.random() * 1001));
    default:
      return undefined;
  }
}

/** Thay mọi {{tên}} trong chuỗi bằng giá trị biến (thiếu thì để rỗng). */
export function substitute(text: string, v: Record<string, string> = vars): string {
  return text.replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, (_, name) => v[name] ?? dynamicVar(name) ?? "");
}

/* ── Tương thích script Postman (pm.*) — đủ cho các script phổ biến: đọc/ghi biến, đọc response, pm.test/expect cơ bản ── */

type TestResult = { name: string; ok: boolean; msg?: string };

function makeExpect(actual: unknown) {
  const fail = (m: string) => { throw new Error(m); };
  const show = (x: unknown) => { try { return JSON.stringify(x); } catch { return String(x); } };
  const deepEq = (a: unknown, b: unknown) => show(a) === show(b);
  const api = {
    equal: (x: unknown) => { if (actual !== x) fail(`expected ${show(actual)} to equal ${show(x)}`); return api; },
    eql: (x: unknown) => { if (!deepEq(actual, x)) fail(`expected ${show(actual)} to deeply equal ${show(x)}`); return api; },
    include: (x: unknown) => {
      const ok = typeof actual === "string" ? actual.includes(String(x)) : Array.isArray(actual) ? actual.some((v) => deepEq(v, x)) : false;
      if (!ok) fail(`expected ${show(actual)} to include ${show(x)}`);
      return api;
    },
    above: (n: number) => { if (!(Number(actual) > n)) fail(`expected ${show(actual)} to be above ${n}`); return api; },
    below: (n: number) => { if (!(Number(actual) < n)) fail(`expected ${show(actual)} to be below ${n}`); return api; },
    property: (p: string, v?: unknown) => {
      const o = actual as Record<string, unknown> | null;
      if (o == null || !(p in Object(o))) fail(`expected object to have property ${p}`);
      if (v !== undefined && !deepEq(o![p], v)) fail(`expected property ${p} to be ${show(v)}`);
      return api;
    },
    get ok() { if (!actual) fail(`expected ${show(actual)} to be truthy`); return api; },
    get true() { if (actual !== true) fail(`expected ${show(actual)} to be true`); return api; },
    get false() { if (actual !== false) fail(`expected ${show(actual)} to be false`); return api; },
    get null() { if (actual !== null) fail(`expected ${show(actual)} to be null`); return api; },
    get undefined() { if (actual !== undefined) fail(`expected ${show(actual)} to be undefined`); return api; },
  };
  // Chuỗi ngữ pháp kiểu chai: pm.expect(x).to.be.equal(1), .to.have.property('a'), .to.eql(...), .to.not? (không hỗ trợ)
  const chain: Record<string, unknown> = { ...api };
  for (const w of ["to", "be", "been", "is", "that", "which", "and", "has", "have", "with", "at", "of", "same", "a", "an", "deep"]) {
    Object.defineProperty(chain, w, { get: () => chain });
  }
  for (const k of ["ok", "true", "false", "null", "undefined"]) Object.defineProperty(chain, k, { get: () => (api as Record<string, unknown>)[k] });
  return chain;
}

function makePm(ctx: {
  setVar: (n: string, v: unknown) => void;
  getVar: (n: string) => string;
  request: { method: string; url: string; headers: Record<string, string>; body: string };
  response?: { status: number; headers: Record<string, string>; body: string; json: unknown };
  tests: TestResult[];
}) {
  const scope = {
    get: (n: string) => ctx.getVar(n),
    set: (n: string, v: unknown) => ctx.setVar(n, v),
    unset: (n: string) => removeVar(String(n)),
    has: (n: string) => String(n) in vars,
    replaceIn: (t: string) => substitute(String(t)),
    toObject: () => ({ ...vars }),
  };
  const r = ctx.response;
  const response = r && {
    code: r.status,
    status: String(r.status),
    responseTime: 0,
    json: () => { if (r.json === null) throw new Error("response body is not JSON"); return r.json; },
    text: () => r.body,
    headers: { get: (n: string) => r.headers[String(n).toLowerCase()], has: (n: string) => String(n).toLowerCase() in r.headers },
    to: { have: { status: (code: number) => { if (r.status !== code) throw new Error(`expected status ${code} but got ${r.status}`); } } },
  };
  return {
    environment: scope,
    collectionVariables: scope,
    globals: scope,
    variables: scope,
    request: { ...ctx.request, url: { toString: () => ctx.request.url }, headers: { get: (n: string) => ctx.request.headers[n] } },
    response,
    test: (name: string, fn: () => void) => {
      try { fn(); ctx.tests.push({ name: String(name), ok: true }); } catch (e) { ctx.tests.push({ name: String(name), ok: false, msg: e instanceof Error ? e.message : String(e) }); }
    },
    expect: makeExpect,
  };
}

/** API cũ của Postman: postman.setEnvironmentVariable / getEnvironmentVariable. */
const makeLegacy = (setV: (n: string, v: unknown) => void, getV: (n: string) => string) => ({
  setEnvironmentVariable: setV, getEnvironmentVariable: getV, setGlobalVariable: setV, getGlobalVariable: getV,
  clearEnvironmentVariable: (n: string) => removeVar(String(n)),
});

/** Gộp kết quả pm.test vào thông báo. */
function testsSummary(tests: TestResult[]): string {
  if (!tests.length) return "";
  const bad = tests.filter((x) => !x.ok);
  return " · " + t("http.testsSummary", { passed: tests.length - bad.length, failed: bad.length }) + (bad.length ? ` — ${bad.map((x) => `${x.name}: ${x.msg}`).join("; ")}` : "");
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
    const tests: TestResult[] = [];
    const pm = makePm({ setVar: setVarLocal, getVar: getVarLocal, request: req, tests });
    const fn = new Function("req", "vars", "setVar", "getVar", "pm", "postman", `"use strict";\n${src}`);
    fn({ ...req }, { ...vars }, setVarLocal, getVarLocal, pm, makeLegacy(setVarLocal, getVarLocal));
    return { ok: !tests.some((x) => !x.ok), message: (count ? t("http.preScriptDoneVars", { count }) : t("http.preScriptDone")) + testsSummary(tests) };
  } catch (e) {
    return { ok: false, message: t("http.preScriptError", { msg: e instanceof Error ? e.message : String(e) }) };
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
    const tests: TestResult[] = [];
    const pm = makePm({
      setVar: setVarLocal,
      getVar: getVarLocal,
      request: { method: "", url: "", headers: {}, body: "" },
      response: { status: resp.status, headers: headersObj, body: resp.body, json },
      tests,
    });
    const fn = new Function("resp", "json", "vars", "setVar", "getVar", "pm", "postman", "responseBody", `"use strict";\n${src}`);
    fn({ status: resp.status, headers: headersObj, body: resp.body }, json, { ...vars }, setVarLocal, getVarLocal, pm, makeLegacy(setVarLocal, getVarLocal), resp.body);
    return { ok: !tests.some((x) => !x.ok), message: (count ? t("http.scriptDoneVars", { count }) : t("http.scriptDone")) + testsSummary(tests) };
  } catch (e) {
    return { ok: false, message: t("http.scriptError", { msg: e instanceof Error ? e.message : String(e) }) };
  }
}
