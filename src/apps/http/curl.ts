import type { Header } from "./api";

/** Kết quả tách một lệnh curl thành request chạy được. */
export interface ParsedCurl {
  method: string;
  url: string;
  headers: Header[];
  body: string | null;
  insecure: boolean;
}

export const looksLikeCurl = (s: string) => /^\s*curl(\.exe)?\s/i.test(s);

/**
 * Tách dòng lệnh thành token như shell: tôn trọng '...' , "..." , $'...' ,
 * dấu `\` nối dòng và escape. Đủ cho curl copy từ trình duyệt / Postman.
 */
function tokenize(src: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false; // token hiện tại đã có nội dung (kể cả chuỗi rỗng trong ngoặc)
  let i = 0;
  const n = src.length;
  const push = () => { if (has) { out.push(cur); cur = ""; has = false; } };

  while (i < n) {
    const ch = src[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") { push(); i++; continue; }

    if (ch === "\\") {
      const nx = src[i + 1];
      if (nx === "\n") { i += 2; continue; }               // nối dòng
      if (nx === "\r" && src[i + 2] === "\n") { i += 3; continue; }
      if (nx === undefined) { i++; continue; }
      cur += nx; has = true; i += 2; continue;             // escape ký tự kế
    }

    if (ch === "'") {                                      // nháy đơn: nguyên văn
      has = true; i++;
      while (i < n && src[i] !== "'") cur += src[i++];
      i++; continue;
    }

    if (ch === '"') {                                      // nháy kép: có escape
      has = true; i++;
      while (i < n && src[i] !== '"') {
        if (src[i] === "\\" && i + 1 < n) {
          const nx = src[i + 1];
          if (nx === '"' || nx === "\\" || nx === "`" || nx === "$") { cur += nx; i += 2; }
          else if (nx === "\n") { i += 2; }
          else { cur += src[i++]; }
        } else cur += src[i++];
      }
      i++; continue;
    }

    if (ch === "$" && src[i + 1] === "'") {                // $'...' ANSI-C
      has = true; i += 2;
      const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"', "0": "\0" };
      while (i < n && src[i] !== "'") {
        if (src[i] === "\\" && i + 1 < n) { cur += map[src[i + 1]] ?? src[i + 1]; i += 2; }
        else cur += src[i++];
      }
      i++; continue;
    }

    cur += ch; has = true; i++;
  }
  push();
  return out;
}

const b64 = (s: string) => {
  try {
    // Hỗ trợ ký tự ngoài Latin1.
    return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
  } catch {
    return "";
  }
};

/** Cờ không mang theo đối số (bỏ qua, không ảnh hưởng request). */
const SKIP_FLAGS = new Set([
  "--compressed", "-L", "--location", "-s", "--silent", "-v", "--verbose",
  "-i", "--include", "-f", "--fail", "-S", "--show-error", "-#", "--progress-bar",
  "-g", "--globoff", "--no-buffer", "-sS", "-0", "--http1.0", "--http1.1", "--http2",
]);

/** Cờ có 1 đối số mà ta không mô hình hoá — phải nuốt đối số để không nhầm thành URL. */
const SKIP_WITH_ARG = new Set([
  "-o", "--output", "-m", "--max-time", "--connect-timeout", "-x", "--proxy",
  "-E", "--cert", "--key", "--cacert", "-w", "--write-out", "--retry", "--limit-rate",
  "--resolve", "--cert-type", "-T", "--upload-file",
]);

/** Tách một lệnh curl thành request. Trả null nếu không ra được URL. */
export function parseCurl(input: string): ParsedCurl | null {
  const toks = tokenize(input.trim());
  if (!toks.length) return null;
  let start = 0;
  if (/^curl(\.exe)?$/i.test(toks[0])) start = 1;

  const headers: Header[] = [];
  let method = "";
  let url = "";
  const dataParts: string[] = [];
  let insecure = false;
  let getMode = false;
  let isHead = false;

  const addHeader = (raw: string) => {
    const idx = raw.indexOf(":");
    if (idx < 0) headers.push({ name: raw.trim(), value: "", on: true });
    else headers.push({ name: raw.slice(0, idx).trim(), value: raw.slice(idx + 1).trim(), on: true });
  };

  for (let i = start; i < toks.length; i++) {
    const t = toks[i];
    const arg = () => toks[++i] ?? "";

    if (t === "-X" || t === "--request") { method = arg().toUpperCase(); continue; }
    if (t.startsWith("-X") && t.length > 2) { method = t.slice(2).toUpperCase(); continue; }
    if (t === "-H" || t === "--header") { addHeader(arg()); continue; }
    if (t === "-A" || t === "--user-agent") { headers.push({ name: "User-Agent", value: arg(), on: true }); continue; }
    if (t === "-e" || t === "--referer") { headers.push({ name: "Referer", value: arg(), on: true }); continue; }
    if (t === "-b" || t === "--cookie") { headers.push({ name: "Cookie", value: arg(), on: true }); continue; }
    if (t === "-u" || t === "--user") { headers.push({ name: "Authorization", value: `Basic ${b64(arg())}`, on: true }); continue; }
    if (t === "-d" || t === "--data" || t === "--data-raw" || t === "--data-ascii" || t === "--data-binary" || t === "--data-urlencode") {
      dataParts.push(arg()); continue;
    }
    if (t === "-G" || t === "--get") { getMode = true; continue; }
    if (t === "-I" || t === "--head") { isHead = true; continue; }
    if (t === "-k" || t === "--insecure") { insecure = true; continue; }
    if (t === "--url") { url = arg() || url; continue; }
    if (SKIP_FLAGS.has(t)) continue;
    if (SKIP_WITH_ARG.has(t)) { arg(); continue; }
    if (t.startsWith("-") && t !== "-") continue;          // cờ lạ khác: bỏ qua
    if (!url) url = t;                                      // token thường = URL
  }

  const data = dataParts.length ? dataParts.join("&") : null;
  if (getMode && data) url += (url.includes("?") ? "&" : "?") + data;

  if (!method) method = isHead ? "HEAD" : data && !getMode ? "POST" : "GET";

  // curl với -d mà không khai báo Content-Type sẽ gửi form-urlencoded — giữ đúng hành vi đó.
  const body = getMode ? null : data;
  if (body && !headers.some((h) => h.name.toLowerCase() === "content-type")) {
    headers.push({ name: "Content-Type", value: "application/x-www-form-urlencoded", on: true });
  }

  if (!url) return null;
  return { method, url, headers, body, insecure };
}

/**
 * Tách một file văn bản thành nhiều lệnh curl: mỗi khối bắt đầu ở dòng `curl …`
 * cho tới dòng `curl` kế tiếp. Bỏ qua dòng chú thích (# hoặc //) và dòng trống đầu khối.
 */
export function parseCurlFile(text: string): ParsedCurl[] {
  const lines = text.split(/\r?\n/).filter((l) => !/^\s*(#|\/\/)/.test(l));
  const blocks: string[] = [];
  let cur: string[] = [];
  for (const ln of lines) {
    if (looksLikeCurl(ln) && cur.some((x) => x.trim())) {
      blocks.push(cur.join("\n"));
      cur = [];
    }
    cur.push(ln);
  }
  if (cur.some((x) => x.trim())) blocks.push(cur.join("\n"));
  return blocks
    .map((b) => parseCurl(b))
    .filter((x): x is ParsedCurl => x !== null);
}
