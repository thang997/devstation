//! Phần kiểm chữ ký PDF tự viết, bổ trợ crate `underskrift`:
//! - **CMS**: tự đọc DER (giữ nguyên byte gốc của signedAttrs để kiểm chữ ký — không mã hoá lại), kiểm RSA PKCS#1 v1.5
//!   (SHA-1/256/384/512, kể cả khi signatureAlgorithm chỉ ghi `rsaEncryption` 1.2.840.113549.1.1.1 — underskrift báo
//!   "unsupported" → dấu thời gian/chữ ký của nhiều TSA và phần mềm ký bị coi sai) và ECDSA P-256/P-384.
//! - **Dấu thời gian** RFC 3161 (trong chữ ký và dấu thời gian tài liệu): chữ ký TSA + messageImprint + genTime.
//! - **Thu hồi** từ dữ liệu NHÚNG (không gọi mạng): CRL/OCSP trong DSS, trong `adbe-revocationInfoArchival`, trường
//!   `crls` của SignedData; CRL/OCSP đều được kiểm chữ ký trước khi dùng.
//! - **Quét thô `/ByteRange`** để kiểm được cả PDF mã hoá (lopdf không mở được khi có mật khẩu; /Contents của chữ ký
//!   KHÔNG bị mã hoá theo đặc tả).
//! - **DocMDP** (chữ ký chứng nhận) + chấm lại bản cập nhật có thêm chữ ký mà underskrift đánh giá quá chặt.

use der::{Decode, Encode};
use sha2::Digest;
use x509_cert::Certificate;

// ───────────────────────── DER tối giản ─────────────────────────

#[derive(Clone, Copy)]
pub struct Tlv<'a> {
    pub tag: u8,
    pub body: &'a [u8],
    pub raw: &'a [u8],
}

pub fn tlv(b: &[u8]) -> Option<(Tlv<'_>, &[u8])> {
    if b.len() < 2 {
        return None;
    }
    let tag = b[0];
    let (len, hl) = if b[1] < 0x80 {
        (b[1] as usize, 2)
    } else {
        let n = (b[1] & 0x7f) as usize;
        if n == 0 || n > 4 || b.len() < 2 + n {
            return None;
        }
        let mut l = 0usize;
        for i in 0..n {
            l = (l << 8) | b[2 + i] as usize;
        }
        (l, 2 + n)
    };
    if b.len() < hl + len {
        return None;
    }
    Some((Tlv { tag, body: &b[hl..hl + len], raw: &b[..hl + len] }, &b[hl + len..]))
}

pub fn children(mut b: &[u8]) -> Vec<Tlv<'_>> {
    let mut v = Vec::new();
    while let Some((t, rest)) = tlv(b) {
        v.push(t);
        b = rest;
    }
    v
}

/// Độ dài thật của một khối DER (bỏ phần đệm 0 phía sau /Contents).
pub fn der_len(b: &[u8]) -> Option<usize> {
    tlv(b).map(|(t, _)| t.raw.len())
}

pub fn oid_str(body: &[u8]) -> String {
    if body.is_empty() {
        return String::new();
    }
    let mut out = format!("{}.{}", body[0] / 40, body[0] % 40);
    let mut v: u64 = 0;
    for &c in &body[1..] {
        v = (v << 7) | (c & 0x7f) as u64;
        if c & 0x80 == 0 {
            out.push_str(&format!(".{v}"));
            v = 0;
        }
    }
    out
}

fn oid_of(t: &Tlv) -> Option<String> {
    (t.tag == 0x06).then(|| oid_str(t.body))
}

/// Nội dung OCTET STRING (nguyên thuỷ 0x04 hoặc dựng 0x24 kiểu BER).
fn octets(t: &Tlv) -> Vec<u8> {
    match t.tag {
        0x04 => t.body.to_vec(),
        0x24 => children(t.body).iter().flat_map(octets).collect(),
        _ => t.body.to_vec(),
    }
}

/// GeneralizedTime / UTCTime (TLV hoặc chỉ phần thân) → unix giây.
pub fn parse_time(t: &Tlv) -> Option<i64> {
    let s = std::str::from_utf8(t.body).ok()?;
    let (y, rest) = if t.tag == 0x17 {
        let yy: i32 = s.get(0..2)?.parse().ok()?;
        (if yy >= 50 { 1900 + yy } else { 2000 + yy }, &s[2..])
    } else {
        (s.get(0..4)?.parse().ok()?, &s[4..])
    };
    let n = |a: usize| -> Option<u32> { rest.get(a..a + 2)?.parse().ok() };
    let (mo, d, h, mi) = (n(0)?, n(2)?, n(4)?, n(6)?);
    let se = n(8).unwrap_or(0);
    let date = chrono::NaiveDate::from_ymd_opt(y, mo, d)?.and_hms_opt(h, mi, se)?;
    let mut ts = date.and_utc().timestamp();
    // Múi giờ dạng +hhmm / -hhmm (hiếm, nhưng có).
    if let Some(p) = rest.find(['+', '-']) {
        let z = &rest[p..];
        let hh: i64 = z.get(1..3).and_then(|x| x.parse().ok()).unwrap_or(0);
        let mm: i64 = z.get(3..5).and_then(|x| x.parse().ok()).unwrap_or(0);
        let off = hh * 3600 + mm * 60;
        ts -= if z.starts_with('+') { off } else { -off };
    }
    Some(ts)
}

// ───────────────────────── băm + kiểm chữ ký ─────────────────────────

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Hash {
    Sha1,
    Sha256,
    Sha384,
    Sha512,
}

impl Hash {
    pub fn from_oid(oid: &str) -> Option<Hash> {
        Some(match oid {
            "1.3.14.3.2.26" | "1.2.840.113549.1.1.5" | "1.2.840.10045.4.1" => Hash::Sha1,
            "2.16.840.1.101.3.4.2.1" | "1.2.840.113549.1.1.11" | "1.2.840.10045.4.3.2" => Hash::Sha256,
            "2.16.840.1.101.3.4.2.2" | "1.2.840.113549.1.1.12" | "1.2.840.10045.4.3.3" => Hash::Sha384,
            "2.16.840.1.101.3.4.2.3" | "1.2.840.113549.1.1.13" | "1.2.840.10045.4.3.4" => Hash::Sha512,
            _ => return None,
        })
    }
    pub fn name(self) -> &'static str {
        match self {
            Hash::Sha1 => "SHA-1",
            Hash::Sha256 => "SHA-256",
            Hash::Sha384 => "SHA-384",
            Hash::Sha512 => "SHA-512",
        }
    }
    pub fn digest(self, parts: &[&[u8]]) -> Vec<u8> {
        fn run<D: Digest>(parts: &[&[u8]]) -> Vec<u8> {
            let mut h = D::new();
            for p in parts {
                h.update(p);
            }
            h.finalize().to_vec()
        }
        match self {
            Hash::Sha1 => run::<sha1::Sha1>(parts),
            Hash::Sha256 => run::<sha2::Sha256>(parts),
            Hash::Sha384 => run::<sha2::Sha384>(parts),
            Hash::Sha512 => run::<sha2::Sha512>(parts),
        }
    }
}

/// Kiểm chữ ký `sig` trên `msg` bằng khoá công khai SPKI (DER). `sig_alg` là OID thuật toán chữ ký; `hint` là thuật toán
/// băm dùng khi OID chữ ký không nói rõ (rsaEncryption / ecPublicKey).
pub fn verify_sig(spki_der: &[u8], sig_alg: &str, hint: Option<Hash>, msg: &[u8], sig: &[u8]) -> Result<Hash, String> {
    let hash = Hash::from_oid(sig_alg).or(hint).ok_or_else(|| format!("thuật toán chưa hỗ trợ: {sig_alg}"))?;
    let digest = hash.digest(&[msg]);
    let spki = spki::SubjectPublicKeyInfoRef::from_der(spki_der).map_err(|e| e.to_string())?;
    let key_alg = spki.algorithm.oid.to_string();
    match key_alg.as_str() {
        "1.2.840.113549.1.1.1" => {
            use rsa::pkcs8::DecodePublicKey;
            let pk = rsa::RsaPublicKey::from_public_key_der(spki_der).map_err(|e| e.to_string())?;
            let scheme = match hash {
                Hash::Sha1 => rsa::Pkcs1v15Sign::new::<sha1::Sha1>(),
                Hash::Sha256 => rsa::Pkcs1v15Sign::new::<sha2::Sha256>(),
                Hash::Sha384 => rsa::Pkcs1v15Sign::new::<sha2::Sha384>(),
                Hash::Sha512 => rsa::Pkcs1v15Sign::new::<sha2::Sha512>(),
            };
            pk.verify(scheme, &digest, sig).map_err(|_| "chữ ký RSA không khớp".to_string())?;
        }
        "1.2.840.10045.2.1" => {
            use ecdsa::signature::hazmat::PrehashVerifier;
            let curve = spki.algorithm.parameters.and_then(|p| p.decode_as::<der::asn1::ObjectIdentifier>().ok()).map(|o| o.to_string()).unwrap_or_default();
            match curve.as_str() {
                "1.2.840.10045.3.1.7" => {
                    use p256::pkcs8::DecodePublicKey;
                    let vk = p256::ecdsa::VerifyingKey::from_public_key_der(spki_der).map_err(|e| e.to_string())?;
                    let s = p256::ecdsa::Signature::from_der(sig).map_err(|e| e.to_string())?;
                    vk.verify_prehash(&digest, &s).map_err(|_| "chữ ký ECDSA không khớp".to_string())?;
                }
                "1.3.132.0.34" => {
                    use p384::pkcs8::DecodePublicKey;
                    let vk = p384::ecdsa::VerifyingKey::from_public_key_der(spki_der).map_err(|e| e.to_string())?;
                    let s = p384::ecdsa::Signature::from_der(sig).map_err(|e| e.to_string())?;
                    vk.verify_prehash(&digest, &s).map_err(|_| "chữ ký ECDSA không khớp".to_string())?;
                }
                c => return Err(format!("đường cong chưa hỗ trợ: {c}")),
            }
        }
        k => return Err(format!("loại khoá chưa hỗ trợ: {k}")),
    }
    Ok(hash)
}

fn spki_of(cert_der: &[u8]) -> Option<Vec<u8>> {
    Certificate::from_der(cert_der).ok()?.tbs_certificate.subject_public_key_info.to_der().ok()
}

// ───────────────────────── CMS ─────────────────────────

#[derive(Default, Debug)]
pub struct CmsCheck {
    pub signer: Option<Vec<u8>>,
    pub certs: Vec<Vec<u8>>,
    /// messageDigest khớp nội dung.
    pub digest_ok: bool,
    /// Chữ ký trên signedAttrs đúng.
    pub sig_ok: bool,
    pub hash: Option<Hash>,
    pub sig_alg: String,
    pub error: Option<String>,
    /// signingTime (thuộc tính đã ký).
    pub signing_time: Option<i64>,
    /// Token dấu thời gian trong unsignedAttrs.
    pub ts_token: Option<Vec<u8>>,
    pub signature_value: Vec<u8>,
    pub crls: Vec<Vec<u8>>,
    pub ocsps: Vec<Vec<u8>>,
    /// eContent (TSTInfo với token dấu thời gian).
    pub econtent: Option<Vec<u8>>,
}

const OID_MESSAGE_DIGEST: &str = "1.2.840.113549.1.9.4";
const OID_SIGNING_TIME: &str = "1.2.840.113549.1.9.5";
const OID_TS_TOKEN: &str = "1.2.840.113549.1.9.16.2.14";
const OID_ADBE_REVINFO: &str = "1.2.840.113583.1.1.8";

/// Tìm chứng thư người ký theo sid (IssuerAndSerialNumber hoặc SubjectKeyIdentifier).
fn find_signer(sid: &Tlv, certs: &[Vec<u8>]) -> Option<Vec<u8>> {
    if sid.tag == 0x30 {
        let kids = children(sid.body);
        let (iss, ser) = (kids.first()?, kids.get(1)?);
        let iss_name = x509_cert::name::Name::from_der(iss.raw).ok()?;
        certs.iter().find(|d| {
            Certificate::from_der(d).map(|c| c.tbs_certificate.issuer == iss_name && c.tbs_certificate.serial_number.as_bytes() == strip_int(ser.body)).unwrap_or(false)
        }).cloned()
    } else if sid.tag == 0x80 {
        certs.iter().find(|d| ski_of(d).as_deref() == Some(sid.body)).cloned()
    } else {
        None
    }
}

/// Bỏ byte 0x00 đầu của INTEGER dương (x509-cert lưu serial đã bỏ dấu).
fn strip_int(b: &[u8]) -> &[u8] {
    if b.len() > 1 && b[0] == 0 { &b[1..] } else { b }
}

fn ski_of(cert_der: &[u8]) -> Option<Vec<u8>> {
    let c = Certificate::from_der(cert_der).ok()?;
    let e = c.tbs_certificate.extensions?.into_iter().find(|e| e.extn_id.to_string() == "2.5.29.14")?;
    let (inner, _) = tlv(e.extn_value.as_bytes())?;
    Some(inner.body.to_vec())
}

/// Đọc RevocationInfoArchival của Adobe: [0] CRL…, [1] OCSPResponse…
fn adbe_revinfo(val: &Tlv, crls: &mut Vec<Vec<u8>>, ocsps: &mut Vec<Vec<u8>>) {
    for part in children(val.body) {
        let inner = children(part.body);
        let list = inner.first().filter(|t| t.tag == 0x30).map(|t| children(t.body)).unwrap_or_default();
        match part.tag {
            0xA0 => crls.extend(list.iter().map(|t| t.raw.to_vec())),
            0xA1 => ocsps.extend(list.iter().map(|t| t.raw.to_vec())),
            _ => {}
        }
    }
}

/// Kiểm CMS SignedData. `content_hash`: băm nội dung ngoài (chữ ký PDF tách rời); None = nội dung đóng gói (token TSA).
pub fn verify_cms(cms_der: &[u8], content_hash: Option<&dyn Fn(Hash) -> Vec<u8>>) -> CmsCheck {
    let mut out = CmsCheck::default();
    let fail = |mut o: CmsCheck, e: &str| {
        o.error = Some(e.to_string());
        o
    };
    let Some((ci, _)) = tlv(cms_der) else { return fail(out, "CMS hỏng") };
    let ci = children(ci.body);
    if ci.first().and_then(oid_of).as_deref() != Some("1.2.840.113549.1.7.2") {
        return fail(out, "không phải SignedData");
    }
    let Some(sd) = ci.get(1).and_then(|t| children(t.body).into_iter().next()) else { return fail(out, "thiếu SignedData") };
    // SignedData ::= SEQ { version, digestAlgorithms SET, encapContentInfo SEQ, [0] certs?, [1] crls?, signerInfos SET }
    let mut sinfos = None;
    let mut seen_encap = false;
    for part in children(sd.body) {
        match part.tag {
            0x30 if !seen_encap => {
                seen_encap = true;
                // encapContentInfo
                let k = children(part.body);
                if let Some(ec) = k.get(1) {
                    if let Some(inner) = children(ec.body).first() {
                        out.econtent = Some(octets(inner));
                    }
                }
            }
            0xA0 => out.certs = children(part.body).iter().filter(|t| t.tag == 0x30).map(|t| t.raw.to_vec()).collect(),
            0xA1 => {
                for c in children(part.body) {
                    if c.tag == 0x30 {
                        out.crls.push(c.raw.to_vec());
                    } else if c.tag == 0xA1 {
                        // OtherRevocationInfoFormat (vd. OCSP): SEQ{OID, value}
                        let k = children(c.body);
                        if let Some(v) = k.get(1) {
                            out.ocsps.push(v.raw.to_vec());
                        }
                    }
                }
            }
            0x31 => sinfos = Some(part),
            _ => {}
        }
    }
    let Some(si) = sinfos.and_then(|s| children(s.body).into_iter().next()) else { return fail(out, "thiếu SignerInfo") };
    let k = children(si.body);
    // version, sid, digestAlg, [0] signedAttrs?, sigAlg, signature, [1] unsignedAttrs?
    let (Some(sid), Some(dalg)) = (k.get(1), k.get(2)) else { return fail(out, "SignerInfo hỏng") };
    let mut i = 3;
    let signed_attrs = k.get(i).filter(|t| t.tag == 0xA0).copied();
    if signed_attrs.is_some() {
        i += 1;
    }
    let (Some(salg), Some(sigv)) = (k.get(i), k.get(i + 1)) else { return fail(out, "SignerInfo hỏng") };
    let unsigned = k.get(i + 2).filter(|t| t.tag == 0xA1).copied();
    let digest_oid = children(dalg.body).first().and_then(oid_of).unwrap_or_default();
    out.sig_alg = children(salg.body).first().and_then(oid_of).unwrap_or_default();
    out.signature_value = sigv.body.to_vec();
    let hash = Hash::from_oid(&digest_oid);
    out.hash = hash;
    out.signer = find_signer(sid, &out.certs);

    // Thuộc tính chưa ký: token dấu thời gian.
    if let Some(u) = unsigned {
        for a in children(u.body) {
            let ak = children(a.body);
            if ak.first().and_then(oid_of).as_deref() == Some(OID_TS_TOKEN) {
                if let Some(v) = ak.get(1).and_then(|s| children(s.body).into_iter().next()) {
                    out.ts_token = Some(v.raw.to_vec());
                }
            }
        }
    }
    let Some(hash) = hash else { return fail(out, &format!("thuật toán băm chưa hỗ trợ: {digest_oid}")) };
    let content_digest = match content_hash {
        Some(f) => f(hash),
        None => hash.digest(&[out.econtent.as_deref().unwrap_or_default()]),
    };
    let signed_msg: Vec<u8> = if let Some(sa) = signed_attrs {
        let mut md = None;
        for a in children(sa.body) {
            let ak = children(a.body);
            let oid = ak.first().and_then(oid_of).unwrap_or_default();
            let val = ak.get(1).and_then(|s| children(s.body).into_iter().next());
            match (oid.as_str(), val) {
                (OID_MESSAGE_DIGEST, Some(v)) => md = Some(v.body.to_vec()),
                (OID_SIGNING_TIME, Some(v)) => out.signing_time = parse_time(&v),
                (OID_ADBE_REVINFO, Some(v)) => adbe_revinfo(&v, &mut out.crls, &mut out.ocsps),
                _ => {}
            }
        }
        out.digest_ok = md.as_deref() == Some(content_digest.as_slice());
        // Chữ ký phủ signedAttrs mã hoá dạng SET (đổi tag [0] → 0x31), dùng NGUYÊN byte gốc.
        let mut m = sa.raw.to_vec();
        m[0] = 0x31;
        m
    } else {
        out.digest_ok = true;
        content_digest.clone()
    };
    let Some(spki) = out.signer.as_deref().and_then(spki_of) else { return fail(out, "không thấy chứng thư người ký") };
    if signed_attrs.is_none() {
        // Không có signedAttrs: chữ ký phủ thẳng nội dung — cần dữ liệu gốc, không phải bản băm; hiếm trong PDF.
        return fail(out, "CMS không có signedAttrs (chưa hỗ trợ)");
    }
    match verify_sig(&spki, &out.sig_alg, Some(hash), &signed_msg, &out.signature_value) {
        Ok(_) => out.sig_ok = true,
        Err(e) => out.error = Some(e),
    }
    out
}

// ───────────────────────── dấu thời gian RFC 3161 ─────────────────────────

#[derive(Debug, Default)]
pub struct TsCheck {
    pub gen_time: Option<i64>,
    pub sig_ok: bool,
    pub imprint_ok: bool,
    pub tsa: Option<Vec<u8>>,
    pub certs: Vec<Vec<u8>>,
    pub hash: Option<Hash>,
    pub error: Option<String>,
    pub crls: Vec<Vec<u8>>,
    pub ocsps: Vec<Vec<u8>>,
}

/// Kiểm token dấu thời gian: chữ ký TSA + messageImprint = băm(`imprinted`) + genTime.
pub fn verify_ts(token: &[u8], imprinted: &[&[u8]]) -> TsCheck {
    let c = verify_cms(token, None);
    let mut t = TsCheck { sig_ok: c.sig_ok && c.digest_ok, tsa: c.signer.clone(), certs: c.certs.clone(), error: c.error.clone(), crls: c.crls, ocsps: c.ocsps, ..Default::default() };
    // TSTInfo ::= SEQ { version, policy, messageImprint SEQ{ AlgId, OCTET }, serial, genTime, … }
    let Some(info) = c.econtent.as_deref().and_then(|e| tlv(e)).map(|(x, _)| x) else {
        t.error.get_or_insert_with(|| "thiếu TSTInfo".into());
        return t;
    };
    let k = children(info.body);
    if let Some(mi) = k.get(2) {
        let mk = children(mi.body);
        let alg = mk.first().and_then(|a| children(a.body).first().and_then(oid_of)).unwrap_or_default();
        if let (Some(h), Some(v)) = (Hash::from_oid(&alg), mk.get(1)) {
            t.hash = Some(h);
            t.imprint_ok = h.digest(imprinted) == v.body;
        }
    }
    t.gen_time = k.iter().find(|x| x.tag == 0x18).and_then(parse_time);
    t
}

// ───────────────────────── thu hồi (CRL / OCSP nhúng) ─────────────────────────

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Revocation {
    /// revoked | good | unknown
    pub status: String,
    /// Lúc bị thu hồi (unix giây).
    pub revoked_at: Option<i64>,
    /// Chứng thư bị thu hồi (CN).
    pub cert: Option<String>,
    /// crl | ocsp
    pub source: Option<String>,
    /// Số chứng thư (trừ gốc) đã có thông tin thu hồi hợp lệ / tổng.
    pub checked: usize,
    pub total: usize,
}

fn cn_of(der: &[u8]) -> String {
    Certificate::from_der(der)
        .ok()
        .map(|c| {
            for rdn in c.tbs_certificate.subject.0.iter().rev() {
                for a in rdn.0.iter() {
                    if a.oid.to_string() == "2.5.4.3" {
                        return String::from_utf8_lossy(a.value.value()).into_owned();
                    }
                }
            }
            c.tbs_certificate.subject.to_string()
        })
        .unwrap_or_default()
}

/// Kết quả CRL cho một chứng thư: Some(Some(t)) = bị thu hồi lúc t, Some(None) = CRL hợp lệ không liệt kê, None = không áp dụng.
fn crl_status(crl_der: &[u8], cert: &Certificate, issuer_der: &[u8]) -> Option<Option<i64>> {
    let (top, _) = tlv(crl_der)?;
    let parts = children(top.body);
    let (tbs, alg, sig) = (parts.first()?, parts.get(1)?, parts.get(2)?);
    let crl = x509_cert::crl::CertificateList::from_der(crl_der).ok()?;
    if crl.tbs_cert_list.issuer != cert.tbs_certificate.issuer {
        return None;
    }
    let alg_oid = children(alg.body).first().and_then(oid_of)?;
    let sig_bytes = sig.body.get(1..)?; // BIT STRING: bỏ byte số bit thừa
    verify_sig(&spki_of(issuer_der)?, &alg_oid, None, tbs.raw, sig_bytes).ok()?;
    let serial = cert.tbs_certificate.serial_number.as_bytes();
    for r in crl.tbs_cert_list.revoked_certificates.iter().flatten() {
        if r.serial_number.as_bytes() == serial {
            return Some(Some(r.revocation_date.to_unix_duration().as_secs() as i64));
        }
    }
    Some(None)
}

/// Kết quả OCSP cho một chứng thư (cùng quy ước với `crl_status`). Kiểm chữ ký phản hồi bằng chứng thư responder
/// (nhúng trong phản hồi) hoặc chính CA cấp.
fn ocsp_status(resp_der: &[u8], cert: &Certificate, issuer_der: &[u8]) -> Option<Option<i64>> {
    // OCSPResponse ::= SEQ { status ENUM, [0] SEQ { OID, OCTET STRING(BasicOCSPResponse) } }
    let (top, _) = tlv(resp_der)?;
    let k = children(top.body);
    let basic_der = if k.first()?.tag == 0x0A {
        let rb = children(k.get(1)?.body);
        let rbk = children(rb.first()?.body);
        rbk.get(1)?.body.to_vec()
    } else {
        // Đã là BasicOCSPResponse (vd. trong DSS một số phần mềm lưu thẳng).
        resp_der.to_vec()
    };
    let (basic, _) = tlv(&basic_der)?;
    let bk = children(basic.body);
    let (tbs, alg, sig) = (bk.first()?, bk.get(1)?, bk.get(2)?);
    let alg_oid = children(alg.body).first().and_then(oid_of)?;
    let sig_bytes = sig.body.get(1..)?;
    let mut signers: Vec<Vec<u8>> = bk.get(3).map(|c| children(c.body).first().map(|s| children(s.body).iter().map(|x| x.raw.to_vec()).collect()).unwrap_or_default()).unwrap_or_default();
    signers.push(issuer_der.to_vec());
    let verified = signers.iter().any(|s| spki_of(s).map(|p| verify_sig(&p, &alg_oid, None, tbs.raw, sig_bytes).is_ok()).unwrap_or(false));
    if !verified {
        return None;
    }
    let issuer = Certificate::from_der(issuer_der).ok()?;
    let issuer_name_der = issuer.tbs_certificate.subject.to_der().ok()?;
    let issuer_key = issuer.tbs_certificate.subject_public_key_info.subject_public_key.raw_bytes().to_vec();
    let serial = cert.tbs_certificate.serial_number.as_bytes();
    // ResponseData ::= SEQ { [0] version?, responderID, producedAt, responses SEQ OF SingleResponse, … }
    let rd = children(tbs.body);
    let responses = rd.iter().find(|x| x.tag == 0x30 && children(x.body).first().map(|s| s.tag == 0x30).unwrap_or(false))?;
    for sr in children(responses.body) {
        let sk = children(sr.body);
        let cid = children(sk.first()?.body);
        let h = children(cid.first()?.body).first().and_then(oid_of).and_then(|o| Hash::from_oid(&o))?;
        let (nh, kh, sn) = (cid.get(1)?.body, cid.get(2)?.body, strip_int(cid.get(3)?.body));
        if sn != serial || nh != h.digest(&[&issuer_name_der]).as_slice() || kh != h.digest(&[&issuer_key]).as_slice() {
            continue;
        }
        let st = sk.get(1)?;
        return match st.tag {
            0x80 => Some(None),
            0xA1 => Some(children(st.body).first().and_then(parse_time).or(Some(0))),
            _ => None,
        };
    }
    None
}

/// Tình trạng thu hồi của chuỗi `chain` (leaf → … → gốc) theo CRL/OCSP nhúng.
pub fn revocation(chain: &[Vec<u8>], crls: &[Vec<u8>], ocsps: &[Vec<u8>]) -> Revocation {
    let mut out = Revocation { status: "unknown".into(), ..Default::default() };
    for i in 0..chain.len() {
        let Ok(cert) = Certificate::from_der(&chain[i]) else { continue };
        if cert.tbs_certificate.subject == cert.tbs_certificate.issuer {
            continue; // gốc tự ký: không kiểm thu hồi
        }
        let Some(issuer) = chain.get(i + 1) else { continue };
        out.total += 1;
        let mut found: Option<(Option<i64>, &str)> = None;
        for o in ocsps {
            if let Some(r) = ocsp_status(o, &cert, issuer) {
                found = Some((r, "ocsp"));
                if r.is_some() {
                    break;
                }
            }
        }
        if !matches!(found, Some((Some(_), _))) {
            for c in crls {
                if let Some(r) = crl_status(c, &cert, issuer) {
                    found = Some((r, "crl"));
                    if r.is_some() {
                        break;
                    }
                }
            }
        }
        match found {
            Some((Some(at), src)) => {
                out.status = "revoked".into();
                out.revoked_at = Some(at);
                out.cert = Some(cn_of(&chain[i]));
                out.source = Some(src.into());
                out.checked += 1;
                return out;
            }
            Some((None, src)) => {
                out.checked += 1;
                out.source.get_or_insert_with(|| src.into());
            }
            None => {}
        }
    }
    if out.total > 0 && out.checked == out.total {
        out.status = "good".into();
    }
    out
}

// ───────────────────────── quét thô /ByteRange ─────────────────────────

#[derive(Debug, Clone)]
pub struct RawSig {
    pub byte_range: [usize; 4],
    pub cms: Vec<u8>,
    /// pades | pkcs7 | pkcs7sha1 | timestamp | unknown (theo /SubFilter gần đó).
    pub kind: String,
}

/// Tìm mọi chữ ký bằng cách quét `/ByteRange [a b c d]`; /Contents nằm đúng ở khe giữa hai đoạn (không bị mã hoá).
pub fn raw_scan(data: &[u8]) -> Vec<RawSig> {
    let mut out = Vec::new();
    let pat = b"/ByteRange";
    let mut i = 0;
    while let Some(p) = data[i..].windows(pat.len()).position(|w| w == pat) {
        let at = i + p;
        i = at + pat.len();
        let tail = &data[i..data.len().min(i + 120)];
        let s = String::from_utf8_lossy(tail);
        let Some(open) = s.find('[') else { continue };
        let Some(close) = s[open..].find(']') else { continue };
        let nums: Vec<usize> = s[open + 1..open + close].split_whitespace().filter_map(|x| x.parse().ok()).collect();
        if nums.len() != 4 {
            continue;
        }
        let br = [nums[0], nums[1], nums[2], nums[3]];
        let gap_start = br[0] + br[1];
        if br[0] != 0 || gap_start >= br[2] || br[2] + br[3] > data.len() {
            continue;
        }
        let gap = &data[gap_start..br[2]];
        let hex: Vec<u8> = gap.iter().copied().filter(|c| c.is_ascii_hexdigit()).collect();
        let Some(bytes) = hex::decode_even(&hex) else { continue };
        let Some(n) = der_len(&bytes) else { continue };
        // Chỉ nhận khe chứa CMS SignedData (OID 1.2.840.113549.1.7.2) — /ByteRange khác (vd. trong từ điển mã hoá) bỏ qua.
        const SIGNED_DATA: &[u8] = &[0x06, 0x09, 0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x07, 0x02];
        if !bytes[..n.min(24)].windows(SIGNED_DATA.len()).any(|w| w == SIGNED_DATA) {
            continue;
        }
        if out.iter().any(|r: &RawSig| r.byte_range == br) {
            continue;
        }
        // /SubFilter trong cùng từ điển: tìm trong ±600 byte quanh /ByteRange.
        let lo = at.saturating_sub(600);
        let hi = (at + 600).min(data.len());
        let around = String::from_utf8_lossy(&data[lo..hi]);
        let kind = if around.contains("ETSI.RFC3161") {
            "timestamp"
        } else if around.contains("ETSI.CAdES.detached") {
            "pades"
        } else if around.contains("adbe.pkcs7.sha1") {
            "pkcs7sha1"
        } else if around.contains("adbe.pkcs7.detached") {
            "pkcs7"
        } else {
            "unknown"
        };
        out.push(RawSig { byte_range: br, cms: bytes[..n].to_vec(), kind: kind.into() });
    }
    out
}

mod hex {
    pub fn decode_even(h: &[u8]) -> Option<Vec<u8>> {
        let v = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
        let h = if h.len() % 2 == 1 { &h[..h.len() - 1] } else { h };
        h.chunks(2).map(|p| Some(v(p[0])? << 4 | v(p[1])?)).collect()
    }
}

/// Băm hai đoạn của ByteRange.
pub fn range_parts<'a>(data: &'a [u8], br: &[usize; 4]) -> [&'a [u8]; 2] {
    [&data[br[0]..br[0] + br[1]], &data[br[2]..br[2] + br[3]]]
}

// ───────────────────────── cấu trúc PDF qua lopdf ─────────────────────────

/// Chuỗi văn bản PDF → String: UTF-16BE/LE có BOM, UTF-8 có BOM, UTF-8 trần (nhiều phần mềm trong nước ghi vậy),
/// còn lại PDFDocEncoding (≈ Latin-1). underskrift đọc mọi chuỗi như UTF-8 → tiếng Việt UTF-16 thành "��P…".
pub fn pdf_text(b: &[u8]) -> String {
    if b.len() >= 2 && b[0] == 0xFE && b[1] == 0xFF {
        let u: Vec<u16> = b[2..].chunks(2).filter(|c| c.len() == 2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
        return String::from_utf16_lossy(&u);
    }
    if b.len() >= 2 && b[0] == 0xFF && b[1] == 0xFE {
        let u: Vec<u16> = b[2..].chunks(2).filter(|c| c.len() == 2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        return String::from_utf16_lossy(&u);
    }
    let b = b.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(b);
    match std::str::from_utf8(b) {
        Ok(s) => s.to_string(),
        Err(_) => b.iter().map(|&c| c as char).collect(),
    }
}

/// Các trường văn bản của từ điển chữ ký (đọc lại vì underskrift giải mã sai UTF-16).
#[derive(Default, Clone, Debug)]
pub struct SigMeta {
    pub reason: Option<String>,
    pub location: Option<String>,
    pub contact: Option<String>,
    pub name: Option<String>,
    pub m: Option<String>,
}

/// Thông tin cấu trúc đọc bằng lopdf (bỏ qua khi file mã hoá / hỏng).
#[derive(Default)]
pub struct DocInfo {
    /// ByteRange → các trường văn bản của từ điển chữ ký.
    pub meta: Vec<([usize; 4], SigMeta)>,
    /// Chứng thư trong DSS (CA trung gian / gốc — phần mềm ký trong nước thường chỉ nhúng chứng thư người ký vào CMS
    /// và để chuỗi CA ở DSS).
    pub certs: Vec<Vec<u8>>,
    /// CRL / OCSP trong DSS.
    pub crls: Vec<Vec<u8>>,
    pub ocsps: Vec<Vec<u8>>,
    /// ByteRange → mức DocMDP /P của chữ ký chứng nhận.
    pub docmdp: Vec<([usize; 4], u8)>,
}

fn stream_bytes(doc: &lopdf::Document, o: &lopdf::Object) -> Option<Vec<u8>> {
    let o = match o {
        lopdf::Object::Reference(r) => doc.get_object(*r).ok()?,
        x => x,
    };
    let s = o.as_stream().ok()?;
    s.decompressed_content().ok().or_else(|| Some(s.content.clone()))
}

fn deref<'a>(doc: &'a lopdf::Document, o: &'a lopdf::Object) -> &'a lopdf::Object {
    match o {
        lopdf::Object::Reference(r) => doc.get_object(*r).unwrap_or(o),
        x => x,
    }
}

pub fn doc_info(data: &[u8]) -> DocInfo {
    let mut out = DocInfo::default();
    let Ok(doc) = lopdf::Document::load_mem(data) else { return out };
    if let Ok(cat) = doc.catalog() {
        if let Ok(dss) = cat.get(b"DSS").map(|o| deref(&doc, o)).and_then(|o| o.as_dict()) {
            for (key, dst) in [(b"Certs".as_slice(), &mut out.certs), (b"CRLs".as_slice(), &mut out.crls), (b"OCSPs".as_slice(), &mut out.ocsps)] {
                if let Ok(arr) = dss.get(key).map(|o| deref(&doc, o)).and_then(|o| o.as_array()) {
                    dst.extend(arr.iter().filter_map(|o| stream_bytes(&doc, o)));
                }
            }
        }
    }
    // Từ điển chữ ký: trường văn bản + chữ ký chứng nhận (/Reference [ << /TransformMethod /DocMDP /TransformParams << /P n >> >> ]).
    for obj in doc.objects.values() {
        let Ok(d) = obj.as_dict() else { continue };
        if let Ok(br) = d.get(b"ByteRange").and_then(|o| o.as_array()) {
            let v: Vec<usize> = br.iter().filter_map(|x| x.as_i64().ok()).map(|x| x as usize).collect();
            if v.len() == 4 {
                let txt = |k: &[u8]| match d.get(k).map(|o| deref(&doc, o)) {
                    Ok(lopdf::Object::String(b, _)) => Some(pdf_text(b)).filter(|s| !s.trim().is_empty()),
                    _ => None,
                };
                out.meta.push(([v[0], v[1], v[2], v[3]], SigMeta { reason: txt(b"Reason"), location: txt(b"Location"), contact: txt(b"ContactInfo"), name: txt(b"Name"), m: txt(b"M") }));
            }
        }
        let Ok(refs) = d.get(b"Reference").map(|o| deref(&doc, o)).and_then(|o| o.as_array()) else { continue };
        for r in refs {
            let Ok(rd) = deref(&doc, r).as_dict() else { continue };
            if rd.get(b"TransformMethod").and_then(|o| o.as_name()).ok() != Some(b"DocMDP".as_slice()) {
                continue;
            }
            let p = rd
                .get(b"TransformParams")
                .map(|o| deref(&doc, o))
                .and_then(|o| o.as_dict())
                .and_then(|tp| tp.get(b"P"))
                .and_then(|o| o.as_i64())
                .unwrap_or(2)
                .clamp(1, 3) as u8;
            if let Ok(br) = d.get(b"ByteRange").and_then(|o| o.as_array()) {
                let v: Vec<usize> = br.iter().filter_map(|x| x.as_i64().ok()).map(|x| x as usize).collect();
                if v.len() == 4 {
                    out.docmdp.push(([v[0], v[1], v[2], v[3]], p));
                }
            }
        }
    }
    out
}

/// Bản cập nhật có thêm chữ ký/dấu thời gian mà underskrift đánh giá "không an toàn" — chấm lại: mọi object đổi (trừ
/// catalog) chỉ được là: từ điển chữ ký, trường/widget chữ ký, AcroForm (đổi Fields/SigFlags/NeedAppearances/DR/DA),
/// trang chỉ thêm /Annots. Có đổi stream hay trang đổi nội dung → không an toàn.
pub fn benign_sig_revision(data: &[u8], prev_len: usize, curr_len: usize, changed: &[u32], root_id: u32) -> bool {
    let (Ok(prev), Ok(curr)) = (lopdf::Document::load_mem(&data[..prev_len]), lopdf::Document::load_mem(&data[..curr_len])) else { return false };
    const FORM_KEYS: &[&[u8]] = &[b"Fields", b"SigFlags", b"NeedAppearances", b"DR", b"DA"];
    for &num in changed {
        if num == root_id {
            continue;
        }
        let (Ok(old), Ok(new)) = (prev.get_object((num, 0)), curr.get_object((num, 0))) else { return false };
        let (Ok(od), Ok(nd)) = (old.as_dict(), new.as_dict()) else { return false }; // stream / khác → không an toàn
        if old.as_stream().is_ok() || new.as_stream().is_ok() {
            return false;
        }
        let is_sig_field = |d: &lopdf::Dictionary| {
            d.get(b"FT").and_then(|o| o.as_name()).ok() == Some(b"Sig".as_slice())
                || matches!(d.get(b"Type").and_then(|o| o.as_name()).ok(), Some(b"Sig") | Some(b"DocTimeStamp"))
        };
        if is_sig_field(nd) {
            continue;
        }
        let mut diff: Vec<Vec<u8>> = Vec::new();
        for (k, v) in nd.iter() {
            if od.get(k).map(|ov| format!("{ov:?}") != format!("{v:?}")).unwrap_or(true) {
                diff.push(k.clone());
            }
        }
        for (k, _) in od.iter() {
            if nd.get(k).is_err() {
                diff.push(k.clone());
            }
        }
        let is_page = nd.get(b"Type").and_then(|o| o.as_name()).ok() == Some(b"Page".as_slice());
        let ok = diff.iter().all(|k| {
            let k = k.as_slice();
            (is_page && k == b"Annots") || (!is_page && FORM_KEYS.contains(&k))
        });
        if !ok {
            return false;
        }
        // /Annots, /Fields: chỉ được THÊM phần tử.
        for key in [b"Annots".as_slice(), b"Fields"] {
            if let (Ok(a), Ok(b)) = (od.get(key).map(|o| deref(&prev, o)).and_then(|o| o.as_array()), nd.get(key).map(|o| deref(&curr, o)).and_then(|o| o.as_array())) {
                let bs: Vec<String> = b.iter().map(|x| format!("{x:?}")).collect();
                if a.iter().any(|x| !bs.contains(&format!("{x:?}"))) {
                    return false;
                }
            }
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oid_and_time() {
        assert_eq!(oid_str(&[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]), "1.2.840.113549.1.1.1");
        let gt = Tlv { tag: 0x18, body: b"20240115033000Z", raw: b"" };
        assert_eq!(parse_time(&gt), Some(1705289400));
        let ut = Tlv { tag: 0x17, body: b"240115033000Z", raw: b"" };
        assert_eq!(parse_time(&ut), Some(1705289400));
    }

    #[test]
    fn pdf_text_decoding() {
        assert_eq!(pdf_text(&[0xFE, 0xFF, 0x00, 0x50, 0x00, 0x68, 0x00, 0xEA]), "Phê");
        assert_eq!(pdf_text("Hà Nội".as_bytes()), "Hà Nội");
        assert_eq!(pdf_text(&[0x43, 0x61, 0x66, 0xE9]), "Café");
    }

    #[test]
    fn der_len_strips_padding() {
        let mut b = vec![0x30, 0x03, 0x02, 0x01, 0x05];
        b.extend([0u8; 10]);
        assert_eq!(der_len(&b), Some(5));
    }
}
