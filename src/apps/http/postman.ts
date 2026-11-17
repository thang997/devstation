/**
 * Import collection Postman (v2.0 / v2.1, file .json export từ Postman) → cây collection của DevStation.
 * Postman dùng chung cú pháp {{biến}} nên URL/header/body giữ nguyên được.
 */
import type { Auth, Header } from "./api";
import { NO_AUTH } from "./api";
import type { SavedReq } from "./collections";

/** Một nút đã chuyển: thư mục (có con) hoặc request. */
export type PmNode =
  | { kind: "folder"; name: string; children: PmNode[] }
  | { kind: "req"; name: string; req: SavedReq };

export interface PmImport {
  name: string;
  nodes: PmNode[];
  /** Biến của collection (variable[]). */
  vars: Record<string, string>;
  /** Số request có body multipart/form-data hoặc file (chưa hỗ trợ → body bỏ trống/chuyển dạng text). */
  unsupportedBodies: number;
  total: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const kv = (arr: Any): { key: string; value: string; disabled?: boolean }[] =>
  Array.isArray(arr) ? arr.filter((x) => x && typeof x === "object").map((x) => ({ key: String(x.key ?? ""), value: x.value == null ? "" : String(x.value), disabled: !!x.disabled })) : [];

/** Postman auth: v2.1 dạng mảng [{key, value}], v2.0 dạng object {key: value}. */
const authField = (a: Any, type: string, field: string): string => {
  const v = a?.[type];
  if (Array.isArray(v)) return String(v.find((x: Any) => x?.key === field)?.value ?? "");
  if (v && typeof v === "object") return String(v[field] ?? "");
  return "";
};

/** URL Postman (chuỗi hoặc object) → chuỗi. */
function urlOf(u: Any): string {
  if (!u) return "";
  if (typeof u === "string") return u;
  if (typeof u.raw === "string" && u.raw) return u.raw;
  const host = Array.isArray(u.host) ? u.host.join(".") : (u.host ?? "");
  const path = Array.isArray(u.path) ? u.path.join("/") : (u.path ?? "");
  const proto = u.protocol ? `${u.protocol}://` : "";
  const port = u.port ? `:${u.port}` : "";
  const q = kv(u.query).filter((x) => !x.disabled).map((x) => `${x.key}=${x.value}`).join("&");
  return `${proto}${host}${port}${path ? `/${path}` : ""}${q ? `?${q}` : ""}`;
}

/** Chuyển auth Postman → Auth của DevStation. `null` = "kế thừa" (không khai báo). */
function convertAuth(a: Any): { auth: Auth; queryParam?: [string, string] } | null {
  if (!a || typeof a !== "object" || !a.type) return null;
  switch (a.type) {
    case "noauth":
      return { auth: NO_AUTH };
    case "bearer":
      return { auth: { ...NO_AUTH, type: "bearer", token: authField(a, "bearer", "token") } };
    case "basic":
      return { auth: { ...NO_AUTH, type: "basic", username: authField(a, "basic", "username"), password: authField(a, "basic", "password") } };
    case "apikey": {
      const key = authField(a, "apikey", "key");
      const value = authField(a, "apikey", "value");
      // API key đặt ở query → thêm vào URL (Auth của DevStation chỉ gắn header).
      if (authField(a, "apikey", "in") === "query") return { auth: NO_AUTH, queryParam: [key, value] };
      return { auth: { ...NO_AUTH, type: "apikey", key, value } };
    }
    default:
      return { auth: NO_AUTH }; // oauth2/digest/aws… chưa hỗ trợ → không xác thực
  }
}

/** Script của một event (prerequest/test) — exec là mảng dòng hoặc chuỗi. */
function scriptOf(events: Any, listen: "prerequest" | "test"): string {
  if (!Array.isArray(events)) return "";
  return events
    .filter((e) => e?.listen === listen && !e.disabled)
    .map((e) => (Array.isArray(e.script?.exec) ? e.script.exec.join("\n") : String(e.script?.exec ?? "")))
    .filter((s) => s.trim())
    .join("\n\n");
}

const joinScripts = (...parts: string[]) => parts.filter((s) => s.trim()).join("\n\n");

interface Inherit { auth: { auth: Auth; queryParam?: [string, string] } | null; pre: string; test: string }

function convertRequest(name: string, r: Any, item: Any, inh: Inherit, stats: { unsupported: number }): SavedReq {
  const req: Any = typeof r === "string" ? { url: r, method: "GET" } : r ?? {};
  let url = urlOf(req.url);
  const headers: Header[] = kv(req.header).map((h) => ({ name: h.key, value: h.value, on: !h.disabled }));
  const hasHeader = (n: string) => headers.some((h) => h.on && h.name.toLowerCase() === n.toLowerCase());
  let body = "";
  const b = req.body;
  if (b && !b.disabled) {
    switch (b.mode) {
      case "raw":
        body = String(b.raw ?? "");
        if (b.options?.raw?.language === "json" && !hasHeader("content-type")) headers.push({ name: "Content-Type", value: "application/json", on: true });
        break;
      case "urlencoded":
        body = kv(b.urlencoded).filter((x) => !x.disabled).map((x) => `${encodeURIComponent(x.key)}=${encodeURIComponent(x.value)}`).join("&");
        if (!hasHeader("content-type")) headers.push({ name: "Content-Type", value: "application/x-www-form-urlencoded", on: true });
        break;
      case "graphql":
        body = JSON.stringify({ query: b.graphql?.query ?? "", variables: safeJson(b.graphql?.variables) }, null, 2);
        if (!hasHeader("content-type")) headers.push({ name: "Content-Type", value: "application/json", on: true });
        break;
      case "formdata": {
        // multipart chưa hỗ trợ → giữ các trường text dạng urlencoded để không mất dữ liệu.
        stats.unsupported++;
        body = kv(b.formdata).filter((x) => !x.disabled).map((x) => `${encodeURIComponent(x.key)}=${encodeURIComponent(x.value)}`).join("&");
        break;
      }
      case "file":
        stats.unsupported++;
        break;
    }
  }
  const own = convertAuth(req.auth);
  const a = own ?? inh.auth;
  if (a?.queryParam) {
    const [k, v] = a.queryParam;
    url += `${url.includes("?") ? "&" : "?"}${k}=${v}`;
  }
  return {
    method: String(req.method || "GET").toUpperCase(),
    url,
    headers,
    body,
    insecure: false,
    auth: a?.auth ?? NO_AUTH,
    preScript: joinScripts(inh.pre, scriptOf(item.event, "prerequest")),
    script: joinScripts(inh.test, scriptOf(item.event, "test")),
  };
}

function safeJson(v: Any): Any {
  if (typeof v !== "string") return v ?? {};
  try { return JSON.parse(v); } catch { return {}; }
}

function convertItems(items: Any, inh: Inherit, stats: { unsupported: number; total: number }): PmNode[] {
  if (!Array.isArray(items)) return [];
  const out: PmNode[] = [];
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const name = String(it.name ?? "Untitled");
    if (Array.isArray(it.item)) {
      // Thư mục: auth/script của thư mục truyền xuống request con (Postman kế thừa).
      const child: Inherit = {
        auth: convertAuth(it.auth) ?? inh.auth,
        pre: joinScripts(inh.pre, scriptOf(it.event, "prerequest")),
        test: joinScripts(inh.test, scriptOf(it.event, "test")),
      };
      out.push({ kind: "folder", name, children: convertItems(it.item, child, stats) });
    } else if (it.request) {
      stats.total++;
      out.push({ kind: "req", name, req: convertRequest(name, it.request, it, inh, stats) });
    }
  }
  return out;
}

/** Có phải file collection Postman không (để phân biệt với file JSON khác / file curl). */
export function looksLikePostman(text: string): boolean {
  const t = text.trimStart();
  if (!t.startsWith("{")) return false;
  try {
    const j = JSON.parse(t);
    return !!j && typeof j === "object" && Array.isArray(j.item) && (typeof j.info === "object" || "variable" in j);
  } catch {
    return false;
  }
}

/** Phân tích file collection Postman. Ném lỗi nếu không phải collection. */
export function parsePostman(text: string): PmImport {
  let j: Any;
  try { j = JSON.parse(text); } catch { throw new Error("not JSON"); }
  if (!j || typeof j !== "object" || !Array.isArray(j.item)) throw new Error("not a Postman collection");
  const stats = { unsupported: 0, total: 0 };
  const root: Inherit = { auth: convertAuth(j.auth), pre: scriptOf(j.event, "prerequest"), test: scriptOf(j.event, "test") };
  const vars: Record<string, string> = {};
  for (const v of kv(j.variable)) if (v.key && !v.disabled) vars[v.key] = v.value;
  return {
    name: String(j.info?.name ?? "Postman collection"),
    nodes: convertItems(j.item, root, stats),
    vars,
    unsupportedBodies: stats.unsupported,
    total: stats.total,
  };
}
