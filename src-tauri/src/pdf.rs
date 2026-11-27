//! App PDF — phần Rust:
//! - đọc file PDF (byte thô, không base64) cho pdf.js hiển thị ở UI;
//! - **kiểm chữ ký số** (`pdf_verify`): toàn vẹn ByteRange + chữ ký CMS/PKCS#7 + timestamp dùng crate `underskrift`
//!   (BSD-2-Clause, RustCrypto thuần); **chuỗi chứng thư tự kiểm theo THỜI ĐIỂM KÝ** (kiểu Acrobat) — underskrift
//!   chỉ kiểm theo giờ hiện tại nên chứng thư đã hết hạn sau khi ký sẽ bị coi là không tin cậy. Nguồn tin cậy:
//!   danh sách "Trust" riêng của app (file JSON) → kho Root của hệ điều hành → (Windows) `CertGetCertificateChain`
//!   (để Windows tự tải gốc qua Automatic Root Update / tải chứng thư trung gian qua AIA);
//! - **đăng ký làm app mở .pdf** (Windows, HKCU — không cần admin) + mở hộp thoại "Open with" để người dùng chọn
//!   (Windows 8+ không cho app tự đặt mình làm mặc định);
//! - hàng đợi file .pdf được mở từ Explorer (tham số dòng lệnh / tauri-plugin-single-instance).

use base64::Engine;
use der::{Decode, Encode, Tagged};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use x509_cert::Certificate;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;
/// Chặn file quá lớn (đọc cả file vào RAM rồi gửi sang webview).
const MAX_PDF: u64 = 1024 * 1024 * 1024;

// ───────────────────────── hàng đợi file mở từ Explorer ─────────────────────────

#[derive(Default)]
pub struct PdfState {
    pending: Mutex<Vec<String>>,
}

/// Lọc các tham số dòng lệnh là file .pdf có thật (tương đối thì tính theo `cwd`).
pub fn pdf_args<I: IntoIterator<Item = String>>(args: I, cwd: Option<&std::path::Path>) -> Vec<String> {
    args.into_iter()
        .filter(|a| !a.starts_with('-') && a.to_ascii_lowercase().ends_with(".pdf"))
        .map(|a| {
            let p = std::path::PathBuf::from(&a);
            match (p.is_absolute(), cwd) {
                (false, Some(c)) => c.join(p),
                _ => p,
            }
        })
        .filter(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

/// Lúc khởi động: file .pdf trong tham số dòng lệnh → hàng đợi (cửa sổ main sẽ mở app PDF).
pub fn init(app: &tauri::AppHandle) {
    let files = pdf_args(std::env::args().skip(1), std::env::current_dir().ok().as_deref());
    if !files.is_empty() {
        app.state::<PdfState>().pending.lock().unwrap().extend(files);
    }
    // Bản cài: giữ DevStation trong danh sách app mở được PDF (Open with / Settings → Default apps). Bản dev KHÔNG làm
    // (sẽ trỏ đăng ký tới exe debug). Chạy nền — đọc/ghi registry không chặn lúc mở app.
    #[cfg(all(windows, not(debug_assertions)))]
    std::thread::spawn(|| {
        if let Ok(exe) = exe_path() {
            winreg::ensure_registered(&exe);
        }
    });
}

/// Tiến trình thứ hai được mở (double-click file .pdf khi app đang chạy) → tauri-plugin-single-instance gọi vào đây
/// trong tiến trình ĐANG chạy. Có file → xếp hàng + báo một cửa sổ (ưu tiên cửa sổ app PDF) mở app PDF; không có
/// file → chỉ đưa cửa sổ lên trước.
#[cfg_attr(debug_assertions, allow(dead_code))] // chỉ dùng ở bản cài (single-instance)
pub fn on_second_instance(app: &tauri::AppHandle, argv: Vec<String>, cwd: String) {
    let files = pdf_args(argv.into_iter().skip(1), Some(std::path::Path::new(&cwd)));
    let wins = app.webview_windows();
    let target = ["app-pdf", "main"]
        .iter()
        .find_map(|l| wins.get(*l).cloned())
        .or_else(|| wins.values().find(|w| !w.label().starts_with("webtr-")).cloned());
    let Some(w) = target else { return };
    if files.is_empty() {
        // Mở lại app (không kèm file) → đưa cửa sổ lên trước.
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    // Có file: KHÔNG đưa cửa sổ này lên — nó có thể đang là app khác (main đã thành SSH…). JS (`fileOpen.ts`) tìm
    // đúng cửa sổ chứa app PDF rồi chỉ đưa cửa sổ đó lên trước.
    app.state::<PdfState>().pending.lock().unwrap().extend(files);
    let _ = app.emit_to(w.label(), "pdf-open-request", ());
}

#[tauri::command]
pub fn pdf_has_pending(state: tauri::State<'_, PdfState>) -> bool {
    !state.pending.lock().unwrap().is_empty()
}

#[tauri::command]
pub fn pdf_take_pending(state: tauri::State<'_, PdfState>) -> Vec<String> {
    std::mem::take(&mut *state.pending.lock().unwrap())
}

// ───────────────────────── đọc file ─────────────────────────

/// Đọc file PDF → ArrayBuffer ở UI (byte thô qua IPC, không base64/JSON).
#[tauri::command]
pub async fn pdf_read(path: String) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let meta = std::fs::metadata(&path).map_err(|e| format!("{path}: {e}"))?;
        if meta.len() > MAX_PDF {
            return Err(format!("{path}: file quá lớn ({} MB)", meta.len() / 1024 / 1024));
        }
        std::fs::read(&path).map(tauri::ipc::Response::new).map_err(|e| format!("{path}: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Mở link trong PDF bằng trình duyệt mặc định. PDF là dữ liệu không tin cậy → chỉ nhận http/https/mailto và
/// gọi thẳng ShellExecute (KHÔNG qua `cmd /C start`, vì cmd hiểu `&`/`|` trong URL thành lệnh).
#[tauri::command]
pub fn pdf_open_url(url: String) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:"))
        || url.chars().any(|c| c.is_control() || c == '"')
    {
        return Err(format!("URL không được phép: {url}"));
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        let op = wide("open");
        let u = wide(&url);
        let r = unsafe { ShellExecuteW(std::ptr::null_mut(), op.as_ptr(), u.as_ptr(), std::ptr::null(), std::ptr::null(), 1) };
        if (r as isize) <= 32 {
            return Err(format!("Không mở được {url}"));
        }
    }
    #[cfg(target_os = "macos")]
    std::process::Command::new("open").arg(&url).spawn().map_err(|e| e.to_string())?;
    #[cfg(all(not(windows), not(target_os = "macos")))]
    std::process::Command::new("xdg-open").arg(&url).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

// ───────────────────────── chứng thư ─────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CertOut {
    /// Tên chung (CN) — hoặc DN đầy đủ nếu không có CN.
    pub name: String,
    pub subject: String,
    pub issuer: String,
    pub serial: String,
    /// Unix giây.
    pub not_before: i64,
    pub not_after: i64,
    pub sha256: String,
    pub self_signed: bool,
    pub is_ca: bool,
    /// Nằm trong danh sách Trust của app.
    pub user_trusted: bool,
    /// DER base64 (để Trust / xuất file).
    pub der: String,
}

fn oid_short(oid: &str) -> Option<&'static str> {
    Some(match oid {
        "2.5.4.3" => "CN",
        "2.5.4.6" => "C",
        "2.5.4.7" => "L",
        "2.5.4.8" => "ST",
        "2.5.4.10" => "O",
        "2.5.4.11" => "OU",
        "2.5.4.12" => "T",
        "2.5.4.5" => "SERIALNUMBER",
        "2.5.4.4" => "SN",
        "2.5.4.42" => "G",
        "2.5.4.9" => "STREET",
        "0.9.2342.19200300.100.1.1" => "UID",
        "0.9.2342.19200300.100.1.25" => "DC",
        "1.2.840.113549.1.9.1" => "E",
        _ => return None,
    })
}

/// Giá trị một thuộc tính tên (UTF8String / PrintableString / IA5 / BMPString / TeletexString).
fn atv_text(v: &der::Any) -> String {
    let b = v.value();
    match v.tag() {
        der::Tag::BmpString => {
            let u: Vec<u16> = b.chunks(2).filter(|c| c.len() == 2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
            String::from_utf16_lossy(&u)
        }
        der::Tag::TeletexString => b.iter().map(|&c| c as char).collect(),
        _ => String::from_utf8_lossy(b).into_owned(),
    }
}

/// DN kiểu Windows/Acrobat: CN trước (RDN cuối lên đầu).
fn dn(name: &x509_cert::name::Name) -> (String, Option<String>) {
    let mut parts = Vec::new();
    let mut cn = None;
    for rdn in name.0.iter().rev() {
        for atv in rdn.0.iter() {
            let oid = atv.oid.to_string();
            let val = atv_text(&atv.value);
            if oid == "2.5.4.3" && cn.is_none() {
                cn = Some(val.clone());
            }
            parts.push(format!("{}={}", oid_short(&oid).unwrap_or(&oid), val));
        }
    }
    (parts.join(", "), cn)
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02X}")).collect()
}

fn sha256_hex(der: &[u8]) -> String {
    hex(&Sha256::digest(der))
}

fn cert_out(der: &[u8], trusted: &[Vec<u8>]) -> Option<CertOut> {
    let c = Certificate::from_der(der).ok()?;
    let tbs = &c.tbs_certificate;
    let (subject, cn) = dn(&tbs.subject);
    let (issuer, _) = dn(&tbs.issuer);
    let is_ca = tbs
        .extensions
        .as_ref()
        .and_then(|exts| exts.iter().find(|e| e.extn_id.to_string() == "2.5.29.19"))
        .and_then(|e| x509_cert::ext::pkix::BasicConstraints::from_der(e.extn_value.as_bytes()).ok())
        .map(|bc| bc.ca)
        .unwrap_or(false);
    Some(CertOut {
        name: cn.unwrap_or_else(|| subject.clone()),
        subject,
        issuer,
        serial: hex(tbs.serial_number.as_bytes()),
        not_before: tbs.validity.not_before.to_unix_duration().as_secs() as i64,
        not_after: tbs.validity.not_after.to_unix_duration().as_secs() as i64,
        sha256: sha256_hex(der),
        self_signed: tbs.subject == tbs.issuer,
        is_ca,
        user_trusted: trusted.iter().any(|t| t == der),
        der: B64.encode(der),
    })
}

// ───────────────────────── danh sách Trust của app ─────────────────────────

fn data_dir() -> std::path::PathBuf {
    #[cfg(windows)]
    if let Some(p) = std::env::var_os("LOCALAPPDATA") {
        return std::path::PathBuf::from(p).join("DevStation");
    }
    #[cfg(target_os = "macos")]
    if let Some(h) = std::env::var_os("HOME") {
        return std::path::PathBuf::from(h).join("Library/Application Support/DevStation");
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Some(x) = std::env::var_os("XDG_DATA_HOME") {
            return std::path::PathBuf::from(x).join("devstation");
        }
        if let Some(h) = std::env::var_os("HOME") {
            return std::path::PathBuf::from(h).join(".local/share/devstation");
        }
    }
    std::env::temp_dir().join("devstation")
}

fn trust_file() -> std::path::PathBuf {
    data_dir().join("pdf-trust.json")
}

static TRUST_LOCK: Mutex<()> = Mutex::new(());

/// DER các chứng thư người dùng đã bấm Trust.
fn load_trusted() -> Vec<Vec<u8>> {
    let Ok(s) = std::fs::read_to_string(trust_file()) else { return Vec::new() };
    let v: Vec<serde_json::Value> = serde_json::from_str(&s).unwrap_or_default();
    v.iter()
        .filter_map(|e| e.get("der").and_then(|d| d.as_str()))
        .filter_map(|d| B64.decode(d).ok())
        .collect()
}

fn save_trusted(list: &[Vec<u8>]) -> Result<(), String> {
    let f = trust_file();
    if let Some(d) = f.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let v: Vec<serde_json::Value> = list.iter().map(|d| serde_json::json!({ "der": B64.encode(d) })).collect();
    std::fs::write(&f, serde_json::to_string_pretty(&v).unwrap()).map_err(|e| format!("{}: {e}", f.display()))
}

#[tauri::command]
pub fn pdf_trust_list() -> Vec<CertOut> {
    let list = load_trusted();
    list.iter().filter_map(|d| cert_out(d, &list)).collect()
}

/// Thêm một chứng thư (DER base64) vào danh sách Trust. UI đã hỏi xác nhận (hiện fingerprint) trước khi gọi.
#[tauri::command]
pub fn pdf_trust_add(der: String) -> Result<(), String> {
    let bytes = B64.decode(der.trim()).map_err(|e| e.to_string())?;
    Certificate::from_der(&bytes).map_err(|e| format!("Chứng thư không hợp lệ: {e}"))?;
    let _g = TRUST_LOCK.lock().unwrap();
    let mut list = load_trusted();
    if !list.contains(&bytes) {
        list.push(bytes);
        save_trusted(&list)?;
    }
    Ok(())
}

#[tauri::command]
pub fn pdf_trust_remove(sha256: String) -> Result<(), String> {
    let _g = TRUST_LOCK.lock().unwrap();
    let mut list = load_trusted();
    list.retain(|d| !sha256_hex(d).eq_ignore_ascii_case(&sha256));
    save_trusted(&list)
}

// ───────────────────────── kho Root của hệ điều hành ─────────────────────────

/// DER các chứng thư gốc của hệ điều hành (đọc một lần).
fn system_roots() -> &'static Vec<Vec<u8>> {
    static ROOTS: std::sync::OnceLock<Vec<Vec<u8>>> = std::sync::OnceLock::new();
    ROOTS.get_or_init(|| {
        #[cfg(windows)]
        {
            windows_store("ROOT")
        }
        #[cfg(not(windows))]
        {
            let mut out = Vec::new();
            for p in [
                "/etc/ssl/certs/ca-certificates.crt",
                "/etc/pki/tls/certs/ca-bundle.crt",
                "/etc/ssl/cert.pem",
                "/etc/ssl/ca-bundle.pem",
            ] {
                if let Ok(s) = std::fs::read_to_string(p) {
                    for block in s.split("-----BEGIN CERTIFICATE-----").skip(1) {
                        if let Some(body) = block.split("-----END CERTIFICATE-----").next() {
                            let b: String = body.chars().filter(|c| !c.is_whitespace()).collect();
                            if let Ok(d) = B64.decode(b) {
                                out.push(d);
                            }
                        }
                    }
                    break;
                }
            }
            out
        }
    })
}

#[cfg(windows)]
fn windows_store(name: &str) -> Vec<Vec<u8>> {
    use windows_sys::Win32::Security::Cryptography::*;
    let mut out = Vec::new();
    let n = wide(name);
    unsafe {
        let store = CertOpenSystemStoreW(0, n.as_ptr());
        if store.is_null() {
            return out;
        }
        let mut ctx: *const CERT_CONTEXT = std::ptr::null();
        loop {
            ctx = CertEnumCertificatesInStore(store, ctx);
            if ctx.is_null() {
                break;
            }
            let c = &*ctx;
            out.push(std::slice::from_raw_parts(c.pbCertEncoded, c.cbCertEncoded as usize).to_vec());
        }
        CertCloseStore(store, 0);
    }
    out
}

/// Hỏi Windows (CryptoAPI) chuỗi `leaf` + `extra` có dẫn về gốc tin cậy tại thời điểm `at` không — Windows tự
/// tải gốc chưa có sẵn (Automatic Root Update) và chứng thư trung gian thiếu (AIA). Không kiểm thu hồi.
/// Trả về (tin cậy?, chuỗi DER leaf→root Windows dựng được — kể cả khi gốc chưa tin cậy: CA trung gian tải qua AIA).
#[cfg(windows)]
fn windows_chain(leaf: &[u8], extra: &[Vec<u8>], at: i64) -> Option<(bool, Vec<Vec<u8>>)> {
    use windows_sys::Win32::Foundation::{BOOL, FILETIME};
    use windows_sys::Win32::Security::Cryptography::*;
    /// CERT_CHAIN_PARA bản đầy đủ (windows-sys chỉ khai báo 2 trường đầu) — cần `dwUrlRetrievalTimeout`.
    #[repr(C)]
    struct ChainParaEx {
        cb_size: u32,
        requested_usage: CERT_USAGE_MATCH,
        requested_issuance_policy: CERT_USAGE_MATCH,
        url_retrieval_timeout: u32,
        check_revocation_freshness_time: BOOL,
        revocation_freshness_time: u32,
        cache_resync: *mut FILETIME,
    }
    const ENC: u32 = X509_ASN_ENCODING | PKCS_7_ASN_ENCODING;
    // UNTRUSTED_ROOT | PARTIAL_CHAIN | NOT_SIGNATURE_VALID | REVOKED | CYCLIC | EXPLICIT_DISTRUST | NOT_TIME_VALID
    const BAD: u32 = 0x20 | 0x10000 | 0x8 | 0x4 | 0x80 | 0x0400_0000 | 0x1;
    unsafe {
        let mem = CertOpenStore(CERT_STORE_PROV_MEMORY, 0, 0, 0, std::ptr::null());
        if mem.is_null() {
            return None;
        }
        let mut leaf_ctx: *mut CERT_CONTEXT = std::ptr::null_mut();
        let ok = CertAddEncodedCertificateToStore(mem, ENC, leaf.as_ptr(), leaf.len() as u32, CERT_STORE_ADD_ALWAYS, &mut leaf_ctx);
        if ok == 0 || leaf_ctx.is_null() {
            CertCloseStore(mem, 0);
            return None;
        }
        for d in extra {
            CertAddEncodedCertificateToStore(mem, ENC, d.as_ptr(), d.len() as u32, CERT_STORE_ADD_ALWAYS, std::ptr::null_mut());
        }
        let ticks = ((at + 11_644_473_600).max(0) as u64) * 10_000_000;
        let ft = FILETIME { dwLowDateTime: ticks as u32, dwHighDateTime: (ticks >> 32) as u32 };
        let mut para: ChainParaEx = std::mem::zeroed();
        para.cb_size = std::mem::size_of::<ChainParaEx>() as u32;
        para.url_retrieval_timeout = 5000;
        let mut chain: *mut CERT_CHAIN_CONTEXT = std::ptr::null_mut();
        let got = CertGetCertificateChain(
            0 as _,
            leaf_ctx,
            &ft,
            mem,
            &para as *const ChainParaEx as *const CERT_CHAIN_PARA,
            0,
            std::ptr::null(),
            &mut chain,
        );
        let mut res = None;
        if got != 0 && !chain.is_null() {
            let cc = &*chain;
            // Có mắt xích chữ ký sai (CERT_TRUST_IS_NOT_SIGNATURE_VALID — vd. Windows ghép nhầm CA cùng tên nhưng khác khoá)
            // → bỏ, không dùng cả để hiển thị.
            if cc.cChain > 0 && cc.TrustStatus.dwErrorStatus & 0x8 == 0 {
                let trusted = cc.TrustStatus.dwErrorStatus & BAD == 0;
                let simple = &**cc.rgpChain;
                let mut ders = Vec::new();
                for i in 0..simple.cElement as usize {
                    let el = &**simple.rgpElement.add(i);
                    let c = &*el.pCertContext;
                    ders.push(std::slice::from_raw_parts(c.pbCertEncoded, c.cbCertEncoded as usize).to_vec());
                }
                res = Some((trusted, ders));
            }
            CertFreeCertificateChain(chain);
        }
        CertFreeCertificateContext(leaf_ctx);
        CertCloseStore(mem, 0);
        res
    }
}

// ───────────────────────── kiểm chữ ký ─────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SigOut {
    pub field: String,
    /// pades | pkcs7 | pkcs7sha1 | timestamp | unknown
    pub kind: String,
    /// valid | unknown | invalid
    pub status: String,
    pub signer: Option<String>,
    pub reason: Option<String>,
    pub location: Option<String>,
    pub contact: Option<String>,
    /// /Name trong từ điển chữ ký.
    pub name_field: Option<String>,
    /// /M (giờ máy người ký ghi vào PDF, không được bảo vệ) — unix giây.
    pub pdf_time: Option<i64>,
    /// signingTime trong CMS (được ký, nhưng vẫn là giờ máy người ký).
    pub cms_time: Option<i64>,
    /// Timestamp RFC 3161 (của TSA).
    pub ts_time: Option<i64>,
    pub ts_verified: bool,
    /// Thời điểm dùng để kiểm chuỗi chứng thư + nguồn: timestamp | signer | pdf | now.
    pub time_used: i64,
    pub time_source: String,
    pub integrity_ok: bool,
    pub digest_ok: bool,
    pub crypto_ok: bool,
    pub crypto_error: Option<String>,
    /// Chữ ký phủ tới cuối file (không có bản cập nhật nào sau khi ký).
    pub covers_whole: bool,
    /// Có thay đổi sau khi ký.
    pub modified_after: bool,
    /// Thay đổi sau khi ký KHÔNG phải loại an toàn (chữ ký/timestamp/DSS sau).
    pub unsafe_changes: Option<bool>,
    /// Byte cuối mà chữ ký phủ (= độ dài file lúc ký) → UI cắt ra "bản lúc ký".
    pub rev_end: usize,
    pub trusted: bool,
    /// app | system | windows
    pub trust_source: Option<String>,
    /// expired | notYetValid | untrustedRoot | chainIncomplete | badSignature | error
    pub chain_error: Option<String>,
    pub chain_error_text: Option<String>,
    pub chain: Vec<CertOut>,
    pub algorithm: Option<String>,
    pub pades_level: Option<String>,
    pub issues: Vec<String>,
    /// Thuật toán băm yếu (SHA-1) — chữ ký vẫn toàn vẹn nhưng không coi là hợp lệ đầy đủ.
    pub weak_hash: Option<String>,
    /// Thu hồi theo CRL/OCSP NHÚNG trong file (không gọi mạng).
    pub revocation: crate::pdfsig::Revocation,
    /// Bị thu hồi TRƯỚC (hoặc đúng) thời điểm ký → chữ ký không hợp lệ.
    pub revoked: bool,
    /// Chữ ký chứng nhận: mức DocMDP /P (1 = cấm sửa, 2 = chỉ điền form + ký, 3 = + ghi chú).
    pub docmdp: Option<u8>,
    /// Có thay đổi sau khi ký vượt quá quyền DocMDP cho phép.
    pub docmdp_violation: bool,
    /// Chữ ký được kiểm bằng bộ kiểm riêng (pdfsig) vì underskrift không hỗ trợ thuật toán (vd. rsaEncryption).
    pub fallback: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyOut {
    pub signatures: Vec<SigOut>,
    /// Lỗi đọc cấu trúc chữ ký (PDF hỏng / dạng chưa hỗ trợ) — vẫn xem được file.
    pub error: Option<String>,
}

/// "D:YYYYMMDDHHmmSSOHH'mm'" → unix giây.
fn parse_pdf_date(s: &str) -> Option<i64> {
    let s = s.trim().trim_start_matches("D:");
    let num = |a: usize, b: usize, def: i64| -> Option<i64> {
        match s.get(a..b) {
            Some(x) if !x.is_empty() => x.parse().ok(),
            _ => Some(def),
        }
    };
    let y = s.get(0..4)?.parse::<i32>().ok()?;
    let (mo, d, h, mi, se) = (num(4, 6, 1)?, num(6, 8, 1)?, num(8, 10, 0)?, num(10, 12, 0)?, num(12, 14, 0)?);
    let date = chrono::NaiveDate::from_ymd_opt(y, mo as u32, d as u32)?;
    let t = date.and_hms_opt(h as u32, mi as u32, se as u32)?;
    let mut off = 0i64;
    if let Some(z) = s.get(14..) {
        let sign = match z.chars().next() {
            Some('+') => 1,
            Some('-') => -1,
            _ => 0,
        };
        if sign != 0 {
            let digits: String = z[1..].chars().filter(|c| c.is_ascii_digit()).collect();
            let oh = digits.get(0..2).and_then(|x| x.parse::<i64>().ok()).unwrap_or(0);
            let om = digits.get(2..4).and_then(|x| x.parse::<i64>().ok()).unwrap_or(0);
            off = sign * (oh * 3600 + om * 60);
        }
    }
    Some(t.and_utc().timestamp() - off)
}

fn alg_name(oid: &str) -> String {
    match oid {
        "1.2.840.113549.1.1.5" => "RSA-SHA1",
        "1.2.840.113549.1.1.11" => "RSA-SHA256",
        "1.2.840.113549.1.1.12" => "RSA-SHA384",
        "1.2.840.113549.1.1.13" => "RSA-SHA512",
        "1.2.840.113549.1.1.10" => "RSA-PSS",
        "1.2.840.113549.1.1.1" => "RSA",
        "1.2.840.10045.4.1" => "ECDSA-SHA1",
        "1.2.840.10045.4.3.2" => "ECDSA-SHA256",
        "1.2.840.10045.4.3.3" => "ECDSA-SHA384",
        "1.2.840.10045.4.3.4" => "ECDSA-SHA512",
        "1.3.101.112" => "Ed25519",
        _ => return oid.to_string(),
    }
    .to_string()
}

struct ChainResult {
    trusted: bool,
    source: Option<String>,
    error: Option<String>,
    error_text: Option<String>,
    chain: Vec<Vec<u8>>,
}

/// Xếp chuỗi leaf → issuer → … chỉ theo tên (issuer == subject), không kiểm chữ ký — dùng để HIỂN THỊ.
fn order_chain(leaf: &Certificate, pool: &[Certificate]) -> Vec<Certificate> {
    let mut chain = vec![leaf.clone()];
    let mut used = vec![false; pool.len()];
    loop {
        let cur = chain.last().unwrap();
        if cur.tbs_certificate.issuer == cur.tbs_certificate.subject || chain.len() > 10 {
            break;
        }
        let next = pool.iter().enumerate().find(|(i, c)| !used[*i] && c.tbs_certificate.subject == cur.tbs_certificate.issuer && *c != cur);
        match next {
            Some((i, c)) => {
                used[i] = true;
                chain.push(c.clone());
            }
            None => break,
        }
    }
    chain
}

/// Kiểm chuỗi chứng thư của người ký tại thời điểm `at` (unix giây).
fn check_chain(leaf_der: &[u8], extra: &[Vec<u8>], at: i64, user: &[Vec<u8>]) -> ChainResult {
    use underskrift::trust::{build_chain_from_pool_with_policy, trust_anchor_subjects};
    use underskrift::trust::TrustStore;
    let fail = |code: &str, text: String, chain: Vec<Vec<u8>>| ChainResult {
        trusted: false,
        source: None,
        error: Some(code.into()),
        error_text: Some(text),
        chain,
    };
    let Ok(leaf) = Certificate::from_der(leaf_der) else {
        return fail("error", "không đọc được chứng thư người ký".into(), vec![leaf_der.to_vec()]);
    };
    let Ok(time) = der::DateTime::from_unix_duration(std::time::Duration::from_secs(at.max(0) as u64)) else {
        return fail("error", "thời điểm kiểm không hợp lệ".into(), vec![leaf_der.to_vec()]);
    };
    let mut pool: Vec<Certificate> = extra.iter().filter_map(|d| Certificate::from_der(d).ok()).collect();
    let policy = underskrift::trust::TrustStore::new().allow_legacy_signatures().signature_policy();
    let ders = |c: &[Certificate]| c.iter().filter_map(|x| x.to_der().ok()).collect::<Vec<_>>();
    let ok = |source: &str, chain: Vec<Vec<u8>>| ChainResult { trusted: true, source: Some(source.into()), error: None, error_text: None, chain };

    // 1) Danh sách Trust của app — người dùng tin một chứng thư bất kỳ trong chuỗi (kể cả chính người ký).
    let try_user = |pool: &[Certificate]| -> Option<ChainResult> {
        if user.is_empty() {
            return None;
        }
        if user.iter().any(|t| t.as_slice() == leaf_der) {
            let v = &leaf.tbs_certificate.validity;
            return (time >= v.not_before.to_date_time() && time <= v.not_after.to_date_time()).then(|| ok("app", vec![leaf_der.to_vec()]));
        }
        let mut store = TrustStore::new().allow_legacy_signatures();
        for d in user {
            let _ = store.add_der_certificate(d);
        }
        let chain = build_chain_from_pool_with_policy(&leaf, pool, &trust_anchor_subjects(&store), None, &policy).unwrap_or_else(|_| vec![leaf.clone()]);
        let anchor = store.verify_chain(&chain, Some(time)).ok()?;
        let mut c = ders(&chain);
        if let Ok(a) = anchor.to_der() {
            if !c.contains(&a) {
                c.push(a);
            }
        }
        Some(ok("app", c))
    };
    if let Some(r) = try_user(&pool) {
        return r;
    }

    // 2) Kho Root của hệ điều hành.
    let mut sys = TrustStore::new().allow_legacy_signatures();
    for d in system_roots() {
        let _ = sys.add_der_certificate(d);
    }
    let chain = build_chain_from_pool_with_policy(&leaf, &pool, &trust_anchor_subjects(&sys), None, &policy).unwrap_or_else(|_| vec![leaf.clone()]);
    let first_err = match sys.verify_chain(&chain, Some(time)) {
        Ok(anchor) => {
            let mut c = ders(&chain);
            if let Ok(a) = anchor.to_der() {
                if !c.contains(&a) {
                    c.push(a);
                }
            }
            return ok("system", c);
        }
        Err(e) => e,
    };

    // 3) Windows: để CryptoAPI dựng chuỗi (tự tải gốc qua Automatic Root Update + CA trung gian qua AIA). Gốc chưa tin
    //    cậy thì vẫn lấy chuỗi Windows dựng được: thêm CA trung gian vào kho rồi thử lại danh sách Trust của app (người
    //    dùng Trust gốc quốc gia mà file không nhúng CA cấp — vd. file ký Viettel/FPT/VNPT chỉ nhúng chứng thư người ký).
    let mut display: Option<Vec<Vec<u8>>> = None;
    #[cfg(windows)]
    if let Some((trusted, c)) = timed("windows_chain", || windows_chain(leaf_der, extra, at)) {
        if trusted {
            return ok("windows", c);
        }
        let before = pool.len();
        for d in &c {
            if let Ok(x) = Certificate::from_der(d) {
                if !pool.contains(&x) {
                    pool.push(x);
                }
            }
        }
        if pool.len() > before {
            if let Some(r) = try_user(&pool) {
                return r;
            }
        }
        display = Some(c);
    }

    use underskrift::error::TrustError as TE;
    let code = match &first_err {
        TE::Expired { .. } => "expired",
        TE::NotYetValid { .. } => "notYetValid",
        TE::UntrustedRoot { .. } => "untrustedRoot",
        TE::ChainBroken { .. } => "chainIncomplete",
        _ => "error",
    };
    // Không tin cậy được: hiện chuỗi dài nhất có được (Windows dựng / xếp từ chứng thư nhúng) để người dùng xem + Trust
    // CA trên cùng (thường là gốc quốc gia).
    let embedded = ders(&order_chain(&leaf, &pool));
    let shown = match display {
        Some(w) if w.len() > embedded.len() => w,
        _ => embedded,
    };
    // Chuỗi Windows ghép theo KHOÁ (AKI/SKI) nhưng tên CA cấp ghi trong chứng thư không khớp tên CA tìm được (vd.
    // chứng thư hệ thống thử nghiệm "… (TEST)" ghép với CA chính thức cùng khoá) → RFC 5280 coi là chuỗi hỏng, Trust
    // gốc cũng không cứu được → báo riêng thay vì "gốc chưa tin cậy".
    let certs: Vec<Certificate> = shown.iter().filter_map(|d| Certificate::from_der(d).ok()).collect();
    if certs.windows(2).any(|w| w[0].tbs_certificate.issuer != w[1].tbs_certificate.subject) {
        return fail("issuerMismatch", "tên CA cấp trong chứng thư không khớp CA trong chuỗi".into(), shown);
    }
    fail(code, first_err.to_string(), shown)
}

/// Đầu vào chung cho một chữ ký (từ underskrift hoặc quét thô /ByteRange).
struct SigInput<'a> {
    field: String,
    kind: String,
    br: [usize; 4],
    cms: &'a [u8],
    reason: Option<String>,
    location: Option<String>,
    contact: Option<String>,
    name_field: Option<String>,
    pdf_time: Option<i64>,
    u: Option<&'a underskrift::verify::SignatureVerificationResult>,
}

/// Ngữ cảnh dùng chung cho mọi chữ ký của một file.
struct DocCtx<'a> {
    data: &'a [u8],
    user: &'a [Vec<u8>],
    info: crate::pdfsig::DocInfo,
    /// Phân tích bản cập nhật — LƯỜI (đọc lại từng bản bằng lopdf, chậm): chỉ chạy khi có chữ ký không phủ hết file.
    revs: std::cell::OnceCell<Option<underskrift::core::revision::RevisionAnalysis>>,
    benign: std::cell::RefCell<std::collections::HashMap<usize, bool>>,
    now: i64,
}

impl DocCtx<'_> {
    fn revs(&self) -> Option<&underskrift::core::revision::RevisionAnalysis> {
        self.revs
            .get_or_init(|| timed("revision analysis", || underskrift::core::revision::RevisionAnalysis::analyze(self.data, &underskrift::core::revision::DefaultSafeObjectClassifier).ok()))
            .as_ref()
    }

    /// Bản cập nhật thứ j (sau khi ký) có "an toàn" không: underskrift cho là an toàn / DSS hợp lệ, hoặc là bản thêm
    /// chữ ký/dấu thời gian mà mọi thay đổi chỉ là thêm chữ ký (chấm lại bằng pdfsig::benign_sig_revision).
    fn rev_safe(&self, j: usize) -> bool {
        let Some(ra) = self.revs() else { return false };
        let revs = ra.revisions();
        let r = &revs[j];
        if r.safe_update || r.valid_dss {
            return true;
        }
        if !(r.is_signature || r.is_doc_timestamp) || j == 0 {
            return false;
        }
        if let Some(v) = self.benign.borrow().get(&j) {
            return *v;
        }
        let changed: Vec<u32> = r.changed_xref.keys().copied().collect();
        let v = crate::pdfsig::benign_sig_revision(self.data, revs[j - 1].length, r.length, &changed, r.root_object_id);
        self.benign.borrow_mut().insert(j, v);
        v
    }

    /// (có bản cập nhật không an toàn sau vùng ký, có bản cập nhật nào ngoài DSS/dấu thời gian tài liệu) — None nếu
    /// không phân tích được revision (file mã hoá).
    fn later_changes(&self, rev_end: usize) -> Option<(bool, bool)> {
        let ra = self.revs()?;
        let revs = ra.revisions();
        let i = revs.iter().position(|r| r.length == rev_end || (r.length >= rev_end && r.length - rev_end <= 2))?;
        let mut unsafe_ = false;
        let mut other = false;
        for j in i + 1..revs.len() {
            if !self.rev_safe(j) {
                unsafe_ = true;
            }
            if !(revs[j].valid_dss || revs[j].is_doc_timestamp) {
                other = true;
            }
        }
        Some((unsafe_, other))
    }
}

fn alg_label(sig_alg: &str, hash: Option<crate::pdfsig::Hash>) -> Option<String> {
    let h = hash.map(|h| h.name().replace("SHA-", "SHA")).unwrap_or_default();
    match sig_alg {
        "1.2.840.113549.1.1.1" => Some(format!("RSA-{h}")),
        "1.2.840.10045.2.1" => Some(format!("ECDSA-{h}")),
        "" => None,
        o => Some(alg_name(o)),
    }
}

fn build_sig(ctx: &DocCtx, mut inp: SigInput) -> SigOut {
    // Trường văn bản đọc lại bằng lopdf (giải mã đúng UTF-16BE) — ưu tiên hơn chuỗi của underskrift.
    if let Some((_, m)) = ctx.info.meta.iter().find(|(b, _)| *b == inp.br) {
        let m = m.clone();
        inp.reason = m.reason.or(inp.reason);
        inp.location = m.location.or(inp.location);
        inp.contact = m.contact.or(inp.contact);
        inp.name_field = m.name.or(inp.name_field);
        if let Some(t) = m.m.as_deref().and_then(parse_pdf_date) {
            inp.pdf_time = Some(t);
        }
    }
    use crate::pdfsig::{verify_cms, verify_ts, range_parts, revocation, Hash};
    use underskrift::verify::{CryptoValidity, DetectedPadesLevel};
    let data = ctx.data;
    let br = inp.br;
    let rev_end = br[2] + br[3];
    let parts = range_parts(data, &br);
    let u = inp.u;
    let mut issues: Vec<String> = u.map(|r| r.integrity_issues.iter().cloned().chain(std::iter::once(r.summary.clone()).filter(|s| !s.is_empty())).collect()).unwrap_or_default();
    // Byte sau vùng ký chỉ là khoảng trắng/xuống dòng thì vẫn coi là phủ hết file.
    let integ = u.is_none().then(|| underskrift::verify::integrity::verify_byte_range(data, &br, underskrift::DigestAlgorithm::Sha256));
    if let Some(i) = &integ {
        issues.extend(i.issues.iter().cloned());
    }
    // Byte sau vùng ký chỉ là khoảng trắng/xuống dòng thì vẫn coi là phủ hết file.
    let covers_whole = u.map(|r| r.covers_whole_document).unwrap_or_else(|| {
        integ.as_ref().map(|i| i.covers_whole_file).unwrap_or(false) || data[rev_end.min(data.len())..].iter().all(|c| c.is_ascii_whitespace())
    });
    let integrity_ok = u.map(|r| r.integrity_ok).unwrap_or_else(|| integ.as_ref().map(|i| i.valid).unwrap_or(br[0] == 0 && rev_end <= data.len()));
    // underskrift báo "unsupported/unknown algorithm" (vd. rsaEncryption, SHA-1) hoặc không có kết quả → dùng pdfsig.
    let u_unsupported = u.map(|r| match &r.cryptographic_validity {
        CryptoValidity::Valid => false,
        CryptoValidity::UnknownAlgorithm(_) => true,
        CryptoValidity::Invalid(e) => e.contains("unsupported") || e.contains("TSA signature verification failed"),
    }).unwrap_or(true);
    let u_valid = u.map(|r| matches!(r.cryptographic_validity, CryptoValidity::Valid)).unwrap_or(false);

    let mut crls = ctx.info.crls.clone();
    let mut ocsps = ctx.info.ocsps.clone();
    let (crypto_ok, digest_ok, crypto_error, signer_der, certs, cms_time, ts_time, ts_verified, hash, algorithm);
    let mut ts_gen = None;
    if inp.kind == "timestamp" {
        // Dấu thời gian tài liệu: /Contents chính là token TSA, messageImprint = băm(ByteRange).
        let t = verify_ts(inp.cms, &parts);
        crls.extend(t.crls.iter().cloned());
        ocsps.extend(t.ocsps.iter().cloned());
        crypto_ok = u_valid || t.sig_ok;
        digest_ok = (u_valid && u.map(|r| r.digest_matches).unwrap_or(false)) || t.imprint_ok;
        crypto_error = if crypto_ok { None } else { t.error.clone().or_else(|| Some("chữ ký TSA không đúng".into())) };
        signer_der = t.tsa.clone();
        certs = t.certs.clone();
        cms_time = None;
        ts_time = t.gen_time;
        ts_gen = t.gen_time;
        hash = t.hash;
        algorithm = None;
        ts_verified = false; // đặt lại sau khi kiểm chuỗi TSA
    } else {
        let own = verify_cms(inp.cms, Some(&|h: Hash| h.digest(&parts)));
        crls.extend(own.crls.iter().cloned());
        ocsps.extend(own.ocsps.iter().cloned());
        if u_valid || !u_unsupported {
            let r = u.unwrap();
            crypto_ok = u_valid;
            digest_ok = r.digest_matches;
            crypto_error = match &r.cryptographic_validity {
                CryptoValidity::Valid => None,
                CryptoValidity::Invalid(e) | CryptoValidity::UnknownAlgorithm(e) => Some(e.clone()),
            };
        } else {
            crypto_ok = own.sig_ok;
            digest_ok = own.digest_ok;
            crypto_error = if own.sig_ok && own.digest_ok { None } else if !own.digest_ok && own.sig_ok { Some("nội dung đã bị sửa (messageDigest không khớp)".into()) } else { own.error.clone() };
        }
        signer_der = u.and_then(|r| r.signer_cert_der.clone()).or(own.signer.clone());
        let mut c: Vec<Vec<u8>> = u.map(|r| r.chain_certs_der.clone()).unwrap_or_default();
        for x in &own.certs {
            if !c.contains(x) {
                c.push(x.clone());
            }
        }
        certs = c;
        cms_time = u.and_then(|r| r.cms_signing_time.map(|t| t.timestamp())).or(own.signing_time);
        hash = own.hash;
        algorithm = u.and_then(|r| r.signature_algorithm_oid.as_deref()).filter(|o| *o != "1.2.840.113549.1.1.1").map(alg_name).or_else(|| alg_label(&own.sig_alg, own.hash));
        // Dấu thời gian trong chữ ký: underskrift đã kiểm được thì dùng; không thì tự kiểm (TSA dùng rsaEncryption…).
        let token = own.ts_token.clone().or_else(|| u.and_then(|r| r.timestamp_token_der.clone()));
        let mut tv = u.and_then(|r| r.validation_time_used.map(|t| t.timestamp()));
        let mut tt = u.and_then(|r| r.timestamp_time.as_deref().and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()).map(|t| t.timestamp()));
        if tv.is_none() {
            if let Some(tok) = token {
                let t = verify_ts(&tok, &[&own.signature_value]);
                crls.extend(t.crls.iter().cloned());
                ocsps.extend(t.ocsps.iter().cloned());
                if let Some(g) = t.gen_time {
                    tt = Some(g);
                    if t.sig_ok && t.imprint_ok {
                        if let Some(tsa) = &t.tsa {
                            if check_chain(tsa, &t.certs, g, ctx.user).trusted {
                                tv = Some(g);
                            } else {
                                issues.push("dấu thời gian: chưa tin cậy được TSA".into());
                            }
                        }
                    } else {
                        issues.push(format!("dấu thời gian không hợp lệ: {}", t.error.unwrap_or_else(|| "messageImprint không khớp".into())));
                    }
                }
            }
        }
        ts_verified = tv.is_some();
        ts_time = tv.or(tt);
    }

    let (time_used, time_source) = if inp.kind == "timestamp" {
        (ts_gen.unwrap_or(ctx.now), if ts_gen.is_some() { "timestamp" } else { "now" })
    } else if ts_verified {
        (ts_time.unwrap_or(ctx.now), "timestamp")
    } else if let Some(t) = cms_time {
        (t, "signer")
    } else if let Some(t) = ts_time {
        (t, "timestamp")
    } else if let Some(t) = inp.pdf_time {
        (t, "pdf")
    } else {
        (ctx.now, "now")
    };
    // Chuỗi: chứng thư trong CMS + chứng thư trong DSS của tài liệu.
    let mut certs = certs;
    for c in &ctx.info.certs {
        if !certs.contains(c) {
            certs.push(c.clone());
        }
    }
    let chain = match &signer_der {
        Some(leaf) => check_chain(leaf, &certs, time_used, ctx.user),
        None => ChainResult { trusted: false, source: None, error: Some("error".into()), error_text: Some("không có chứng thư người ký".into()), chain: Vec::new() },
    };
    let ts_verified = if inp.kind == "timestamp" { crypto_ok && digest_ok && chain.trusted } else { ts_verified };

    // Thu hồi (CRL/OCSP nhúng). Bị thu hồi trước/đúng lúc ký → không hợp lệ; thu hồi SAU thời điểm ký (đã có dấu thời
    // gian tin cậy chứng minh) → chữ ký vẫn đúng tại thời điểm ký.
    let rv = timed("revocation", || revocation(&chain.chain, &crls, &ocsps));
    let revoked = rv.status == "revoked" && rv.revoked_at.map(|t| t <= time_used || !ts_verified).unwrap_or(true);

    let modified_after = !covers_whole;
    let later = ctx.later_changes(rev_end);
    let unsafe_changes = modified_after.then(|| later.map(|(u_, _)| u_).unwrap_or(false));
    let docmdp = ctx.info.docmdp.iter().find(|(b, _)| *b == br).map(|(_, p)| *p);
    let docmdp_violation = match docmdp {
        Some(1) => modified_after && later.map(|(_, other)| other).unwrap_or(true),
        Some(_) => unsafe_changes == Some(true),
        None => false,
    };
    let weak_hash = (hash == Some(Hash::Sha1)).then(|| "SHA-1".to_string());

    // underskrift không đọc được thuật toán (vd. rsaEncryption) nhưng bộ kiểm riêng (pdfsig) đã xác thực được → bỏ log
    // thô "INVALID: … unsupported …" của nó (gây hiểu lầm); UI hiện câu giải thích theo cờ `fallback`.
    let fallback = u_unsupported && u.is_some() && crypto_ok && digest_ok;
    if fallback {
        issues.retain(|s| !(s.contains("unsupported") || s.starts_with("INVALID") || s.starts_with("VALID")));
    }
    let unsupported = !crypto_ok && crypto_error.as_deref().map(|e| e.contains("chưa hỗ trợ")).unwrap_or(false);
    let status = if unsupported {
        "unknown"
    } else if !integrity_ok || !crypto_ok || !digest_ok || revoked || docmdp_violation {
        "invalid"
    } else if !chain.trusted || weak_hash.is_some() {
        "unknown"
    } else {
        "valid"
    }
    .to_string();
    let signer = signer_der.as_deref().and_then(|d| Certificate::from_der(d).ok()).map(|c| {
        let (s, cn) = dn(&c.tbs_certificate.subject);
        cn.unwrap_or(s)
    });
    SigOut {
        field: inp.field,
        kind: inp.kind,
        status,
        signer,
        reason: inp.reason,
        location: inp.location,
        contact: inp.contact,
        name_field: inp.name_field,
        pdf_time: inp.pdf_time,
        cms_time,
        ts_time,
        ts_verified,
        time_used,
        time_source: time_source.into(),
        integrity_ok,
        digest_ok,
        crypto_ok,
        crypto_error,
        covers_whole,
        modified_after,
        unsafe_changes,
        rev_end,
        trusted: chain.trusted,
        trust_source: chain.source,
        chain_error: chain.error,
        chain_error_text: chain.error_text,
        chain: chain.chain.iter().filter_map(|d| cert_out(d, ctx.user)).collect(),
        algorithm,
        pades_level: u.and_then(|r| match r.pades_level {
            DetectedPadesLevel::BB => Some("B-B".into()),
            DetectedPadesLevel::BT => Some("B-T".into()),
            DetectedPadesLevel::BLT => Some("B-LT".into()),
            DetectedPadesLevel::BLTA => Some("B-LTA".into()),
            _ => None,
        }),
        issues,
        weak_hash,
        revocation: rv,
        revoked,
        docmdp,
        docmdp_violation,
        fallback,
    }
}

/// Đo thời gian một bước (chỉ in khi đặt DS_PDF_TIMING) — để tìm chỗ chậm khi kiểm chữ ký.
fn timed<T>(label: &str, f: impl FnOnce() -> T) -> T {
    if std::env::var_os("DS_PDF_TIMING").is_none() {
        return f();
    }
    let t = std::time::Instant::now();
    let r = f();
    eprintln!("[pdf ⏱] {label}: {} ms", t.elapsed().as_millis());
    r
}

fn verify_bytes(data: &[u8], user: &[Vec<u8>]) -> VerifyOut {
    use underskrift::verify::SignatureType;
    // Không có "/ByteRange" thì chắc chắn không có chữ ký → khỏi parse cả file (PDF lớn).
    if !data.windows(10).any(|w| w == b"/ByteRange") {
        return VerifyOut { signatures: Vec::new(), error: None };
    }
    // underskrift chỉ dùng để LẤY chữ ký (field, ByteRange, CMS, metadata) — KHÔNG gọi verify_pdf: nó đọc lại cả file và
    // chạy phân tích revision lần nữa (~1s ở bản dev), trong khi mật mã/dấu thời gian/chuỗi đều kiểm ở pdfsig + check_chain.
    let extracted = timed("extract", || underskrift::verify::extractor::extract_signatures(data));
    let ctx = DocCtx {
        data,
        user,
        info: timed("doc_info", || crate::pdfsig::doc_info(data)),
        revs: Default::default(),
        benign: Default::default(),
        now: chrono::Utc::now().timestamp(),
    };
    match extracted {
        Ok(list) if !list.is_empty() => {
            let sigs = list
                .iter()
                .map(|ex| {
                    let kind = match &ex.signature_type {
                        SignatureType::Pades => "pades",
                        SignatureType::Pkcs7Detached => "pkcs7",
                        SignatureType::Pkcs7Sha1 => "pkcs7sha1",
                        SignatureType::DocTimestamp => "timestamp",
                        SignatureType::Unknown(_) => "unknown",
                    };
                    timed("build_sig", || build_sig(&ctx, SigInput {
                        field: ex.field_name.clone(),
                        kind: kind.into(),
                        br: ex.byte_range,
                        cms: &ex.cms_bytes,
                        reason: ex.reason.clone(),
                        location: ex.location.clone(),
                        contact: ex.contact_info.clone(),
                        name_field: ex.signer_name.clone(),
                        pdf_time: ex.signing_time.as_deref().and_then(parse_pdf_date),
                        u: None,
                    }))
                })
                .collect();
            VerifyOut { signatures: sigs, error: None }
        }
        other => {
            // Không lấy được bằng underskrift (PDF mã hoá, xref hỏng…) hoặc không thấy → quét thô /ByteRange.
            let raw = crate::pdfsig::raw_scan(data);
            if raw.is_empty() {
                let err = other.err().map(|e| e.to_string()).filter(|m| !m.to_ascii_lowercase().contains("no signature"));
                return VerifyOut { signatures: Vec::new(), error: err };
            }
            let sigs = raw
                .iter()
                .enumerate()
                .map(|(i, r)| build_sig(&ctx, SigInput {
                    field: format!("Signature{}", i + 1),
                    kind: r.kind.clone(),
                    br: r.byte_range,
                    cms: &r.cms,
                    reason: None,
                    location: None,
                    contact: None,
                    name_field: None,
                    pdf_time: None,
                    u: None,
                }))
                .collect();
            VerifyOut { signatures: sigs, error: None }
        }
    }
}

/// Kiểm chữ ký của file trên đĩa: Rust tự đọc file — KHÔNG gửi cả file qua IPC (file 127 MB = thêm vài bản sao ở
/// WebView2 + Rust). UI dùng khi tab có đường dẫn; file kéo-thả (không đường dẫn) vẫn dùng `pdf_verify` với byte.
#[tauri::command]
pub async fn pdf_verify_path(path: String) -> Result<VerifyOut, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let data = std::fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
        Ok(std::panic::catch_unwind(|| verify_bytes(&data, &load_trusted())).unwrap_or_else(|_| VerifyOut {
            signatures: Vec::new(),
            error: Some("Không đọc được cấu trúc chữ ký của file này".into()),
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Kiểm mọi chữ ký trong PDF. Nhận byte thô của file (UI đã có sẵn, kể cả file kéo-thả không có đường dẫn).
#[tauri::command]
pub async fn pdf_verify(request: tauri::ipc::Request<'_>) -> Result<VerifyOut, String> {
    let data = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.clone(),
        _ => return Err("cần byte thô của file PDF".into()),
    };
    tauri::async_runtime::spawn_blocking(move || {
        // underskrift/lopdf có thể panic với PDF dị dạng → bắt lại, không làm sập lệnh.
        std::panic::catch_unwind(|| verify_bytes(&data, &load_trusted())).unwrap_or_else(|_| VerifyOut {
            signatures: Vec::new(),
            error: Some("Không đọc được cấu trúc chữ ký của file này".into()),
        })
    })
    .await
    .map_err(|e| e.to_string())
}

// ───────────────────────── app PDF mặc định (Windows) ─────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultStatus {
    /// Nền tảng hỗ trợ đăng ký từ trong app (hiện chỉ Windows).
    pub supported: bool,
    /// Đã đăng ký vào danh sách "Open with" của .pdf.
    pub registered: bool,
    /// Windows đang mở .pdf bằng chính file .exe này.
    pub is_default: bool,
    /// Đang chạy bản dev (npm run app:dev): đăng ký sẽ trỏ tới exe debug, chỉ mở được khi dev server còn chạy.
    pub dev: bool,
}

#[cfg(windows)]
mod winreg {
    use super::wide;
    use windows_sys::Win32::System::Registry::*;

    pub const PROGID: &str = "DevStation.PDF";
    /// Giá trị trong HKCU\Software\DevStation: "1" = người dùng đã bấm "Gỡ đăng ký" → không tự đăng ký lại.
    pub const OPT_OUT: &str = "PdfUnregistered";

    /// Ghi đăng ký "mở được PDF" (ProgId, Applications\<exe>, Capabilities + RegisteredApplications) — để DevStation có
    /// trong hộp thoại Open with và Settings → Default apps. KHÔNG đổi app mặc định (UserChoice do người dùng chọn).
    pub fn write_registration(exe: &str) -> Result<(), String> {
        let open = format!("\"{exe}\" \"%1\"");
        set(&format!("Software\\Classes\\{PROGID}"), None, "PDF Document")?;
        set(&format!("Software\\Classes\\{PROGID}"), Some("FriendlyTypeName"), "PDF Document")?;
        set(&format!("Software\\Classes\\{PROGID}\\DefaultIcon"), None, &format!("\"{exe}\",0"))?;
        set(&format!("Software\\Classes\\{PROGID}\\Application"), Some("ApplicationName"), "DevStation")?;
        set(&format!("Software\\Classes\\{PROGID}\\shell\\open\\command"), None, &open)?;
        set("Software\\Classes\\.pdf\\OpenWithProgids", Some(PROGID), "")?;
        let exe_name = std::path::Path::new(exe).file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "devstation.exe".into());
        set(&format!("Software\\Classes\\Applications\\{exe_name}"), Some("FriendlyAppName"), "DevStation")?;
        set(&format!("Software\\Classes\\Applications\\{exe_name}\\SupportedTypes"), Some(".pdf"), "")?;
        set(&format!("Software\\Classes\\Applications\\{exe_name}\\shell\\open\\command"), None, &open)?;
        set("Software\\DevStation\\Capabilities", Some("ApplicationName"), "DevStation")?;
        set("Software\\DevStation\\Capabilities", Some("ApplicationDescription"), "DevStation PDF viewer")?;
        set("Software\\DevStation\\Capabilities\\FileAssociations", Some(".pdf"), PROGID)?;
        set("Software\\RegisteredApplications", Some("DevStation"), "Software\\DevStation\\Capabilities")?;
        notify();
        Ok(())
    }

    /// Lúc khởi động (bản cài): đăng ký còn thiếu / trỏ exe khác (đổi thư mục cài, bị phần mềm khác xoá) → ghi lại.
    /// Bỏ qua nếu người dùng đã gỡ đăng ký. Đủ rồi thì không ghi gì (không gửi SHChangeNotify mỗi lần mở app).
    #[cfg_attr(debug_assertions, allow(dead_code))] // chỉ gọi ở bản cài
    pub fn ensure_registered(exe: &str) {
        if get("Software\\DevStation", Some(OPT_OUT)).as_deref() == Some("1") {
            return;
        }
        let want = format!("\"{exe}\" \"%1\"");
        let ok = get(&format!("Software\\Classes\\{PROGID}\\shell\\open\\command"), None).is_some_and(|c| c.eq_ignore_ascii_case(&want))
            && get("Software\\RegisteredApplications", Some("DevStation")).is_some()
            && get("Software\\DevStation\\Capabilities\\FileAssociations", Some(".pdf")).is_some();
        if !ok {
            let _ = write_registration(exe);
        }
    }

    pub fn set(path: &str, name: Option<&str>, value: &str) -> Result<(), String> {
        unsafe {
            let mut key: HKEY = std::ptr::null_mut();
            let p = wide(path);
            let r = RegCreateKeyExW(HKEY_CURRENT_USER, p.as_ptr(), 0, std::ptr::null(), REG_OPTION_NON_VOLATILE, KEY_WRITE, std::ptr::null(), &mut key, std::ptr::null_mut());
            if r != 0 {
                return Err(format!("HKCU\\{path}: lỗi {r}"));
            }
            let v = wide(value);
            let n = name.map(wide);
            let r = RegSetValueExW(key, n.as_ref().map_or(std::ptr::null(), |n| n.as_ptr()), 0, REG_SZ, v.as_ptr() as *const u8, (v.len() * 2) as u32);
            RegCloseKey(key);
            if r != 0 {
                return Err(format!("HKCU\\{path}: lỗi {r}"));
            }
        }
        Ok(())
    }

    pub fn get(path: &str, name: Option<&str>) -> Option<String> {
        unsafe {
            let p = wide(path);
            let n = name.map(wide);
            let mut buf = vec![0u16; 1024];
            let mut len = (buf.len() * 2) as u32;
            let r = RegGetValueW(HKEY_CURRENT_USER, p.as_ptr(), n.as_ref().map_or(std::ptr::null(), |n| n.as_ptr()), RRF_RT_REG_SZ, std::ptr::null_mut(), buf.as_mut_ptr() as *mut _, &mut len);
            if r != 0 {
                return None;
            }
            let chars = (len as usize / 2).saturating_sub(1);
            Some(String::from_utf16_lossy(&buf[..chars]))
        }
    }

    pub fn del_tree(path: &str) {
        let p = wide(path);
        // RegDeleteTreeW chỉ xoá khoá con + giá trị; khoá chính xoá bằng RegDeleteKeyW.
        unsafe {
            RegDeleteTreeW(HKEY_CURRENT_USER, p.as_ptr());
            RegDeleteKeyW(HKEY_CURRENT_USER, p.as_ptr());
        }
    }

    pub fn del_value(path: &str, name: &str) {
        let p = wide(path);
        let n = wide(name);
        unsafe {
            RegDeleteKeyValueW(HKEY_CURRENT_USER, p.as_ptr(), n.as_ptr());
        }
    }

    pub fn notify() {
        unsafe {
            windows_sys::Win32::UI::Shell::SHChangeNotify(windows_sys::Win32::UI::Shell::SHCNE_ASSOCCHANGED as i32, windows_sys::Win32::UI::Shell::SHCNF_IDLIST, std::ptr::null(), std::ptr::null());
        }
    }

    /// File .exe Windows đang dùng để mở .pdf.
    pub fn default_exe() -> Option<String> {
        use windows_sys::Win32::UI::Shell::{AssocQueryStringW, ASSOCF_NONE, ASSOCSTR_EXECUTABLE};
        let ext = wide(".pdf");
        let verb = wide("open");
        let mut buf = vec![0u16; 1024];
        let mut len = buf.len() as u32;
        let hr = unsafe { AssocQueryStringW(ASSOCF_NONE, ASSOCSTR_EXECUTABLE, ext.as_ptr(), verb.as_ptr(), buf.as_mut_ptr(), &mut len) };
        if hr != 0 {
            return None;
        }
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..end]))
    }
}

#[cfg(windows)]
fn exe_path() -> Result<String, String> {
    std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pdf_default_status() -> DefaultStatus {
    #[cfg(windows)]
    {
        let exe = exe_path().unwrap_or_default();
        let registered = winreg::get(&format!("Software\\Classes\\{}\\shell\\open\\command", winreg::PROGID), None)
            .map(|c| c.to_ascii_lowercase().contains(&exe.to_ascii_lowercase()))
            .unwrap_or(false);
        let is_default = winreg::default_exe().map(|d| d.eq_ignore_ascii_case(&exe)).unwrap_or(false);
        DefaultStatus { supported: true, registered, is_default, dev: cfg!(debug_assertions) }
    }
    #[cfg(not(windows))]
    DefaultStatus { supported: false, registered: false, is_default: false, dev: cfg!(debug_assertions) }
}

/// "Đặt làm app PDF mặc định": ghi đăng ký (HKCU) rồi mở hộp thoại "How do you want to open .pdf files?" của Windows
/// bằng **`OpenWith.exe`** (tiến trình của Windows) và chờ nó đóng → trả trạng thái sau đó.
/// KHÔNG dùng `SHOpenWithDialog` trong tiến trình app nữa: driver **UCPD** (Windows 10 22H2+/11) chỉ cho tiến trình
/// của Microsoft (OpenWith.exe, Settings…) ghi app mặc định cho `.pdf` → chọn DevStation + "Always" trong hộp thoại
/// chạy trong devstation.exe bị chặn âm thầm (Windows không lưu). Windows 8+ cũng không cho app tự ghi (UserChoice
/// có hash) — người dùng phải chọn; UI mở Settings → Default apps nếu đóng hộp thoại mà vẫn chưa là mặc định.
#[tauri::command]
pub async fn pdf_register_default(file: Option<String>) -> Result<DefaultStatus, String> {
    #[cfg(windows)]
    {
        use winreg::*;
        let exe = exe_path()?;
        write_registration(&exe)?;
        del_value("Software\\DevStation", OPT_OUT); // chủ động đăng ký lại → bỏ dấu "đã gỡ"

        // Hộp thoại cần một tên file .pdf: dùng file đang mở, không có thì một file tạm (chỉ để chọn app, không mở).
        let target = match file.filter(|f| std::path::Path::new(f).is_file()) {
            Some(f) => f,
            None => {
                let p = std::env::temp_dir().join("DevStation.pdf");
                if !p.is_file() {
                    std::fs::write(&p, b"%PDF-1.4\n%%EOF\n").map_err(|e| e.to_string())?;
                }
                p.to_string_lossy().into_owned()
            }
        };
        let openwith = std::env::var_os("SystemRoot")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| "C:\\Windows".into())
            .join("System32")
            .join("OpenWith.exe");
        tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            let mut child = std::process::Command::new(&openwith)
                .arg(&target)
                .spawn()
                .map_err(|e| format!("Không mở được hộp thoại chọn app của Windows ({e})"))?;
            // Chờ người dùng chọn xong (tối đa 10 phút); hộp thoại tự đóng khi mất focus thì cũng về đây.
            let t0 = std::time::Instant::now();
            while t0.elapsed() < std::time::Duration::from_secs(600) {
                if let Ok(Some(_)) = child.try_wait() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(250));
            }
            // Windows ghi lựa chọn ngay khi bấm OK, nhưng đọc lại có thể trễ một chút.
            std::thread::sleep(std::time::Duration::from_millis(600));
            Ok(())
        })
        .await
        .map_err(|e| e.to_string())??;
        Ok(pdf_default_status())
    }
    #[cfg(not(windows))]
    {
        let _ = file;
        Err("Chỉ hỗ trợ trên Windows".into())
    }
}

/// Mở trang Default apps của Windows (Windows 11 nhảy thẳng tới mục DevStation).
#[tauri::command]
pub fn pdf_open_settings() -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        let op = wide("open");
        let u = wide("ms-settings:defaultapps?registeredAppUser=DevStation");
        let r = unsafe { ShellExecuteW(std::ptr::null_mut(), op.as_ptr(), u.as_ptr(), std::ptr::null(), std::ptr::null(), 1) };
        if (r as isize) <= 32 {
            return Err("Không mở được Settings".into());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    Err("Chỉ hỗ trợ trên Windows".into())
}

/// Gỡ đăng ký (xoá các khoá HKCU đã ghi).
#[tauri::command]
pub fn pdf_unregister_default() -> Result<(), String> {
    #[cfg(windows)]
    {
        use winreg::*;
        let exe = exe_path()?;
        let exe_name = std::path::Path::new(&exe).file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "devstation.exe".into());
        del_tree(&format!("Software\\Classes\\{PROGID}"));
        del_value("Software\\Classes\\.pdf\\OpenWithProgids", PROGID);
        del_tree(&format!("Software\\Classes\\Applications\\{exe_name}"));
        del_tree("Software\\DevStation\\Capabilities");
        del_value("Software\\RegisteredApplications", "DevStation");
        // Nhớ là người dùng đã gỡ → lúc khởi động không tự đăng ký lại (`ensure_registered`).
        let _ = set("Software\\DevStation", Some(OPT_OUT), "1");
        notify();
        Ok(())
    }
    #[cfg(not(windows))]
    Err("Chỉ hỗ trợ trên Windows".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pdf_date() {
        assert_eq!(parse_pdf_date("D:20240115103000+07'00'"), Some(1705289400));
        assert_eq!(parse_pdf_date("D:20240115033000Z"), Some(1705289400));
        assert_eq!(parse_pdf_date("D:2024"), Some(1704067200));
        assert_eq!(parse_pdf_date("rác"), None);
    }

    #[test]
    fn args_filter() {
        let d = std::env::temp_dir().join("ds-pdf-args-test");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("a.PDF"), b"%PDF").unwrap();
        let got = pdf_args(vec!["a.PDF".into(), "--flag".into(), "x.pdf".into(), "b.txt".into()], Some(&d));
        assert_eq!(got.len(), 1);
        assert!(got[0].ends_with("a.PDF"));
    }

    /// Kiểm một PDF thật: DS_TEST_PDF=<đường dẫn> cargo test pdf::tests::real_pdf -- --nocapture
    #[test]
    fn real_pdf() {
        let Ok(p) = std::env::var("DS_TEST_PDF") else { return };
        let data = std::fs::read(p).unwrap();
        let out = verify_bytes(&data, &load_trusted());
        println!("{}", serde_json::to_string_pretty(&out).unwrap());
        // DS_TEST_TRUST_TOP=1: mô phỏng người dùng bấm Trust chứng thư TRÊN CÙNG của chuỗi rồi kiểm lại (không ghi file Trust thật).
        if std::env::var("DS_TEST_TRUST_TOP").is_ok() {
            for s in &out.signatures {
                let Some(top) = s.chain.last() else { continue };
                let der = B64.decode(&top.der).unwrap();
                let again = verify_bytes(&data, &[der]);
                let a = again.signatures.iter().find(|x| x.field == s.field).unwrap();
                println!("TRUST-TOP {} → trust \"{}\" → status={} source={:?} chain={}", s.field, top.name, a.status, a.trust_source, a.chain.iter().map(|c| c.name.clone()).collect::<Vec<_>>().join(" > "));
            }
        }
    }

    /// PDF tối giản 1 trang (xref tính đúng offset) để ký thử.
    fn minimal_pdf() -> Vec<u8> {
        let objs = [
            "<< /Type /Catalog /Pages 2 0 R >>",
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
            "<< /Length 44 >>\nstream\nBT /F1 24 Tf 72 760 Td (Hello DevStation) Tj ET\nendstream",
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        ];
        let mut out = b"%PDF-1.7\n%\xE2\xE3\xCF\xD3\n".to_vec();
        let mut offs = Vec::new();
        for (i, o) in objs.iter().enumerate() {
            offs.push(out.len());
            out.extend(format!("{} 0 obj\n{}\nendobj\n", i + 1, o).as_bytes());
        }
        let xref = out.len();
        out.extend(format!("xref\n0 {}\n0000000000 65535 f \n", objs.len() + 1).as_bytes());
        for o in offs {
            out.extend(format!("{o:010} 00000 n \n").as_bytes());
        }
        out.extend(format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objs.len() + 1).as_bytes());
        out
    }

    /// Ký thử rồi kiểm (cần bộ chứng thư test sinh bằng openssl):
    /// DS_TEST_PDFSIG=<thư mục có signer.p12 (mật khẩu "test") + root.der> cargo test pdf::tests::sign_verify -- --nocapture
    #[test]
    fn sign_verify() {
        let Ok(dir) = std::env::var("DS_TEST_PDFSIG") else { return };
        let dir = std::path::PathBuf::from(dir);
        let signer = underskrift::SoftwareSigner::from_pkcs12_file(dir.join("signer.p12"), "test").unwrap();
        let root = std::fs::read(dir.join("root.der")).unwrap();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        for sub in [underskrift::SubFilter::Pkcs7, underskrift::SubFilter::Pades] {
            let opts = underskrift::SigningOptions {
                sub_filter: sub.clone(),
                field_name: "Signature1".into(),
                reason: Some("Phê duyệt".into()),
                location: Some("Hà Nội".into()),
                cms_signing_time: Some(chrono::Utc::now().naive_utc() - chrono::Duration::seconds(5)),
                ..Default::default()
            };
            let signed = rt.block_on(underskrift::PdfSigner::new().options(opts).sign(&minimal_pdf(), &signer)).unwrap();
            std::fs::write(dir.join(format!("signed-{sub:?}.pdf")), &signed).unwrap();

            // 1) Chưa tin gốc test → chữ ký đúng nhưng "unknown" (gốc không tin cậy).
            let out = verify_bytes(&signed, &[]);
            assert_eq!(out.signatures.len(), 1, "{:?}", out.error);
            let s = &out.signatures[0];
            println!("{sub:?}: status={} chain_error={:?} kind={} signer={:?} alg={:?} time={} ({})", s.status, s.chain_error, s.kind, s.signer, s.algorithm, s.time_used, s.time_source);
            assert!(s.integrity_ok && s.crypto_ok && s.digest_ok);
            // PAdES của underskrift không ghi giờ nào (cả /M) → app dùng giờ hiện tại; file thật (VNPT, Viettel…) có /M.
            assert_eq!(s.time_source, if matches!(sub, underskrift::SubFilter::Pkcs7) { "signer" } else { "now" });
            assert_eq!(s.status, "unknown");
            assert_eq!(s.chain_error.as_deref(), Some("untrustedRoot"));
            // Chưa tin cậy vẫn hiện đủ chuỗi nhúng trong chữ ký (người ký + Sub CA), Trust CA trên cùng → hợp lệ.
            assert_eq!(s.chain.len(), 2, "chuỗi hiển thị khi chưa tin cậy");
            let top = B64.decode(&s.chain[1].der).unwrap();
            assert_eq!(verify_bytes(&signed, &[top]).signatures[0].status, "valid");
            assert_eq!(s.signer.as_deref(), Some("Nguyễn Văn A"));
            assert_eq!(s.reason.as_deref(), Some("Phê duyệt"));
            assert!(!s.modified_after);
            assert_eq!(s.rev_end, signed.len());

            // 2) Trust gốc → hợp lệ, chuỗi đủ 3 cấp.
            let out = verify_bytes(&signed, &[root.clone()]);
            let s = &out.signatures[0];
            assert_eq!(s.status, "valid", "{:?}", s.chain_error_text);
            assert_eq!(s.trust_source.as_deref(), Some("app"));
            assert_eq!(s.chain.len(), 3);
            assert!(s.chain[2].self_signed && s.chain[2].user_trusted);

            // 3) Trust thẳng chứng thư người ký → hợp lệ.
            let leaf = B64.decode(&s.chain[0].der).unwrap();
            assert_eq!(verify_bytes(&signed, &[leaf]).signatures[0].status, "valid");

            // 4) Sửa một byte trong vùng được ký → không hợp lệ.
            let mut bad = signed.clone();
            let pos = bad.windows(16).position(|w| w == b"Hello DevStation").unwrap();
            bad[pos] = b'J';
            assert_eq!(verify_bytes(&bad, &[root.clone()]).signatures[0].status, "invalid");

            // 5) Thêm bản cập nhật sau khi ký → chữ ký vẫn đúng nhưng báo có thay đổi.
            let mut upd = signed.clone();
            let n = upd.len();
            // Bản cập nhật tăng dần hợp lệ: trỏ /Prev về xref cũ, giữ /Root của bản đã ký.
            let txt = String::from_utf8_lossy(&signed).into_owned();
            let prev: usize = txt.rsplit("startxref").next().unwrap().trim().trim_end_matches("%%EOF").trim().parse().unwrap();
            let root_ref = txt.rsplit("/Root").next().unwrap().split('R').next().unwrap().trim().to_string();
            let body = "90 0 obj\n<< /Foo 1 >>\nendobj\n";
            let xref_at = n + body.len();
            upd.extend(format!("{body}xref\n90 1\n{n:010} 00000 n \ntrailer\n<< /Size 91 /Root {root_ref} R /Prev {prev} >>\nstartxref\n{xref_at}\n%%EOF\n").as_bytes());
            let s = &verify_bytes(&upd, &[root.clone()]).signatures;
            assert_eq!(s.len(), 1, "PDF có bản cập nhật vẫn phải đọc được chữ ký");
            let s = &s[0];
            println!("  sau khi thêm cập nhật: status={} modified_after={} covers_whole={} unsafe={:?}", s.status, s.modified_after, s.covers_whole, s.unsafe_changes);
            assert!(s.modified_after && !s.covers_whole);
            assert_eq!(s.rev_end, signed.len());

            // 6) Bản cập nhật THAY nội dung trang (object 4) → chữ ký vẫn đúng toán học nhưng phải báo có sửa nội dung.
            let mut upd = signed.clone();
            let stream = "BT /F1 24 Tf 72 760 Td (Sua sau khi ky) Tj ET";
            let body = format!("4 0 obj\n<< /Length {} >>\nstream\n{stream}\nendstream\nendobj\n", stream.len());
            let xref_at = n + body.len();
            upd.extend(format!("{body}xref\n4 1\n{n:010} 00000 n \ntrailer\n<< /Size 91 /Root {root_ref} R /Prev {prev} >>\nstartxref\n{xref_at}\n%%EOF\n").as_bytes());
            let s = &verify_bytes(&upd, &[root.clone()]).signatures[0];
            println!("  sau khi sửa trang: status={} modified_after={} unsafe={:?}", s.status, s.modified_after, s.unsafe_changes);
            assert!(s.modified_after);
            assert_eq!(s.unsafe_changes, Some(true));
        }
    }

    /// Chạy bộ file mẫu của skill kiểm thử (đáp án chuẩn do pyHanko tính, so ở ngoài):
    /// DS_PDF_FIXTURES=<thư mục fixtures có pki/root.der> cargo test pdf::tests::fixture_suite -- --nocapture
    /// → ghi <fixtures>/app-ket-qua.json (kết quả kiểm của app cho từng file, Trust = root.der như người dùng bấm Trust gốc).
    #[test]
    fn fixture_suite() {
        let Ok(dir) = std::env::var("DS_PDF_FIXTURES") else { return };
        let dir = std::path::PathBuf::from(dir);
        let root = std::fs::read(dir.join("pki").join("root.der")).unwrap();
        let mut names: Vec<_> = std::fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.ends_with(".pdf")).collect();
        names.sort();
        let mut all = serde_json::Map::new();
        for n in names {
            let data = std::fs::read(dir.join(&n)).unwrap();
            let t = std::time::Instant::now();
            let out = std::panic::catch_unwind(|| verify_bytes(&data, &[root.clone()]))
                .unwrap_or_else(|_| VerifyOut { signatures: Vec::new(), error: Some("PANIC".into()) });
            let mut v = serde_json::to_value(&out).unwrap();
            v["ms"] = serde_json::json!(t.elapsed().as_millis() as u64);
            println!("{n}: {} chữ ký, lỗi={:?}, {}ms", out.signatures.len(), out.error, t.elapsed().as_millis());
            all.insert(n, v);
        }
        std::fs::write(dir.join("app-ket-qua.json"), serde_json::to_string_pretty(&all).unwrap()).unwrap();
    }
}
