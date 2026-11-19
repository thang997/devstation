/**
 * CSR (PKCS#10) / Certificate (X.509) → Public key — đọc ASN.1 DER bằng tay (không thư viện).
 * - `parseCsrOrCert`: lấy SubjectPublicKeyInfo (→ PEM "PUBLIC KEY"), subject, loại khoá + độ dài/curve,
 *   thuật toán ký; với cert thêm issuer + thời hạn.
 * - `spkiToJwk`: RSA (n, e) / EC (crv, x, y) → JWK (dùng cho JWT verify).
 * - `verifyCsrSignature`: CSR tự ký bằng chính khoá trong nó → kiểm bằng Web Crypto (ECDSA: đổi chữ ký DER → r||s).
 */
import { b64ToBytes, parsePem } from "./jwtVerify";

interface Node { tag: number; start: number; len: number; hdr: number }
const end = (n: Node) => n.start + n.len;

/** Đọc một TLV tại `off`. */
function tlv(b: Uint8Array, off: number): Node {
  if (off + 2 > b.length) throw new Error("DER truncated");
  const tag = b[off];
  let len = b[off + 1];
  let hdr = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Error("DER bad length");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[off + 2 + i];
    hdr += n;
  }
  const node = { tag, start: off + hdr, len, hdr };
  if (end(node) > b.length) throw new Error("DER truncated");
  return node;
}
function children(b: Uint8Array, n: Node): Node[] {
  const out: Node[] = [];
  for (let o = n.start; o < end(n);) { const c = tlv(b, o); out.push(c); o = end(c); }
  return out;
}
/** Byte đầy đủ (gồm header) của node. */
const raw = (b: Uint8Array, n: Node) => b.subarray(n.start - n.hdr, end(n));
const body = (b: Uint8Array, n: Node) => b.subarray(n.start, end(n));

function oid(b: Uint8Array, n: Node): string {
  const v = body(b, n);
  const parts = [Math.floor(v[0] / 40), v[0] % 40];
  let x = 0;
  for (let i = 1; i < v.length; i++) {
    x = x * 128 + (v[i] & 0x7f);
    if (!(v[i] & 0x80)) { parts.push(x); x = 0; }
  }
  return parts.join(".");
}

function str(b: Uint8Array, n: Node): string {
  const v = body(b, n);
  if (n.tag === 0x1e) { let s = ""; for (let i = 0; i + 1 < v.length; i += 2) s += String.fromCharCode((v[i] << 8) | v[i + 1]); return s; } // BMPString
  return new TextDecoder().decode(v);
}

const NAME_OIDS: Record<string, string> = {
  "2.5.4.3": "CN", "2.5.4.6": "C", "2.5.4.7": "L", "2.5.4.8": "ST", "2.5.4.10": "O", "2.5.4.11": "OU",
  "2.5.4.5": "serialNumber", "2.5.4.97": "organizationIdentifier", "2.5.4.12": "title", "2.5.4.42": "GN", "2.5.4.4": "SN",
  "1.2.840.113549.1.9.1": "emailAddress", "0.9.2342.19200300.100.1.25": "DC", "0.9.2342.19200300.100.1.1": "UID",
};
export const SIG_OIDS: Record<string, string> = {
  "1.2.840.113549.1.1.5": "sha1WithRSAEncryption", "1.2.840.113549.1.1.11": "sha256WithRSAEncryption",
  "1.2.840.113549.1.1.12": "sha384WithRSAEncryption", "1.2.840.113549.1.1.13": "sha512WithRSAEncryption",
  "1.2.840.113549.1.1.10": "RSASSA-PSS", "1.2.840.10045.4.3.2": "ecdsa-with-SHA256", "1.2.840.10045.4.3.3": "ecdsa-with-SHA384",
  "1.2.840.10045.4.3.4": "ecdsa-with-SHA512", "1.3.101.112": "Ed25519",
};
const CURVES: Record<string, { name: string; jwk: string; size: number }> = {
  "1.2.840.10045.3.1.7": { name: "P-256 (prime256v1)", jwk: "P-256", size: 32 },
  "1.3.132.0.34": { name: "P-384 (secp384r1)", jwk: "P-384", size: 48 },
  "1.3.132.0.35": { name: "P-521 (secp521r1)", jwk: "P-521", size: 66 },
};

function name(b: Uint8Array, n: Node): string {
  const parts: string[] = [];
  for (const set of children(b, n)) for (const atv of children(b, set)) {
    const [o, v] = children(b, atv);
    parts.push(`${NAME_OIDS[oid(b, o)] ?? oid(b, o)}=${str(b, v)}`);
  }
  return parts.join(", ");
}

function time(b: Uint8Array, n: Node): string {
  const s = str(b, n);
  const m = n.tag === 0x17 ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/.exec(s) : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/.exec(s);
  if (!m) return s;
  let y = Number(m[1]);
  if (n.tag === 0x17) y += y < 50 ? 2000 : 1900;
  return new Date(Date.UTC(y, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0))).toLocaleString();
}

export interface KeyInfo { alg: "RSA" | "EC" | "Ed25519" | string; detail: string; curveOid?: string }

export interface CsrInfo {
  /** csr-info = chỉ phần CertificationRequestInfo (CSR CHƯA KÝ — app dựng nội dung rồi gửi đi ký ở nơi khác). */
  kind: "csr" | "cert" | "csr-info";
  subject: string;
  issuer?: string;
  validFrom?: string;
  validTo?: string;
  key: KeyInfo;
  sigAlg: string;
  /** SubjectPublicKeyInfo (DER) — ra PEM "PUBLIC KEY". */
  spki: Uint8Array;
  /** Phần được ký (CSR: certificationRequestInfo) + chữ ký — để kiểm chữ ký. */
  tbs: Uint8Array;
  sigOid: string;
  signature: Uint8Array;
}

export function keyInfo(spki: Uint8Array): KeyInfo {
  const root = tlv(spki, 0);
  const [algSeq, bits] = children(spki, root);
  const [algOid, param] = children(spki, algSeq);
  const a = oid(spki, algOid);
  const keyBytes = body(spki, bits).subarray(1); // bỏ byte "unused bits"
  if (a === "1.2.840.113549.1.1.1") {
    const [mod] = children(keyBytes, tlv(keyBytes, 0));
    let m = body(keyBytes, mod);
    while (m.length && m[0] === 0) m = m.subarray(1);
    return { alg: "RSA", detail: `${m.length * 8} bit` };
  }
  if (a === "1.2.840.10045.2.1") {
    const c = param && param.tag === 0x06 ? oid(spki, param) : "";
    return { alg: "EC", detail: CURVES[c]?.name ?? c, curveOid: c };
  }
  if (a === "1.3.101.112") return { alg: "Ed25519", detail: "256 bit" };
  return { alg: a, detail: "" };
}

/** Nhận PEM (CERTIFICATE REQUEST / NEW CERTIFICATE REQUEST / CERTIFICATE), base64 trần hoặc DER. */
export function parseCsrOrCert(input: string | Uint8Array): CsrInfo {
  let der: Uint8Array;
  if (typeof input === "string") {
    const pem = parsePem(input);
    if (pem) {
      if (/PRIVATE KEY/.test(pem.label)) throw new Error("privateKey");
      der = pem.der;
    } else der = b64ToBytes(input.replace(/\s+/g, ""));
  } else der = input;
  const root = tlv(der, 0);
  const rc = children(der, root);
  // CertificationRequestInfo trần: SEQUENCE { INTEGER version, Name subject, SPKI, [0] attributes } — không có chữ ký.
  if (rc[0]?.tag === 0x02 && rc[1]?.tag === 0x30 && rc[2]?.tag === 0x30 && children(der, rc[2])[0]?.tag === 0x30) {
    const spki = raw(der, rc[2]).slice();
    return { kind: "csr-info", subject: name(der, rc[1]), key: keyInfo(spki), sigAlg: "—", spki, tbs: raw(der, root).slice(), sigOid: "", signature: new Uint8Array() };
  }
  const [info, sigAlg, sigBits] = rc;
  if (!info || !sigAlg || !sigBits) throw new Error("notCsr");
  const ic = children(der, info);
  const sigOid = oid(der, children(der, sigAlg)[0]);
  const signature = body(der, sigBits).subarray(1);
  // Cert: tbsCertificate bắt đầu bằng [0] version (tuỳ chọn) rồi INTEGER serial, ...; CSR: INTEGER version, Name, SPKI.
  const isCert = ic[0].tag === 0xa0 || (ic.length >= 6 && ic[1].tag === 0x30 && ic[3].tag === 0x30 && ic[4].tag === 0x30);
  if (isCert) {
    const f = ic[0].tag === 0xa0 ? ic.slice(1) : ic;
    // serial, signature, issuer, validity, subject, spki
    const [, , issuer, validity, subject, spkiNode] = f;
    const [nb, na] = children(der, validity);
    const spki = raw(der, spkiNode).slice();
    return { kind: "cert", subject: name(der, subject), issuer: name(der, issuer), validFrom: time(der, nb), validTo: time(der, na), key: keyInfo(spki), sigAlg: SIG_OIDS[sigOid] ?? sigOid, spki, tbs: raw(der, info).slice(), sigOid, signature: signature.slice() };
  }
  const [, subject, spkiNode] = ic;
  if (!spkiNode || spkiNode.tag !== 0x30) throw new Error("notCsr");
  const spki = raw(der, spkiNode).slice();
  return { kind: "csr", subject: name(der, subject), key: keyInfo(spki), sigAlg: SIG_OIDS[sigOid] ?? sigOid, spki, tbs: raw(der, info).slice(), sigOid, signature: signature.slice() };
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const b64url = (bytes: Uint8Array) => b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function spkiToPem(spki: Uint8Array): string {
  const s = b64(spki).replace(/(.{64})/g, "$1\n").replace(/\n$/, "");
  return `-----BEGIN PUBLIC KEY-----\n${s}\n-----END PUBLIC KEY-----\n`;
}

/** SPKI → JWK công khai (RSA / EC). Loại khác → null. */
export function spkiToJwk(spki: Uint8Array): Record<string, string> | null {
  const root = tlv(spki, 0);
  const [algSeq, bits] = children(spki, root);
  const [algOid, param] = children(spki, algSeq);
  const a = oid(spki, algOid);
  const key = body(spki, bits).subarray(1);
  if (a === "1.2.840.113549.1.1.1") {
    const [n, e] = children(key, tlv(key, 0));
    const strip = (v: Uint8Array) => { let x = v; while (x.length > 1 && x[0] === 0) x = x.subarray(1); return x; };
    return { kty: "RSA", n: b64url(strip(body(key, n))), e: b64url(strip(body(key, e))) };
  }
  if (a === "1.2.840.10045.2.1" && param?.tag === 0x06) {
    const c = CURVES[oid(spki, param)];
    if (!c || key[0] !== 0x04) return null; // chỉ điểm không nén
    return { kty: "EC", crv: c.jwk, x: b64url(key.subarray(1, 1 + c.size)), y: b64url(key.subarray(1 + c.size, 1 + 2 * c.size)) };
  }
  return null;
}

/** Chữ ký ECDSA dạng DER SEQUENCE{r,s} → r||s cố định độ dài (Web Crypto cần dạng này). */
export function ecdsaDerToRaw(sig: Uint8Array, size: number): Uint8Array {
  const [r, s] = children(sig, tlv(sig, 0));
  const fix = (v: Uint8Array) => {
    let x = v;
    while (x.length > size && x[0] === 0) x = x.subarray(1);
    const out = new Uint8Array(size);
    out.set(x, size - x.length);
    return out;
  };
  const out = new Uint8Array(size * 2);
  out.set(fix(body(sig, r)), 0);
  out.set(fix(body(sig, s)), size);
  return out;
}

/** Kiểm chữ ký CSR bằng chính khoá công khai của nó. true/false; null = thuật toán chưa hỗ trợ. */
export async function verifyCsrSignature(info: CsrInfo): Promise<boolean | null> {
  const hashOf: Record<string, string> = {
    "1.2.840.113549.1.1.5": "SHA-1", "1.2.840.113549.1.1.11": "SHA-256", "1.2.840.113549.1.1.12": "SHA-384", "1.2.840.113549.1.1.13": "SHA-512",
    "1.2.840.10045.4.3.2": "SHA-256", "1.2.840.10045.4.3.3": "SHA-384", "1.2.840.10045.4.3.4": "SHA-512",
  };
  const hash = hashOf[info.sigOid];
  if (!hash) return null;
  const buf = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
  if (info.key.alg === "RSA") {
    const k = await crypto.subtle.importKey("spki", buf(info.spki), { name: "RSASSA-PKCS1-v1_5", hash }, false, ["verify"]);
    return crypto.subtle.verify("RSASSA-PKCS1-v1_5", k, buf(info.signature), buf(info.tbs));
  }
  if (info.key.alg === "EC") {
    const c = CURVES[info.key.curveOid ?? ""];
    if (!c) return null;
    const k = await crypto.subtle.importKey("spki", buf(info.spki), { name: "ECDSA", namedCurve: c.jwk }, false, ["verify"]);
    return crypto.subtle.verify({ name: "ECDSA", hash }, k, buf(ecdsaDerToRaw(info.signature, c.size)), buf(info.tbs));
  }
  return null;
}
