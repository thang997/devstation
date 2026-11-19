import { describe, expect, it } from "vitest";
import { algSpec, b64ToBytes, b64urlToText, parsePem, pkcs1ToSpki, timeClaims, verifyJwt } from "./jwtVerify";

const b64u = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const tok = (alg: string) => `${b64u(JSON.stringify({ alg, typ: "JWT" }))}.${b64u(JSON.stringify({ sub: "x" }))}`;

describe("algSpec", () => {
  it("map đúng họ thuật toán", () => {
    expect(algSpec("HS256")).toMatchObject({ family: "HMAC", hash: "SHA-256" });
    expect(algSpec("PS384")).toMatchObject({ family: "PSS", hash: "SHA-384", hashLen: 48 });
    expect(algSpec("ES512")).toMatchObject({ family: "EC", hash: "SHA-512", curve: "P-521" });
    expect(algSpec("EdDSA")).toBeNull();
    expect(algSpec("none")).toBeNull();
  });
});

describe("base64", () => {
  it("giải base64url không padding", () => {
    expect(b64urlToText(b64u("hello?>"))).toBe("hello?>");
    expect(Array.from(b64ToBytes("_-8"))).toEqual([0xff, 0xef]);
    expect(() => b64ToBytes("a*b")).toThrow();
  });
});

describe("PEM", () => {
  it("tách nhãn + DER, bọc PKCS#1 thành SPKI", () => {
    const pem = parsePem(`-----BEGIN RSA PUBLIC KEY-----\n${btoa("\x30\x03\x02\x01\x05")}\n-----END RSA PUBLIC KEY-----`);
    expect(pem?.label).toBe("RSA PUBLIC KEY");
    const spki = pkcs1ToSpki(pem!.der);
    expect(spki[0]).toBe(0x30);
    expect(Array.from(spki.slice(-6))).toEqual([0x00, 0x30, 0x03, 0x02, 0x01, 0x05]);
    expect(parsePem("not a pem")).toBeNull();
  });
});

describe("verifyJwt", () => {
  it("HS256 đúng / sai secret, alg none", async () => {
    const si = tok("HS256");
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(si)));
    const t = `${si}.${b64u(String.fromCharCode(...sig))}`;
    expect((await verifyJwt(t, "secret")).kind).toBe("valid");
    expect((await verifyJwt(t, "other")).kind).toBe("invalid");
    expect((await verifyJwt(`${tok("none")}.`, "")).kind).toBe("unsigned");
  });
});

describe("timeClaims", () => {
  it("exp/nbf/iat", () => {
    const now = 1_000_000_000_000;
    expect(timeClaims({ exp: 999_999_999, nbf: 1_000_000_001, iat: 1 }, now).map((c) => c.state)).toEqual(["expired", "notYet", "issued"]);
    expect(timeClaims({ exp: "x" }, now)).toEqual([]);
  });
});
