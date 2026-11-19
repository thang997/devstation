/**
 * Xác minh chữ ký JWT bằng Web Crypto (crypto.subtle) — không thêm thư viện.
 * Phần thuần (base64url, PEM→DER, bọc PKCS#1→SPKI, map alg) tách riêng để test được.
 */

export type AlgFamily = "HMAC" | "RSA" | "PSS" | "EC";

export interface AlgSpec {
  family: AlgFamily;
  hash: "SHA-256" | "SHA-384" | "SHA-512";
  /** Đường cong cho ES*. */
  curve?: "P-256" | "P-384" | "P-521";
  /** Số byte của hash — dùng làm saltLength cho PS*. */
  hashLen: number;
}

const HASH = { "256": "SHA-256", "384": "SHA-384", "512": "SHA-512" } as const;
const CURVE = { "256": "P-256", "384": "P-384", "512": "P-521" } as const;

/** Map `alg` của header sang tham số Web Crypto; null = không hỗ trợ. */
export function algSpec(alg: string): AlgSpec | null {
  const m = /^(HS|RS|PS|ES)(256|384|512)$/.exec(alg);
  if (!m) return null;
  const bits = m[2] as "256" | "384" | "512";
  const family: AlgFamily = m[1] === "HS" ? "HMAC" : m[1] === "RS" ? "RSA" : m[1] === "PS" ? "PSS" : "EC";
  return { family, hash: HASH[bits], hashLen: Number(bits) / 8, curve: family === "EC" ? CURVE[bits] : undefined };
}

/** Giải base64 hoặc base64url (bỏ khoảng trắng, tự thêm padding). Ném lỗi nếu ký tự lạ. */
export function b64ToBytes(s: string): Uint8Array {
  let t = s.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*=*$/.test(t)) throw new Error("invalid base64");
  t = t.replace(/=+$/, "");
  if (t.length % 4 === 1) throw new Error("invalid base64 length");
  t += "=".repeat((4 - (t.length % 4)) % 4);
  const bin = atob(t);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64urlToText(s: string): string {
  return new TextDecoder().decode(b64ToBytes(s));
}

export interface Pem {
  label: string;
  der: Uint8Array;
}

/** Tách khối PEM đầu tiên: nhãn (vd. "PUBLIC KEY") + DER. null nếu không phải PEM. */
export function parsePem(text: string): Pem | null {
  const m = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/.exec(text);
  if (!m) return null;
  // Bỏ các dòng header kiểu "Proc-Type: ..." (PEM cũ) nếu có.
  const body = m[2].split(/\r?\n/).filter((l) => !l.includes(":")).join("");
  return { label: m[1].trim(), der: b64ToBytes(body) };
}

/** Mã hoá độ dài DER. */
function derLen(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

function derTlv(tag: number, content: Uint8Array): Uint8Array {
  const len = derLen(content.length);
  const out = new Uint8Array(1 + len.length + content.length);
  out[0] = tag;
  out.set(len, 1);
  out.set(content, 1 + len.length);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** AlgorithmIdentifier { rsaEncryption (1.2.840.113549.1.1.1), NULL } */
const RSA_ALG_ID = new Uint8Array([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);

/** Bọc khoá RSA dạng PKCS#1 (RSAPublicKey) thành SubjectPublicKeyInfo để importKey("spki"). */
export function pkcs1ToSpki(pkcs1: Uint8Array): Uint8Array {
  const bitString = derTlv(0x03, concat(new Uint8Array([0x00]), pkcs1));
  return derTlv(0x30, concat(RSA_ALG_ID, bitString));
}

export type KeyErr = "pemPrivate" | "pemCert" | "pemUnknown" | "keyFormat";

/** Lỗi có mã để UI dịch; `detail` là thông điệp gốc (nếu có). */
export type JwtErrCode = KeyErr | "unsupportedAlg" | "noKey" | "badToken" | "importFailed";

export class JwtVerifyError extends Error {
  code: JwtErrCode;
  detail: string;
  constructor(code: JwtErrCode, detail = "") {
    super(detail || code);
    this.code = code;
    this.detail = detail;
  }
}

function importParams(spec: AlgSpec): RsaHashedImportParams | EcKeyImportParams | HmacImportParams {
  if (spec.family === "HMAC") return { name: "HMAC", hash: spec.hash };
  if (spec.family === "EC") return { name: "ECDSA", namedCurve: spec.curve! };
  return { name: spec.family === "PSS" ? "RSA-PSS" : "RSASSA-PKCS1-v1_5", hash: spec.hash };
}

function verifyParams(spec: AlgSpec): AlgorithmIdentifier | RsaPssParams | EcdsaParams {
  if (spec.family === "HMAC") return { name: "HMAC" };
  if (spec.family === "EC") return { name: "ECDSA", hash: spec.hash };
  if (spec.family === "PSS") return { name: "RSA-PSS", saltLength: spec.hashLen };
  return { name: "RSASSA-PKCS1-v1_5" };
}

/** Ép Uint8Array về ArrayBuffer riêng (kiểu BufferSource chặt của TS mới). */
const buf = (u: Uint8Array): ArrayBuffer => u.slice().buffer as ArrayBuffer;

async function importKey(spec: AlgSpec, keyText: string, secretIsB64: boolean): Promise<CryptoKey> {
  const params = importParams(spec);
  try {
    if (spec.family === "HMAC") {
      const raw = secretIsB64 ? b64ToBytes(keyText.trim()) : new TextEncoder().encode(keyText);
      return await crypto.subtle.importKey("raw", buf(raw), params, false, ["verify"]);
    }
    const text = keyText.trim();
    if (text.startsWith("{")) {
      const jwk = JSON.parse(text) as JsonWebKey;
      delete (jwk as { alg?: string }).alg; // tránh lệch alg trong JWK với alg của token
      delete jwk.key_ops;
      return await crypto.subtle.importKey("jwk", jwk, params, false, ["verify"]);
    }
    const pem = parsePem(text);
    if (!pem) throw new JwtVerifyError("keyFormat");
    if (pem.label.includes("PRIVATE")) throw new JwtVerifyError("pemPrivate");
    if (pem.label === "CERTIFICATE") throw new JwtVerifyError("pemCert");
    let der: Uint8Array;
    if (pem.label === "PUBLIC KEY") der = pem.der;
    else if (pem.label === "RSA PUBLIC KEY") der = pkcs1ToSpki(pem.der);
    else throw new JwtVerifyError("pemUnknown", pem.label);
    return await crypto.subtle.importKey("spki", buf(der), params, false, ["verify"]);
  } catch (e) {
    if (e instanceof JwtVerifyError) throw e;
    throw new JwtVerifyError("importFailed", e instanceof Error ? e.message : String(e));
  }
}

export type VerifyResult =
  | { kind: "valid"; alg: string }
  | { kind: "invalid"; alg: string }
  | { kind: "unsigned" };

/** Xác minh chữ ký token theo `alg` trong header. Ném JwtVerifyError khi không xác minh được (khác với "sai chữ ký"). */
export async function verifyJwt(token: string, keyText: string, secretIsB64 = false): Promise<VerifyResult> {
  const parts = token.trim().split(".");
  let alg: string;
  try {
    alg = String(JSON.parse(b64urlToText(parts[0])).alg ?? "");
  } catch {
    throw new JwtVerifyError("badToken");
  }
  if (alg.toLowerCase() === "none") return { kind: "unsigned" };
  if (parts.length !== 3) throw new JwtVerifyError("badToken");
  const spec = algSpec(alg);
  if (!spec) throw new JwtVerifyError("unsupportedAlg", alg);
  if (!keyText.trim()) throw new JwtVerifyError("noKey");
  const key = await importKey(spec, keyText, secretIsB64);
  let sig: Uint8Array;
  try {
    sig = b64ToBytes(parts[2]);
  } catch {
    throw new JwtVerifyError("badToken");
  }
  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const ok = await crypto.subtle.verify(verifyParams(spec), key, buf(sig), buf(data));
  return ok ? { kind: "valid", alg } : { kind: "invalid", alg };
}

export type ClaimState = "expired" | "valid" | "notYet" | "active" | "issued" | "future";

export interface TimeClaim {
  name: "exp" | "nbf" | "iat";
  date: Date;
  state: ClaimState;
}

/** Trạng thái các claim thời gian (giây epoch). `now` tính bằng ms. */
export function timeClaims(payload: unknown, now = Date.now()): TimeClaim[] {
  if (!payload || typeof payload !== "object") return [];
  const p = payload as Record<string, unknown>;
  const out: TimeClaim[] = [];
  const at = (k: string) => (typeof p[k] === "number" && Number.isFinite(p[k]) ? new Date((p[k] as number) * 1000) : null);
  const exp = at("exp");
  if (exp) out.push({ name: "exp", date: exp, state: exp.getTime() <= now ? "expired" : "valid" });
  const nbf = at("nbf");
  if (nbf) out.push({ name: "nbf", date: nbf, state: nbf.getTime() > now ? "notYet" : "active" });
  const iat = at("iat");
  if (iat) out.push({ name: "iat", date: iat, state: iat.getTime() > now ? "future" : "issued" });
  return out;
}
