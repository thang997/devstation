//! App SSH: chạy `ssh.exe` của hệ thống trong một ConPTY (terminal thật) và tạo tunnel bằng
//! `ssh -N -L/-R/-D`. Giống triết lý app Git (gọi thẳng git.exe): dùng lại key, known_hosts,
//! ssh-agent và file config của máy — không tự cài đặt một SSH stack riêng.

use std::collections::HashMap;
use std::io::{BufRead, Read, Write};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Deserialize;
use tauri::{AppHandle, Emitter, State};

#[cfg(windows)]
pub(crate) const CREATE_NO_WINDOW: u32 = 0x0800_0000;

static SEQ: AtomicU64 = AtomicU64::new(1);
fn next_id() -> u64 {
    SEQ.fetch_add(1, Ordering::Relaxed)
}

/// Id phiên dùng chung (terminal + sftp) để không trùng nhau.
pub(crate) fn next_session_id(prefix: &str) -> String {
    format!("{prefix}{}", next_id())
}

pub(crate) type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;

/// Một phiên terminal: master PTY (đổi kích thước), writer (gõ phím), child (ssh.exe),
/// và máy trạng thái mật khẩu (tự điền mật khẩu đã lưu / học mật khẩu khi đăng nhập đúng — kiểu MobaXterm).
struct Term {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: SharedWriter,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    pw: Arc<Mutex<PwState>>,
    /// Theo dõi dòng lệnh đang gõ để phát hiện `cd` (panel SFTP đi theo).
    cmdline: Mutex<CmdLine>,
}

/// Dò dòng lệnh người dùng gõ để bắt `cd <path>`. `bad` = dòng không đáng tin
/// (có escape/arrow/history/tab-completion) → bỏ qua để không nhảy nhầm thư mục.
#[derive(Default)]
struct CmdLine {
    buf: Vec<u8>,
    bad: bool,
}

const KEYRING_SERVICE: &str = "DevStation SSH";

/// Máy trạng thái tự điền/học mật khẩu SSH cho một phiên.
/// Cửa sổ "auth" mở từ lúc kết nối tới khi đăng nhập xong (`authed`); ngoài cửa sổ này thì kệ (vd. sudo).
#[derive(Default)]
pub(crate) struct PwState {
    /// Khoá keyring: user@host:port.
    key: String,
    /// Mật khẩu đã lưu (nếu có) để tự điền.
    saved: Option<String>,
    /// Đã tự điền mật khẩu cho lần hỏi hiện tại chưa (tránh điền lặp).
    injected: bool,
    /// Lần điền gần nhất là mật khẩu ĐÃ LƯU (để xoá khỏi keyring nếu sai).
    injected_saved: bool,
    /// Đang ghi lại mật khẩu người dùng tự gõ.
    capturing: bool,
    /// Vừa gửi mật khẩu, đang chờ xem server chấp nhận hay không.
    awaiting_result: bool,
    /// Đã qua bước xác thực → ngừng mọi xử lý mật khẩu.
    authed: bool,
    /// Bộ đệm mật khẩu đang gõ (bytes, giải mã UTF-8 lúc chốt).
    buffer: Vec<u8>,
    /// Mật khẩu vừa nhập/điền, chờ xác nhận đúng rồi mới lưu.
    candidate: Option<String>,
}

impl PwState {
    /// Tạo state cho một phiên với mật khẩu đã lưu (nếu có) để tự điền.
    pub(crate) fn new(key: String, saved: Option<String>) -> Self {
        PwState { saved, key, ..Default::default() }
    }
    /// Đang ở dấu nhắc mật khẩu nhưng KHÔNG có mật khẩu lưu để tự điền
    /// (panel SFTP không có nơi gõ → coi là bế tắc, báo lỗi rõ).
    pub(crate) fn stuck_without_password(&self) -> bool {
        self.capturing && self.saved.is_none()
    }
}

fn keyring_entry(key: &str) -> Option<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, key).ok()
}
pub(crate) fn keyring_get(key: &str) -> Option<String> {
    keyring_entry(key).and_then(|e| e.get_password().ok())
}
fn keyring_set(key: &str, pw: &str) {
    if let Some(e) = keyring_entry(key) {
        let _ = e.set_password(pw);
    }
}
fn keyring_delete(key: &str) {
    if let Some(e) = keyring_entry(key) {
        let _ = e.delete_credential();
    }
}

/// Đường dẫn private key dùng được với `ssh -i`. Lỗi → thông báo rõ để hiện lên terminal.
///
/// Xử lý hai thứ OpenSSH trên Windows hay vướng mà MobaXterm thì không:
/// 1. Quyền NTFS "quá mở" (user/nhóm khác đọc được) → "bad permissions ... key will be ignored".
/// 2. Key định dạng PuTTY (.ppk) → "invalid format" (ssh.exe chỉ đọc key OpenSSH).
/// Ta chép/convert key sang thư mục riêng của app rồi siết quyền chỉ cho user hiện tại
/// (không đụng file gốc, nhất là khi gốc nằm trên OneDrive), và dùng bản sao đó.
pub(crate) fn prepared_key(key_path: &str) -> Result<String, String> {
    #[cfg(windows)]
    {
        sanitize_key_windows(key_path)
    }
    #[cfg(not(windows))]
    {
        prepare_key_unix(key_path)
    }
}

/// Linux/macOS: OpenSSH đọc trực tiếp key OpenSSH có quyền 600. Chỉ cần đổi định dạng khi key là
/// PuTTY `.ppk` → convert sang OpenSSH và ghi bản sao quyền 0600 (không đụng file gốc).
#[cfg(not(windows))]
fn prepare_key_unix(src: &str) -> Result<String, String> {
    use std::io::Read;
    let p = std::path::Path::new(src);
    if !p.is_file() {
        return Ok(src.to_string()); // để ssh tự báo lỗi
    }
    let mut head = String::new();
    if std::fs::File::open(p)
        .and_then(|mut f| f.take(64).read_to_string(&mut head))
        .is_err()
        || !head.starts_with("PuTTY-User-Key-File")
    {
        return Ok(src.to_string());
    }
    let text = std::fs::read_to_string(p).map_err(|e| format!("Không đọc được {src}: {e}"))?;
    let openssh = convert_ppk_to_openssh(&text)?;
    let dir = std::env::temp_dir().join("devstation-keys");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join(format!("{}.key", blake_like_hash(src)));
    std::fs::write(&dest, openssh).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o600));
    }
    Ok(dest.to_string_lossy().to_string())
}

/// Băm ổn định theo đường dẫn nguồn (để mỗi key một tên file cố định).
#[cfg(not(windows))]
fn blake_like_hash(s: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    format!("{:016x}", h.finish())
}

#[cfg(windows)]
fn sanitize_key_windows(src: &str) -> Result<String, String> {
    use std::hash::{Hash, Hasher};
    use std::os::windows::process::CommandExt;
    use std::path::PathBuf;

    let src_path = std::path::Path::new(src);
    if !src_path.is_file() {
        return Ok(src.to_string()); // đường dẫn sai → để ssh tự báo
    }
    let dir = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("DevStation")
        .join("keys");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    // Tên bản sao ổn định theo đường dẫn gốc (ghi đè mỗi lần để luôn khớp nội dung mới nhất).
    let mut h = std::collections::hash_map::DefaultHasher::new();
    src.hash(&mut h);
    let dest = dir.join(format!("{:016x}.key", h.finish()));
    let dest_str = dest.to_string_lossy().into_owned();

    // Nhận diện key PuTTY (.ppk): dòng đầu "PuTTY-User-Key-File-...".
    let is_ppk = std::fs::read_to_string(src_path)
        .ok()
        .map(|t| t.trim_start().starts_with("PuTTY-User-Key-File"))
        .unwrap_or(false);

    if is_ppk {
        let text = std::fs::read_to_string(src_path).map_err(|e| e.to_string())?;
        // Ưu tiên tự convert bằng Rust (chạy trên MỌI máy Windows, không cần cài PuTTY).
        match convert_ppk_to_openssh(&text) {
            Ok(pem) => std::fs::write(&dest, pem).map_err(|e| e.to_string())?,
            Err(conv_err) => {
                // Ca khó (key có passphrase, kiểu lạ): thử puttygen nếu máy có cài.
                if let Some(pg) = find_puttygen() {
                    let out = std::process::Command::new(pg)
                        .args([src, "-O", "private-openssh", "-o", dest_str.as_str()])
                        .creation_flags(CREATE_NO_WINDOW)
                        .output()
                        .map_err(|e| format!("Không chạy được puttygen: {e}"))?;
                    if !out.status.success() {
                        return Err(format!(
                            "Không chuyển được key PuTTY (.ppk): {conv_err}\n{}",
                            String::from_utf8_lossy(&out.stderr).trim()
                        ));
                    }
                } else {
                    return Err(format!(
                        "Key PuTTY (.ppk) {conv_err} Nếu key có passphrase, hãy mở PuTTYgen nhập passphrase \
                         rồi Export OpenSSH key, và trỏ host tới file đó."
                    ));
                }
            }
        }
    } else {
        std::fs::copy(src_path, &dest).map_err(|e| e.to_string())?;
    }

    // Bỏ mọi quyền thừa kế rồi chỉ cấp cho user hiện tại (OpenSSH yêu cầu không ai khác đọc được).
    let _ = std::process::Command::new("icacls")
        .args([dest_str.as_str(), "/inheritance:r"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    if let Ok(user) = std::env::var("USERNAME") {
        if !user.is_empty() {
            let _ = std::process::Command::new("icacls")
                .args([dest_str.as_str(), "/grant:r", &format!("{user}:F")])
                .creation_flags(CREATE_NO_WINDOW)
                .output();
        }
    }
    Ok(dest_str)
}

/// Tìm puttygen.exe: thư mục cài PuTTY phổ biến trước, rồi PATH (qua `where`, không mở GUI).
#[cfg(windows)]
fn find_puttygen() -> Option<String> {
    use std::os::windows::process::CommandExt;
    for c in [
        r"C:\Program Files\PuTTY\puttygen.exe",
        r"C:\Program Files (x86)\PuTTY\puttygen.exe",
    ] {
        if std::path::Path::new(c).is_file() {
            return Some(c.to_string());
        }
    }
    let out = std::process::Command::new("where")
        .arg("puttygen")
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    if out.status.success() {
        let p = String::from_utf8_lossy(&out.stdout).lines().next()?.trim().to_string();
        if !p.is_empty() {
            return Some(p);
        }
    }
    None
}

/* ── Convert key PuTTY (.ppk) → OpenSSH, thuần Rust (không cần PuTTY) ──
   Chỉ xử lý key KHÔNG đặt passphrase (Encryption: none) — đủ cho đa số trường hợp; key mã hoá thì rơi về puttygen.
   Cách làm: đọc public/private blob (định dạng wire SSH, mpint = string) rồi ghép lại thành
   file "openssh-key-v1" chuẩn. Vì mpint của PuTTY và OpenSSH cùng quy cách nên chỉ cần sao chép nguyên các "string". */

fn ssh_read<'a>(b: &mut &'a [u8]) -> Option<&'a [u8]> {
    if b.len() < 4 {
        return None;
    }
    let n = u32::from_be_bytes([b[0], b[1], b[2], b[3]]) as usize;
    if b.len() < 4 + n {
        return None;
    }
    let s = &b[4..4 + n];
    *b = &b[4 + n..];
    Some(s)
}
fn ssh_write(out: &mut Vec<u8>, s: &[u8]) {
    out.extend_from_slice(&(s.len() as u32).to_be_bytes());
    out.extend_from_slice(s);
}

fn convert_ppk_to_openssh(text: &str) -> Result<String, String> {
    use base64::engine::general_purpose::STANDARD;
    let lines: Vec<&str> = text.lines().collect();
    let mut algo = String::new();
    let mut enc = String::new();
    let mut comment = String::new();
    let (mut pub_b64, mut priv_b64) = (String::new(), String::new());

    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if let Some(v) = line.strip_prefix("PuTTY-User-Key-File-") {
            // "2: ssh-ed25519" → lấy phần sau ": "
            algo = v.splitn(2, ": ").nth(1).unwrap_or("").trim().to_string();
        } else if let Some(v) = line.strip_prefix("Encryption: ") {
            enc = v.trim().to_string();
        } else if let Some(v) = line.strip_prefix("Comment: ") {
            comment = v.trim().to_string();
        } else if let Some(v) = line.strip_prefix("Public-Lines: ") {
            let n: usize = v.trim().parse().map_err(|_| "Public-Lines sai".to_string())?;
            for l in lines.iter().skip(i + 1).take(n) {
                pub_b64.push_str(l.trim());
            }
            i += n;
        } else if let Some(v) = line.strip_prefix("Private-Lines: ") {
            let n: usize = v.trim().parse().map_err(|_| "Private-Lines sai".to_string())?;
            for l in lines.iter().skip(i + 1).take(n) {
                priv_b64.push_str(l.trim());
            }
            i += n;
        }
        i += 1;
    }

    if enc != "none" {
        return Err("có đặt passphrase (không tự giải mã được).".to_string());
    }
    let pub_blob = STANDARD.decode(pub_b64.trim()).map_err(|_| "public blob hỏng".to_string())?;
    let priv_blob = STANDARD.decode(priv_b64.trim()).map_err(|_| "private blob hỏng".to_string())?;

    // Dựng phần "private key" theo đúng thứ tự field của OpenSSH cho từng loại key.
    let mut priv_fields = Vec::new();
    let mut pr = pub_blob.as_slice();
    let mut sr = priv_blob.as_slice();
    let bad = || "cấu trúc key không đọc được".to_string();

    if algo == "ssh-ed25519" {
        let _kt = ssh_read(&mut pr).ok_or_else(bad)?; // "ssh-ed25519"
        let a = ssh_read(&mut pr).ok_or_else(bad)?; // public A (32)
        let seed = ssh_read(&mut sr).ok_or_else(bad)?; // private seed (32)
        let mut secret = Vec::with_capacity(seed.len() + a.len());
        secret.extend_from_slice(seed);
        secret.extend_from_slice(a);
        ssh_write(&mut priv_fields, b"ssh-ed25519");
        ssh_write(&mut priv_fields, a);
        ssh_write(&mut priv_fields, &secret);
    } else if algo.starts_with("ecdsa-sha2-") {
        let _kt = ssh_read(&mut pr).ok_or_else(bad)?;
        let curve = ssh_read(&mut pr).ok_or_else(bad)?;
        let q = ssh_read(&mut pr).ok_or_else(bad)?;
        let d = ssh_read(&mut sr).ok_or_else(bad)?;
        ssh_write(&mut priv_fields, algo.as_bytes());
        ssh_write(&mut priv_fields, curve);
        ssh_write(&mut priv_fields, q);
        ssh_write(&mut priv_fields, d);
    } else if algo == "ssh-rsa" {
        let _kt = ssh_read(&mut pr).ok_or_else(bad)?;
        let e = ssh_read(&mut pr).ok_or_else(bad)?;
        let n = ssh_read(&mut pr).ok_or_else(bad)?;
        // PuTTY private blob: d, p, q, iqmp
        let d = ssh_read(&mut sr).ok_or_else(bad)?;
        let p = ssh_read(&mut sr).ok_or_else(bad)?;
        let q = ssh_read(&mut sr).ok_or_else(bad)?;
        let iqmp = ssh_read(&mut sr).ok_or_else(bad)?;
        ssh_write(&mut priv_fields, b"ssh-rsa");
        ssh_write(&mut priv_fields, n);
        ssh_write(&mut priv_fields, e);
        ssh_write(&mut priv_fields, d);
        ssh_write(&mut priv_fields, iqmp);
        ssh_write(&mut priv_fields, p);
        ssh_write(&mut priv_fields, q);
    } else {
        return Err(format!("kiểu key '{algo}' chưa hỗ trợ."));
    }

    // Phần private (chưa mã hoá): checkint×2 + private fields + comment + padding 1,2,3…
    let mut sect = Vec::new();
    sect.extend_from_slice(&0xA5A5_A5A5u32.to_be_bytes());
    sect.extend_from_slice(&0xA5A5_A5A5u32.to_be_bytes());
    sect.extend_from_slice(&priv_fields);
    ssh_write(&mut sect, comment.as_bytes());
    let mut pad = 1u8;
    while sect.len() % 8 != 0 {
        sect.push(pad);
        pad = pad.wrapping_add(1);
    }

    // Khung openssh-key-v1.
    let mut blob = Vec::new();
    blob.extend_from_slice(b"openssh-key-v1\0");
    ssh_write(&mut blob, b"none"); // cipher
    ssh_write(&mut blob, b"none"); // kdf
    ssh_write(&mut blob, b""); // kdfoptions
    blob.extend_from_slice(&1u32.to_be_bytes()); // số key
    ssh_write(&mut blob, &pub_blob); // public key
    ssh_write(&mut blob, &sect); // private (unencrypted)

    // Bọc PEM "OPENSSH PRIVATE KEY", xuống dòng mỗi 70 ký tự (giống ssh-keygen).
    let b64 = STANDARD.encode(&blob);
    let mut pem = String::from("-----BEGIN OPENSSH PRIVATE KEY-----\n");
    for chunk in b64.as_bytes().chunks(70) {
        pem.push_str(std::str::from_utf8(chunk).unwrap());
        pem.push('\n');
    }
    pem.push_str("-----END OPENSSH PRIVATE KEY-----\n");
    Ok(pem)
}

/// Đoạn output có đang là dấu nhắc nhập mật khẩu không ("...password:" / "Password:").
/// Rút thư mục hiện tại từ một dòng dấu nhắc shell kiểu `user@host:PATH# …` / `…$ …`.
/// Lấy PATH giữa dấu `:` (sau `@`) và ký tự `#`/`$`. Trả None nếu không khớp (prompt tuỳ biến).
fn cwd_from_prompt(line: &str) -> Option<String> {
    let at = line.find('@')?;
    let rest = &line[at + 1..];
    let colon = rest.find(':')?;
    let after = &rest[colon + 1..];
    let end = after.find(['#', '$'])?;
    let path = &after[..end];
    if path.is_empty() || path.chars().any(|c| c.is_whitespace()) {
        return None;
    }
    if path.starts_with('/') || path.starts_with('~') {
        Some(path.to_string())
    } else {
        None
    }
}

pub(crate) fn is_password_prompt(low: &str) -> bool {
    let t = low.trim_end();
    // Dấu nhắc mật khẩu luôn kết thúc bằng "password:" (OpenSSH: "user@host's password:").
    t.ends_with("password:") || t.ends_with("password: ") || low.contains("password: ")
}

/// Xử lý output để tự điền mật khẩu đã lưu / nhận biết đăng nhập thành-bại. Chạy trong thread đọc PTY.
pub(crate) fn handle_output(pw: &Arc<Mutex<PwState>>, writer: &SharedWriter, chunk: &[u8]) {
    let low = String::from_utf8_lossy(chunk).to_lowercase();
    let mut s = pw.lock().unwrap();
    if s.authed {
        return;
    }
    if s.awaiting_result {
        if low.contains("permission denied") || is_password_prompt(&low) {
            // Sai mật khẩu: nếu là mật khẩu đã lưu thì xoá đi để lần sau hỏi lại.
            if s.injected_saved {
                keyring_delete(&s.key);
                s.saved = None;
            }
            s.candidate = None;
            s.awaiting_result = false;
            s.injected = false;
            s.injected_saved = false;
            // rơi xuống dưới để xử lý dấu nhắc mới (nếu có) trong cùng chunk.
        } else if low.trim().is_empty() {
            // Chỉ là dòng trống / echo xuống dòng sau khi gõ mật khẩu — CHƯA biết đúng/sai, chờ chunk sau.
            // (Nếu vội coi là thành công ở đây sẽ lưu nhầm mật khẩu sai → lần sau tự điền gây "permission denied".)
            return;
        } else {
            // Có nội dung thật, không hỏi lại, không "permission denied" → đăng nhập thành công.
            if let Some(c) = s.candidate.take() {
                keyring_set(&s.key, &c);
                s.saved = Some(c);
            }
            s.authed = true;
            s.awaiting_result = false;
            return;
        }
    }
    if is_password_prompt(&low) {
        if let Some(p) = s.saved.clone() {
            if !s.injected {
                if let Ok(mut w) = writer.lock() {
                    let _ = w.write_all(p.as_bytes());
                    let _ = w.write_all(b"\r");
                    let _ = w.flush();
                }
                s.injected = true;
                s.injected_saved = true;
                s.awaiting_result = true;
            }
        } else {
            // Chưa có mật khẩu lưu → ghi lại những gì người dùng gõ tiếp theo.
            s.capturing = true;
            s.buffer.clear();
        }
    }
}

#[derive(Default)]
pub struct SshState {
    terms: Mutex<HashMap<String, Arc<Term>>>,
    tunnels: Mutex<HashMap<String, std::process::Child>>,
    stats: Mutex<HashMap<String, Arc<StatSession>>>,
}

/// Phiên ssh ẩn chạy vòng lặp đọc /proc + df để lấy CPU/RAM/net/disk (không hiện terminal).
struct StatSession {
    child: Mutex<Box<dyn Child + Send + Sync>>,
    _master: Mutex<Box<dyn MasterPty + Send>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectCfg {
    host: String,
    port: u16,
    user: String,
    /// Đường dẫn private key (tuỳ chọn; không có thì dùng key mặc định / ssh-agent).
    key_path: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    /// Lệnh chạy ngay khi vào (tuỳ chọn) — không có thì mở shell tương tác.
    command: Option<String>,
    /// Ép cấp TTY từ xa (`ssh -tt`) — cần cho `docker exec -it` tương tác.
    tty: Option<bool>,
}

/// Kết nối SSH: mở ConPTY, chạy ssh.exe, stream output qua event `ssh-data`. Trả về id phiên.
#[tauri::command]
pub fn ssh_connect(app: AppHandle, state: State<SshState>, cfg: ConnectCfg) -> Result<String, String> {
    let pair = native_pty_system()
        .openpty(PtySize { rows: cfg.rows.unwrap_or(24), cols: cfg.cols.unwrap_or(80), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new("ssh");
    cmd.arg("-p");
    cmd.arg(cfg.port.to_string());
    cmd.arg("-o");
    cmd.arg("StrictHostKeyChecking=accept-new");
    cmd.arg("-o");
    cmd.arg("ServerAliveInterval=30");
    if cfg.tty.unwrap_or(false) {
        // -tt: ép cấp PTY từ xa dù stdin không phải tty (ConPTY) → docker exec -it chạy được.
        cmd.arg("-tt");
    }
    if let Some(k) = cfg.key_path.as_deref().filter(|s| !s.trim().is_empty()) {
        cmd.arg("-i");
        cmd.arg(prepared_key(k)?);
    }
    cmd.arg(format!("{}@{}", cfg.user, cfg.host));
    if let Some(c) = cfg.command.as_deref().filter(|s| !s.trim().is_empty()) {
        cmd.arg(c);
    }
    cmd.env("TERM", "xterm-256color");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| if cfg!(windows) { format!("Không chạy được ssh.exe ({e}). Cài 'OpenSSH Client' trong Windows Features.") } else { format!("Không chạy được ssh ({e}). Cài openssh-client (apt install openssh-client / brew install openssh).") })?;
    drop(pair.slave);

    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer: SharedWriter = Arc::new(Mutex::new(pair.master.take_writer().map_err(|e| e.to_string())?));

    // Trạng thái mật khẩu: nạp sẵn mật khẩu đã lưu cho host này (nếu có) để tự điền.
    let key = format!("{}@{}:{}", cfg.user, cfg.host, cfg.port);
    let pw = Arc::new(Mutex::new(PwState { saved: keyring_get(&key), key, ..Default::default() }));

    let id = format!("s{}", next_id());
    {
        let app = app.clone();
        let id = id.clone();
        let pw = pw.clone();
        let writer = writer.clone();
        std::thread::spawn(move || {
            let mut reader = reader;
            let mut buf = [0u8; 16384];
            // Theo dõi dòng hiện tại (đã lọc ANSI) để đọc thư mục từ dấu nhắc shell → panel SFTP đi theo.
            let mut cur_line = String::new();
            let mut last_cwd = String::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        handle_output(&pw, &writer, &buf[..n]);
                        let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                        let _ = app.emit("ssh-data", serde_json::json!({ "id": id, "data": data }));
                        // Cập nhật dòng hiện tại; gặp CR/LF thì sang dòng mới.
                        for ch in crate::sftp::strip_ansi(&String::from_utf8_lossy(&buf[..n])).chars() {
                            if ch == '\n' || ch == '\r' {
                                cur_line.clear();
                            } else {
                                cur_line.push(ch);
                                if cur_line.len() > 4096 {
                                    cur_line.clear();
                                }
                            }
                        }
                        if let Some(cwd) = cwd_from_prompt(&cur_line) {
                            if cwd != last_cwd {
                                last_cwd = cwd.clone();
                                let _ = app.emit("ssh-cd", serde_json::json!({ "id": id, "arg": cwd }));
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
            let _ = app.emit("ssh-closed", serde_json::json!({ "id": id }));
        });
    }

    state.terms.lock().unwrap().insert(
        id.clone(),
        Arc::new(Term { master: Mutex::new(pair.master), writer, child: Mutex::new(child), pw, cmdline: Mutex::new(CmdLine::default()) }),
    );
    Ok(id)
}

fn term_of(state: &SshState, id: &str) -> Result<Arc<Term>, String> {
    state.terms.lock().unwrap().get(id).cloned().ok_or_else(|| "Phiên SSH không tồn tại".into())
}

/// Gửi phím/dữ liệu người dùng gõ vào terminal.
#[tauri::command]
pub fn ssh_send(app: AppHandle, state: State<SshState>, id: String, data: String) -> Result<(), String> {
    let term = term_of(&state, &id)?;
    // Nếu đang ở dấu nhắc mật khẩu và chưa có mật khẩu lưu: ghi lại những gì gõ để học (kiểu MobaXterm).
    let capturing = {
        let mut s = term.pw.lock().unwrap();
        let was = s.capturing;
        if s.capturing {
            for &b in data.as_bytes() {
                match b {
                    b'\r' | b'\n' => {
                        let cand = String::from_utf8_lossy(&s.buffer).into_owned();
                        s.buffer.clear();
                        s.capturing = false;
                        if !cand.is_empty() {
                            s.candidate = Some(cand);
                            s.awaiting_result = true;
                        }
                        break; // phần sau Enter (hiếm) bỏ qua
                    }
                    0x7f | 0x08 => { s.buffer.pop(); } // Backspace
                    0x03 | 0x15 => { s.buffer.clear(); s.capturing = false; } // Ctrl-C / Ctrl-U: huỷ
                    _ => s.buffer.push(b),
                }
            }
        }
        was
    };
    // Theo dõi dòng lệnh để bắt `cd` → phát event cho panel SFTP đi theo (chỉ khi KHÔNG nhập mật khẩu).
    if !capturing {
        let mut cl = term.cmdline.lock().unwrap();
        for &b in data.as_bytes() {
            match b {
                b'\r' | b'\n' => {
                    if !cl.bad {
                        if let Some(arg) = parse_cd(&String::from_utf8_lossy(&cl.buf)) {
                            let _ = app.emit("ssh-cd", serde_json::json!({ "id": id, "arg": arg }));
                        }
                    }
                    cl.buf.clear();
                    cl.bad = false;
                }
                0x1b | 0x09 => cl.bad = true, // ESC (mũi tên/history) hoặc Tab (completion) → không tin dòng này
                0x03 | 0x15 => { cl.buf.clear(); cl.bad = false; } // Ctrl-C / Ctrl-U: huỷ dòng
                0x7f | 0x08 => { cl.buf.pop(); } // Backspace
                _ => { if b >= 0x20 { cl.buf.push(b); } }
            }
        }
    }
    let mut w = term.writer.lock().unwrap();
    w.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    w.flush().map_err(|e| e.to_string())
}

/// Nếu `line` là một lệnh `cd` đơn thuần, trả về tham số (chuỗi rỗng = `cd` về home).
/// Bỏ qua khi có toán tử shell (`&`, `;`, `|`) để không nhảy nhầm.
fn parse_cd(line: &str) -> Option<String> {
    let t = line.trim();
    let arg = if t == "cd" {
        ""
    } else if let Some(rest) = t.strip_prefix("cd ") {
        rest.trim()
    } else {
        return None;
    };
    if arg.contains('&') || arg.contains(';') || arg.contains('|') || arg.contains('`') || arg.contains('$') {
        return None;
    }
    // Bỏ nháy bao quanh nếu có.
    let a = arg.trim_matches('"').trim_matches('\'');
    Some(a.to_string())
}

/// Xoá mật khẩu đã lưu của một host khỏi Windows Credential Manager.
#[tauri::command]
pub fn ssh_forget_password(user: String, host: String, port: u16) -> Result<(), String> {
    keyring_delete(&format!("{user}@{host}:{port}"));
    Ok(())
}

/// Host này đã có mật khẩu lưu chưa (để UI hiện trạng thái / nút quên).
#[tauri::command]
pub fn ssh_has_password(user: String, host: String, port: u16) -> Result<bool, String> {
    Ok(keyring_get(&format!("{user}@{host}:{port}")).is_some())
}

/// Đổi kích thước terminal (số cột/hàng) theo khung hiển thị.
#[tauri::command]
pub fn ssh_resize(state: State<SshState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let term = term_of(&state, &id)?;
    let res = term
        .master
        .lock()
        .unwrap()
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
    res.map_err(|e| e.to_string())
}

/// Đóng phiên: kill ssh.exe và bỏ khỏi bảng.
#[tauri::command]
pub fn ssh_disconnect(state: State<SshState>, id: String) -> Result<(), String> {
    if let Some(term) = state.terms.lock().unwrap().remove(&id) {
        let _ = term.child.lock().unwrap().kill();
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelCfg {
    /// Id do UI tự sinh (dùng để đóng lại).
    id: String,
    host: String,
    port: u16,
    user: String,
    key_path: Option<String>,
    /// "L" (local) | "R" (remote) | "D" (dynamic/SOCKS).
    kind: String,
    local_port: u16,
    remote_host: Option<String>,
    remote_port: Option<u16>,
}

/// Mở tunnel bằng `ssh -N`. BatchMode=yes để không treo chờ mật khẩu (tunnel cần key/agent).
#[tauri::command]
pub fn ssh_tunnel_open(app: AppHandle, state: State<SshState>, cfg: TunnelCfg) -> Result<(), String> {
    let (flag, spec) = match cfg.kind.as_str() {
        "D" => ("-D", cfg.local_port.to_string()),
        "L" | "R" => {
            let rh = cfg.remote_host.as_deref().unwrap_or("localhost");
            let rp = cfg.remote_port.ok_or("Thiếu cổng đích cho tunnel")?;
            (if cfg.kind == "L" { "-L" } else { "-R" }, format!("{}:{}:{}", cfg.local_port, rh, rp))
        }
        _ => return Err("Loại tunnel không hợp lệ".into()),
    };

    let mut c = std::process::Command::new("ssh");
    c.args(["-N", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30"]);
    c.arg(flag);
    c.arg(&spec);
    c.arg("-p");
    c.arg(cfg.port.to_string());
    if let Some(k) = cfg.key_path.as_deref().filter(|s| !s.trim().is_empty()) {
        c.arg("-i");
        c.arg(prepared_key(k)?);
    }
    c.arg(format!("{}@{}", cfg.user, cfg.host));
    c.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = c.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            if cfg!(windows) { "Không tìm thấy ssh.exe — cài 'OpenSSH Client'".to_string() } else { "Không tìm thấy ssh — cài openssh-client".to_string() }
        } else {
            e.to_string()
        }
    })?;

    if let Some(stderr) = child.stderr.take() {
        let app = app.clone();
        let id = cfg.id.clone();
        std::thread::spawn(move || {
            let r = std::io::BufReader::new(stderr);
            for line in r.lines().map_while(Result::ok) {
                let _ = app.emit("ssh-tunnel", serde_json::json!({ "id": id, "line": line }));
            }
            // stderr đóng = tiến trình ssh thoát (lỗi auth / forward / mất kết nối).
            let _ = app.emit("ssh-tunnel", serde_json::json!({ "id": id, "closed": true }));
        });
    }

    state.tunnels.lock().unwrap().insert(cfg.id.clone(), child);
    Ok(())
}

/// Đóng tunnel: kill tiến trình ssh.
#[tauri::command]
pub fn ssh_tunnel_close(state: State<SshState>, id: String) -> Result<(), String> {
    if let Some(mut child) = state.tunnels.lock().unwrap().remove(&id) {
        let _ = child.kill();
    }
    Ok(())
}

/* ── Thống kê server (CPU/RAM/net/disk), kiểu MobaXterm ──────────────────────────
   Chạy một phiên ssh ẩn với vòng lặp đọc /proc + df mỗi ~2s; Rust parse rồi phát `ssh-stat`.
   Chỉ dùng cho server Linux (có /proc). */

/// Lệnh remote in một khối thống kê mỗi 2s. Dùng sh thuần cho tương thích rộng.
const STAT_CMD: &str = "while :; do echo __DSSTAT__; grep '^cpu ' /proc/stat 2>/dev/null; echo __MEM__; grep -E '^(MemTotal|MemAvailable):' /proc/meminfo 2>/dev/null; echo __NET__; cat /proc/net/dev 2>/dev/null; echo __DISK__; df -P -k / 2>/dev/null | tail -1; echo __LOAD__; cat /proc/loadavg 2>/dev/null; echo __UP__; cat /proc/uptime 2>/dev/null; echo __END__; sleep 2; done";

fn parse_cpu(line: &str) -> Option<(u64, u64)> {
    let mut it = line.split_whitespace();
    it.next()?; // "cpu"
    let v: Vec<u64> = it.filter_map(|x| x.parse().ok()).collect();
    if v.len() < 4 {
        return None;
    }
    let idle = v[3] + v.get(4).copied().unwrap_or(0); // idle + iowait
    Some((v.iter().sum(), idle))
}

fn parse_net(lines: &[&str]) -> (u64, u64) {
    let (mut rx, mut tx) = (0u64, 0u64);
    for l in lines {
        if let Some((iface, rest)) = l.split_once(':') {
            let name = iface.trim();
            if name == "lo" || name.is_empty() {
                continue;
            }
            let f: Vec<u64> = rest.split_whitespace().filter_map(|x| x.parse().ok()).collect();
            if f.len() >= 9 {
                rx += f[0];
                tx += f[8];
            }
        }
    }
    (rx, tx)
}

/// Mở phiên thống kê; phát event `ssh-stat` { id, cpu, memUsed, memTotal, netRx, netTx, diskUsed, diskTotal, load }.
#[tauri::command]
pub fn ssh_stat_start(app: AppHandle, state: State<SshState>, cfg: ConnectCfg) -> Result<String, String> {
    let pair = native_pty_system()
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new("ssh");
    cmd.arg("-p");
    cmd.arg(cfg.port.to_string());
    cmd.arg("-o");
    cmd.arg("StrictHostKeyChecking=accept-new");
    cmd.arg("-o");
    cmd.arg("ServerAliveInterval=30");
    if let Some(k) = cfg.key_path.as_deref().filter(|s| !s.trim().is_empty()) {
        cmd.arg("-i");
        cmd.arg(prepared_key(k)?);
    }
    cmd.arg(format!("{}@{}", cfg.user, cfg.host));
    cmd.arg(STAT_CMD);

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer: SharedWriter = Arc::new(Mutex::new(pair.master.take_writer().map_err(|e| e.to_string())?));
    let key = format!("{}@{}:{}", cfg.user, cfg.host, cfg.port);
    let pw = Arc::new(Mutex::new(PwState { saved: keyring_get(&key), key, ..Default::default() }));

    let id = next_session_id("m");
    {
        let app = app.clone();
        let id = id.clone();
        std::thread::spawn(move || {
            let mut reader = reader;
            let mut rbuf = [0u8; 8192];
            let mut acc = String::new();
            // Mốc trước (tính delta CPU% và tốc độ mạng).
            let mut prev: Option<(u64, u64, u64, u64, std::time::Instant)> = None; // cpu_total, cpu_idle, rx, tx, t
            loop {
                match reader.read(&mut rbuf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        handle_output(&pw, &writer, &rbuf[..n]); // tự điền mật khẩu lúc auth
                        acc.push_str(&String::from_utf8_lossy(&rbuf[..n]));
                        if acc.len() > 200_000 {
                            acc.clear();
                        }
                        // Xử lý mọi khối hoàn chỉnh __DSSTAT__ … __END__.
                        while let (Some(s), Some(e)) = (acc.find("__DSSTAT__"), acc.find("__END__")) {
                            if e < s {
                                acc.replace_range(..e + 7, "");
                                continue;
                            }
                            let block = acc[s + 10..e].to_string();
                            acc.replace_range(..e + 7, "");
                            if let Some(js) = parse_block(&block, &mut prev) {
                                let mut map = js;
                                map.insert("id".into(), serde_json::Value::String(id.clone()));
                                let _ = app.emit("ssh-stat", serde_json::Value::Object(map));
                            }
                        }
                    }
                }
            }
        });
    }

    state.stats.lock().unwrap().insert(
        id.clone(),
        Arc::new(StatSession { child: Mutex::new(child), _master: Mutex::new(pair.master) }),
    );
    Ok(id)
}

/// Parse một khối thống kê → map JSON (chưa có id). Trả None nếu thiếu dữ liệu cốt lõi.
fn parse_block(
    block: &str,
    prev: &mut Option<(u64, u64, u64, u64, std::time::Instant)>,
) -> Option<serde_json::Map<String, serde_json::Value>> {
    let mut section = "";
    let mut cpu: Option<(u64, u64)> = None;
    let (mut mem_total, mut mem_avail) = (0u64, 0u64);
    let mut net_lines: Vec<&str> = Vec::new();
    let mut disk_line = "";
    let mut load = 0.0f64;
    let mut uptime = 0.0f64;
    for line in block.lines() {
        let t = line.trim();
        match t {
            "__MEM__" => section = "mem",
            "__NET__" => section = "net",
            "__DISK__" => section = "disk",
            "__LOAD__" => section = "load",
            "__UP__" => section = "up",
            _ if t.starts_with("cpu ") => cpu = parse_cpu(t),
            _ => match section {
                "mem" => {
                    if let Some(v) = t.strip_prefix("MemTotal:") {
                        mem_total = v.split_whitespace().next().and_then(|x| x.parse().ok()).unwrap_or(0);
                    } else if let Some(v) = t.strip_prefix("MemAvailable:") {
                        mem_avail = v.split_whitespace().next().and_then(|x| x.parse().ok()).unwrap_or(0);
                    }
                }
                "net" => net_lines.push(line),
                "disk" if !t.is_empty() => disk_line = line,
                "load" if !t.is_empty() => load = t.split_whitespace().next().and_then(|x| x.parse().ok()).unwrap_or(0.0),
                "up" if !t.is_empty() => uptime = t.split_whitespace().next().and_then(|x| x.parse().ok()).unwrap_or(0.0),
                _ => {}
            },
        }
    }
    let (cpu_total, cpu_idle) = cpu?;
    let (rx, tx) = parse_net(&net_lines);
    let now = std::time::Instant::now();

    let (cpu_pct, net_rx, net_tx) = match prev.replace((cpu_total, cpu_idle, rx, tx, now)) {
        Some((pt, pi, prx, ptx, pt_time)) => {
            let dt = pt_time.elapsed().as_secs_f64().max(0.001);
            let dtot = cpu_total.saturating_sub(pt) as f64;
            let didle = cpu_idle.saturating_sub(pi) as f64;
            let cpu = if dtot > 0.0 { (100.0 * (1.0 - didle / dtot)).clamp(0.0, 100.0) } else { 0.0 };
            (cpu, (rx.saturating_sub(prx) as f64 / dt), (tx.saturating_sub(ptx) as f64 / dt))
        }
        None => (0.0, 0.0, 0.0),
    };

    // Disk: fields = fs, total_kb, used_kb, avail, pct, mount.
    let df: Vec<&str> = disk_line.split_whitespace().collect();
    let (disk_total, disk_used) = if df.len() >= 3 {
        (df[1].parse::<u64>().unwrap_or(0) * 1024, df[2].parse::<u64>().unwrap_or(0) * 1024)
    } else {
        (0, 0)
    };

    let mut m = serde_json::Map::new();
    m.insert("cpu".into(), (cpu_pct.round() as u64).into());
    m.insert("memUsed".into(), (mem_total.saturating_sub(mem_avail) * 1024).into());
    m.insert("memTotal".into(), (mem_total * 1024).into());
    m.insert("netRx".into(), (net_rx as u64).into());
    m.insert("netTx".into(), (net_tx as u64).into());
    m.insert("diskUsed".into(), disk_used.into());
    m.insert("diskTotal".into(), disk_total.into());
    m.insert("load".into(), serde_json::json!((load * 100.0).round() / 100.0));
    m.insert("uptime".into(), (uptime as u64).into());
    Some(m)
}

/// Dừng phiên thống kê.
#[tauri::command]
pub fn ssh_stat_stop(state: State<SshState>, id: String) -> Result<(), String> {
    if let Some(s) = state.stats.lock().unwrap().remove(&id) {
        let _ = s.child.lock().unwrap().kill();
    }
    Ok(())
}

// ───────────────────────── Docker (liệt kê container để exec/duyệt) ─────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerContainer {
    id: String,
    name: String,
    image: String,
    status: String,
    ports: String,
}

/// Format tab-delimited để parse chắc tay (id đầy đủ, không cắt).
// Dấu phân cách cột: KHÔNG dùng tab — ConPTY render terminal sẽ GIÃN tab thành dấu cách (mất tab).
// Dùng token ASCII in được, hầu như không xuất hiện trong tên/image/ports của docker.
const DOCKER_DELIM: &str = "<%DS%>";
const DOCKER_PS_FMT: &str =
    "docker ps --no-trunc --format '{{.ID}}<%DS%>{{.Names}}<%DS%>{{.Image}}<%DS%>{{.Status}}<%DS%>{{.Ports}}' 2>&1";

/// Chạy một lệnh ssh **một-lần** (không tương tác) trong ConPTY, tự điền mật khẩu đã lưu qua `PwState`,
/// trả stdout đã lọc ANSI. Có timeout: quá hạn thì kill tiến trình và báo lỗi.
fn ssh_run_once(cfg: &ConnectCfg, command: &str, timeout: std::time::Duration, max_bytes: usize) -> Result<String, String> {
    let pair = native_pty_system()
        // Rộng để ssh/PTY ít ngắt dòng giữa chừng (cột Ports có thể dài).
        .openpty(PtySize { rows: 50, cols: 1000, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new("ssh");
    cmd.arg("-p");
    cmd.arg(cfg.port.to_string());
    cmd.arg("-o");
    cmd.arg("StrictHostKeyChecking=accept-new");
    cmd.arg("-o");
    cmd.arg("ConnectTimeout=10");
    if let Some(k) = cfg.key_path.as_deref().filter(|s| !s.trim().is_empty()) {
        cmd.arg("-i");
        cmd.arg(prepared_key(k)?);
    }
    cmd.arg(format!("{}@{}", cfg.user, cfg.host));
    // Marker báo "đã xong" để KHÔNG phụ thuộc EOF của ConPTY (ConPTY thường không trả EOF ngay
    // khi lệnh từ xa kết thúc → sẽ treo tới hết timeout). Thấy marker là dừng ngay.
    const MARKER: &str = "__DEVSTATION_DONE_7Qx9__";
    cmd.arg(format!("{command}; echo {MARKER}"));

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer: SharedWriter = Arc::new(Mutex::new(pair.master.take_writer().map_err(|e| e.to_string())?));
    let key = format!("{}@{}:{}", cfg.user, cfg.host, cfg.port);
    let pw = Arc::new(Mutex::new(PwState { saved: keyring_get(&key), key, ..Default::default() }));

    let (tx, rx) = std::sync::mpsc::channel::<String>();
    {
        let pw = pw.clone();
        let writer = writer.clone();
        std::thread::spawn(move || {
            let mut reader = reader;
            let mut buf = [0u8; 8192];
            let mut acc = String::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break, // EOF (fallback)
                    Ok(n) => {
                        handle_output(&pw, &writer, &buf[..n]); // tự điền mật khẩu lúc auth
                        acc.push_str(&crate::sftp::strip_ansi(&String::from_utf8_lossy(&buf[..n])));
                        // Xong khi thấy marker (bỏ marker + phần sau). Chỉ tính marker do `echo` in ra —
                        // không tính lần marker lặp trong dòng lệnh echo nếu PTY có vọng (hiếm): lấy lần CUỐI.
                        if let Some(i) = acc.rfind(MARKER) {
                            // Nếu marker nằm ngay sau một dòng lệnh echo (vọng), vẫn an toàn vì ta cắt tại marker
                            // và output docker nằm TRƯỚC đó.
                            acc.truncate(i);
                            break;
                        }
                        if acc.len() > max_bytes {
                            break;
                        }
                    }
                }
            }
            let _ = tx.send(acc);
        });
    }

    let out = rx.recv_timeout(timeout);
    let _ = child.kill();
    out.map_err(|_| {
        "Hết thời gian chờ server phản hồi (server chậm, hoặc host dùng mật khẩu nhưng chưa lưu — \
         hãy mở terminal đăng nhập một lần để lưu mật khẩu, hoặc dùng key)."
            .to_string()
    })
}

/// Parse output `docker ps` (tab-delimited) → danh sách container. Bắt vài lỗi docker thường gặp.
fn parse_docker_ps(out: &str) -> Result<Vec<DockerContainer>, String> {
    let low = out.to_lowercase();
    if low.contains("command not found") || low.contains("docker: not found") {
        return Err("Server không có Docker (lệnh `docker` không tìm thấy trong PATH).".into());
    }
    if low.contains("cannot connect to the docker daemon") {
        return Err("Docker daemon không chạy trên server.".into());
    }
    if low.contains("permission denied") && low.contains(".sock") {
        return Err("Không có quyền truy cập Docker (user không thuộc nhóm docker — cần sudo/root).".into());
    }
    let mut v = Vec::new();
    for line in out.lines() {
        let line = line.trim_end_matches('\r');
        if !line.contains(DOCKER_DELIM) {
            continue;
        }
        let cols: Vec<&str> = line.split(DOCKER_DELIM).collect();
        if cols.len() < 2 {
            continue;
        }
        let id = cols[0].trim();
        // ID container luôn là hex — lọc bỏ banner/MOTD/prompt lẫn vào.
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_hexdigit()) {
            continue;
        }
        v.push(DockerContainer {
            id: id.to_string(),
            name: cols.get(1).map(|s| s.trim()).unwrap_or("").to_string(),
            image: cols.get(2).map(|s| s.trim()).unwrap_or("").to_string(),
            status: cols.get(3).map(|s| s.trim()).unwrap_or("").to_string(),
            ports: cols.get(4).map(|s| s.trim()).unwrap_or("").to_string(),
        });
    }
    // Không parse được container nào nhưng output CÓ nội dung → nhiều khả năng là lỗi khác
    // (thiếu quyền/sudo, lệnh lỗi, hoặc output bị ngắt dòng). Trả raw để người dùng thấy rõ.
    if v.is_empty() {
        let preview: String = out
            .lines()
            .map(|l| l.trim_end_matches('\r').trim())
            .filter(|l| !l.is_empty())
            .take(10)
            .collect::<Vec<_>>()
            .join("\n");
        if !preview.is_empty() {
            return Err(format!(
                "Không parse được container nào từ `docker ps`. Server trả về:\n{preview}"
            ));
        }
    }
    Ok(v)
}

/// Liệt kê container Docker đang chạy trên server (dùng cho panel Docker trong app SSH).
#[tauri::command]
pub async fn ssh_docker_ps(cfg: ConnectCfg) -> Result<Vec<DockerContainer>, String> {
    let out = tauri::async_runtime::spawn_blocking(move || {
        ssh_run_once(&cfg, DOCKER_PS_FMT, std::time::Duration::from_secs(20), 4_000_000)
    })
    .await
    .map_err(|e| e.to_string())??;
    parse_docker_ps(&out)
}

// ───────────── Duyệt file TRONG container Docker (qua `docker exec`, không phải sftp host) ─────────────

/// Trích dẫn POSIX cho shell từ xa: bọc single-quote, escape `'`.
fn shq(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Chạy một lệnh qua ssh (một-lần) — wrapper async cho `ssh_run_once`.
async fn ssh_run_cmd(cfg: ConnectCfg, command: String, secs: u64, max_bytes: usize) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ssh_run_once(&cfg, &command, std::time::Duration::from_secs(secs), max_bytes)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Bắt các lỗi `docker exec` thường gặp từ output (trả thông báo gọn). None = không phải lỗi rõ ràng.
fn docker_exec_err(out: &str) -> Option<String> {
    let low = out.to_lowercase();
    if low.contains("no such container") || low.contains("is not running") {
        return Some("Container không tồn tại hoặc đã dừng.".into());
    }
    if low.contains("permission denied") && low.contains(".sock") {
        return Some("Không có quyền truy cập Docker (cần sudo/root).".into());
    }
    if low.contains("executable file not found") || low.contains("exec: ") && low.contains("not found") {
        return Some("Container thiếu lệnh cần thiết (ls/base64…) — có thể là image tối giản (distroless).".into());
    }
    if low.contains("cannot access") || low.contains("no such file or directory") {
        return Some("Không tìm thấy đường dẫn trong container.".into());
    }
    None
}

/// Liệt kê thư mục TRONG container: `docker exec <c> ls -la <path>`.
/// `tz`: chuỗi POSIX TZ của máy người dùng (vd `ICT-7`) để `ls` in giờ địa phương thay vì UTC của container.
#[tauri::command]
pub async fn docker_fs_list(cfg: ConnectCfg, container: String, path: String, tz: Option<String>) -> Result<Vec<crate::sftp::Entry>, String> {
    let tz_arg = match tz.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(z) => format!("-e TZ={} ", shq(z)),
        None => String::new(),
    };
    let cmd = format!("docker exec {}{} ls -la {} 2>&1", tz_arg, shq(&container), shq(&path));
    let out = ssh_run_cmd(cfg, cmd, 30, 4_000_000).await?;
    let entries = crate::sftp::parse_ls(&out);
    // Rỗng + có dấu hiệu lỗi → báo lỗi (phân biệt với thư mục rỗng thật).
    if entries.is_empty() {
        if let Some(e) = docker_exec_err(&out) {
            return Err(e);
        }
    }
    Ok(entries)
}

/// Thư mục làm việc mặc định (WORKDIR) của container.
#[tauri::command]
pub async fn docker_fs_home(cfg: ConnectCfg, container: String) -> Result<String, String> {
    let cmd = format!("docker exec {} pwd 2>/dev/null", shq(&container));
    let out = ssh_run_cmd(cfg, cmd, 15, 100_000).await?;
    let p = out.lines().map(|l| l.trim()).find(|l| l.starts_with('/')).unwrap_or("/");
    Ok(p.to_string())
}

/// Resolve lệnh cd trong container (neo theo cwd), trả path tuyệt đối hoặc lỗi nếu không vào được.
#[tauri::command]
pub async fn docker_fs_cd(cfg: ConnectCfg, container: String, cwd: String, arg: String) -> Result<String, String> {
    let inner = format!("cd {} 2>/dev/null; cd {} && pwd", shq(&cwd), shq(&arg));
    let cmd = format!("docker exec {} sh -c {} 2>&1", shq(&container), shq(&inner));
    let out = ssh_run_cmd(cfg, cmd, 15, 100_000).await?;
    match out.lines().map(|l| l.trim()).find(|l| l.starts_with('/')) {
        Some(p) => Ok(p.to_string()),
        None => Err("Không vào được thư mục.".into()),
    }
}

/// Preview một file trong container: lấy kích thước; nếu ≤ max thì base64 về rồi phân loại.
/// Base64 đi qua ConPTY an toàn (chỉ ký tự ASCII in được + xuống dòng) nên không bị méo như `cat`.
#[tauri::command]
pub async fn docker_fs_read(cfg: ConnectCfg, container: String, path: String, max: u64) -> Result<crate::sftp::Preview, String> {
    // Script: in "__SZ__<size>" rồi (nếu nhỏ) base64 nội dung.
    let inner = format!(
        "p={}; s=`wc -c < \"$p\" 2>/dev/null`; [ -z \"$s\" ] && {{ echo __DSERR__; exit 0; }}; echo \"__SZ__$s\"; [ \"$s\" -le {} ] && base64 \"$p\" 2>/dev/null",
        shq(&path), max
    );
    let cmd = format!("docker exec {} sh -c {} 2>&1", shq(&container), shq(&inner));
    // Cho phép tới ~ (max*4/3 + lề) byte base64.
    let cap = (max as usize).saturating_mul(2).max(4_000_000);
    let out = ssh_run_cmd(cfg, cmd, 60, cap).await?;
    if out.contains("__DSERR__") {
        return Err("Không đọc được file trong container (không tồn tại hoặc không có quyền).".into());
    }
    // Tìm dòng "__SZ__<n>".
    let size: u64 = out
        .lines()
        .find_map(|l| l.trim().strip_prefix("__SZ__").and_then(|n| n.trim().parse().ok()))
        .ok_or_else(|| {
            docker_exec_err(&out).unwrap_or_else(|| "Không đọc được kích thước file.".into())
        })?;
    let ext = path.rsplit('.').next().unwrap_or("").to_lowercase();
    if size > max {
        return Ok(crate::sftp::preview_toolarge(size));
    }
    // Lấy phần base64 = mọi ký tự base64 sau dòng __SZ__.
    let after = out.split("__SZ__").nth(1).unwrap_or("");
    // Bỏ phần số kích thước ở đầu dòng đầu, rồi gom toàn bộ ký tự base64.
    let b64: String = after
        .chars()
        .skip_while(|c| c.is_ascii_digit())
        .filter(|c| c.is_ascii_alphanumeric() || *c == '+' || *c == '/' || *c == '=')
        .collect();
    if b64.is_empty() {
        return Err("Container không có lệnh `base64` để đọc nội dung (image tối giản).".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .map_err(|_| "Nội dung trả về không hợp lệ (base64 lỗi).".to_string())?;
    Ok(crate::sftp::classify(&bytes, &ext, max))
}

/// Tải một file trong container về máy (qua base64). Cap ~64MB để tránh ngốn RAM.
#[tauri::command]
pub async fn docker_fs_get(cfg: ConnectCfg, container: String, remote: String, local: String) -> Result<(), String> {
    const DL_MAX: u64 = 64 * 1024 * 1024;
    let inner = format!(
        "p={}; s=`wc -c < \"$p\" 2>/dev/null`; [ -z \"$s\" ] && {{ echo __DSERR__; exit 0; }}; [ \"$s\" -gt {} ] && {{ echo __DSBIG__; exit 0; }}; base64 \"$p\" 2>/dev/null",
        shq(&remote), DL_MAX
    );
    let cmd = format!("docker exec {} sh -c {} 2>&1", shq(&container), shq(&inner));
    let out = ssh_run_cmd(cfg, cmd, 180, 100_000_000).await?;
    if out.contains("__DSERR__") {
        return Err("Không đọc được file trong container.".into());
    }
    if out.contains("__DSBIG__") {
        return Err("File > 64MB — tải trong panel container chưa hỗ trợ (dùng terminal + docker cp).".into());
    }
    let b64: String = out
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '+' || *c == '/' || *c == '=')
        .collect();
    if b64.is_empty() {
        return Err("Container không có lệnh `base64`.".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .map_err(|_| "base64 lỗi.".to_string())?;
    std::fs::write(&local, bytes).map_err(|e| e.to_string())
}

/// Tạo thư mục trong container.
#[tauri::command]
pub async fn docker_fs_mkdir(cfg: ConnectCfg, container: String, path: String) -> Result<(), String> {
    let cmd = format!("docker exec {} mkdir {} 2>&1", shq(&container), shq(&path));
    let out = ssh_run_cmd(cfg, cmd, 20, 100_000).await?;
    docker_op_result(&out)
}

/// Xoá file trong container.
#[tauri::command]
pub async fn docker_fs_rm(cfg: ConnectCfg, container: String, path: String) -> Result<(), String> {
    let cmd = format!("docker exec {} rm -f {} 2>&1", shq(&container), shq(&path));
    let out = ssh_run_cmd(cfg, cmd, 20, 100_000).await?;
    docker_op_result(&out)
}

/// Xoá thư mục (rỗng) trong container.
#[tauri::command]
pub async fn docker_fs_rmdir(cfg: ConnectCfg, container: String, path: String) -> Result<(), String> {
    let cmd = format!("docker exec {} rm -rf {} 2>&1", shq(&container), shq(&path));
    let out = ssh_run_cmd(cfg, cmd, 20, 100_000).await?;
    docker_op_result(&out)
}

/// Đổi tên / di chuyển trong container.
#[tauri::command]
pub async fn docker_fs_rename(cfg: ConnectCfg, container: String, from: String, to: String) -> Result<(), String> {
    let cmd = format!("docker exec {} mv {} {} 2>&1", shq(&container), shq(&from), shq(&to));
    let out = ssh_run_cmd(cfg, cmd, 20, 100_000).await?;
    docker_op_result(&out)
}

/// Tạo file rỗng trong container (`touch`).
#[tauri::command]
pub async fn docker_fs_touch(cfg: ConnectCfg, container: String, path: String) -> Result<(), String> {
    let cmd = format!("docker exec {} touch {} 2>&1", shq(&container), shq(&path));
    let out = ssh_run_cmd(cfg, cmd, 20, 100_000).await?;
    docker_op_result(&out)
}

/// Thao tác file không output = thành công; có output lỗi = trả lỗi.
fn docker_op_result(out: &str) -> Result<(), String> {
    let t = out.trim();
    if t.is_empty() {
        return Ok(());
    }
    Err(docker_exec_err(out).unwrap_or_else(|| t.lines().next().unwrap_or("Lỗi").to_string()))
}

#[cfg(all(test, windows))]
mod ppk_tests {
    use super::*;
    use std::process::Command;

    /// Convert file .ppk ở biến môi trường DS_TEST_PPK rồi kiểm tra ssh-keygen đọc được key kết quả.
    /// (Không hardcode đường dẫn/khoá của ai; bỏ qua nếu không đặt biến.)
    #[test]
    fn convert_real_ppk() {
        let Ok(path) = std::env::var("DS_TEST_PPK") else { return };
        let text = std::fs::read_to_string(&path).expect("đọc .ppk");
        let pem = convert_ppk_to_openssh(&text).expect("convert .ppk");
        let out = std::env::temp_dir().join("ds_ppk_test.key");
        std::fs::write(&out, pem).unwrap();
        // ssh-keygen -y đọc private key và in public key — chạy được = cấu trúc key hợp lệ.
        let o = Command::new("ssh-keygen").args(["-y", "-f", out.to_str().unwrap()]).output().expect("ssh-keygen");
        let stdout = String::from_utf8_lossy(&o.stdout);
        let stderr = String::from_utf8_lossy(&o.stderr);
        let _ = std::fs::remove_file(&out);
        assert!(o.status.success() && stdout.starts_with("ecdsa") || stdout.starts_with("ssh-"),
            "ssh-keygen từ chối key đã convert:\nSTDOUT: {stdout}\nSTDERR: {stderr}");
    }
}
