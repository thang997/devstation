//! App SSH — panel SFTP (duyệt + preview file) kiểu MobaXterm.
//!
//! Chạy `sftp.exe` của hệ thống trong một ConPTY (giống app terminal dùng `ssh.exe`), giữ phiên
//! tương tác bền và điều khiển bằng cách ghi lệnh `sftp` rồi đọc kết quả tới dấu nhắc `sftp> `.
//! Tái dùng nguyên auth của app SSH: chuẩn hoá key (`prepared_key`), tự điền mật khẩu đã lưu trong
//! Windows Credential Manager (`PwState`/`handle_output`, khoá `user@host:port`).
//!
//! Vì panel không có chỗ để gõ mật khẩu: host dùng mật khẩu mà CHƯA lưu thì báo lỗi rõ
//! (mở terminal đăng nhập một lần để lưu, hoặc dùng private key).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::ssh::{handle_output, keyring_get, next_session_id, prepared_key, PwState, SharedWriter};

/// Bộ đệm output của phiên sftp (tích luỹ tới khi thấy dấu nhắc `sftp> `).
struct SftpBuf {
    text: String,
    closed: bool,
}

/// Một phiên sftp tương tác: writer (ghi lệnh), buffer output, máy trạng thái mật khẩu, khoá nối tiếp lệnh.
struct SftpSession {
    writer: SharedWriter,
    buf: Arc<(Mutex<SftpBuf>, Condvar)>,
    pw: Arc<Mutex<PwState>>,
    /// sftp là một kênh duy nhất → mỗi lúc chỉ chạy một lệnh.
    cmd_lock: Mutex<()>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    /// Giữ master PTY sống (drop sẽ đóng kết nối).
    _master: Mutex<Box<dyn MasterPty + Send>>,
}

#[derive(Default)]
pub struct SftpState {
    sessions: Mutex<HashMap<String, Arc<SftpSession>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpCfg {
    host: String,
    port: u16,
    user: String,
    key_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    name: String,
    /// "dir" | "file" | "link"
    kind: String,
    size: u64,
    mtime: String,
    perms: String,
    link_target: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    /// "text" | "image" | "binary" | "toolarge"
    kind: String,
    /// text: nội dung UTF-8; image: base64; khác: rỗng.
    data: String,
    mime: String,
    size: u64,
}

const PROMPT: &str = "sftp>";

/// Bỏ các chuỗi điều khiển ANSI (CSI/OSC/ESC) mà sftp.exe trong PTY phát ra quanh dấu nhắc
/// (vd bracketed-paste `\x1b[?2004h`). Nếu không lọc, dò dấu nhắc `sftp>` sẽ hụt → chờ tới timeout.
pub(crate) fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c == '\u{1b}' {
            match it.peek() {
                Some('[') => {
                    // CSI: ESC [ ... ký tự kết thúc 0x40–0x7e
                    it.next();
                    while let Some(&nc) = it.peek() {
                        it.next();
                        if ('@'..='~').contains(&nc) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    // OSC: ESC ] ... kết thúc bằng BEL hoặc ST (ESC \)
                    it.next();
                    while let Some(&nc) = it.peek() {
                        if nc == '\u{07}' {
                            it.next();
                            break;
                        }
                        if nc == '\u{1b}' {
                            it.next();
                            if it.peek() == Some(&'\\') {
                                it.next();
                            }
                            break;
                        }
                        it.next();
                    }
                }
                Some(_) => {
                    it.next();
                }
                None => {}
            }
            continue;
        }
        // Bỏ các ký tự điều khiển hiếm khác (giữ \n, \r, \t).
        if c.is_control() && c != '\n' && c != '\r' && c != '\t' {
            continue;
        }
        out.push(c);
    }
    out
}

/// Output đã kết thúc (dòng cuối là dấu nhắc `sftp>`)?
/// Dùng "dòng cuối chứa sftp>" thay vì ends_with chặt để chịu được ký tự thừa còn sót sau khi lọc ANSI.
fn ends_with_prompt(text: &str) -> bool {
    match text.trim_end().lines().last() {
        Some(last) => last.contains(PROMPT),
        None => false,
    }
}

/// Trích phần kết quả: bỏ dòng echo lệnh ở đầu và dấu nhắc ở cuối, chuẩn hoá `\r`.
fn strip_prompt_and_echo(raw: &str, cmd: &str) -> String {
    let t = raw.replace('\r', "");
    // Cắt tại dấu nhắc cuối cùng.
    let body = match t.rfind(PROMPT) {
        Some(i) => &t[..i],
        None => &t[..],
    };
    let mut lines = body.split('\n');
    let first = lines.next().unwrap_or("");
    // Dòng đầu thường là echo lệnh vừa gõ → bỏ nếu khớp.
    let rest = if first.trim() == cmd.trim() || first.contains(cmd.trim()) {
        lines.collect::<Vec<_>>().join("\n")
    } else {
        body.to_string()
    };
    rest.trim_matches('\n').to_string()
}

/// Một đoạn output có dấu hiệu lỗi của sftp không.
fn looks_like_error(out: &str) -> Option<String> {
    let low = out.to_lowercase();
    const FRAGS: [&str; 7] = [
        "permission denied",
        "no such file",
        "not found",
        "couldn't",
        "can't ",
        "cannot ",
        "failure",
    ];
    if FRAGS.iter().any(|f| low.contains(f)) {
        Some(out.trim().to_string())
    } else {
        None
    }
}

/// Bọc path cho lệnh sftp (chứa khoảng trắng hoặc rỗng thì thêm nháy kép).
fn q(path: &str) -> String {
    if path.is_empty() || path.contains(' ') || path.contains('\t') {
        format!("\"{}\"", path.replace('"', "\\\""))
    } else {
        path.to_string()
    }
}

/// Chờ tới khi output hiện dấu nhắc `sftp>` (lệnh xong) hoặc gặp lỗi/đóng/timeout.
fn wait_prompt(session: &SftpSession, timeout: Duration) -> Result<(), String> {
    let (lock, cv) = &*session.buf;
    let deadline = Instant::now() + timeout;
    let mut g = lock.lock().unwrap();
    loop {
        if ends_with_prompt(&g.text) {
            return Ok(());
        }
        if g.closed {
            let tail: String = g.text.replace('\r', "");
            return Err(if tail.trim().is_empty() {
                "Phiên SFTP đã đóng".to_string()
            } else {
                tail.trim().lines().last().unwrap_or("Phiên SFTP đã đóng").to_string()
            });
        }
        // Dấu nhắc mật khẩu nhưng không có mật khẩu lưu → panel không có chỗ gõ, báo lỗi.
        if session.pw.lock().unwrap().stuck_without_password() {
            return Err("__NO_PASSWORD__".to_string());
        }
        let now = Instant::now();
        if now >= deadline {
            return Err("Hết thời gian chờ SFTP phản hồi".to_string());
        }
        let (ng, _) = cv.wait_timeout(g, deadline - now).unwrap();
        g = ng;
    }
}

/// Ghi một lệnh sftp rồi đọc kết quả tới dấu nhắc kế tiếp (giữ `cmd_lock` để nối tiếp).
fn run_cmd(session: &SftpSession, line: &str, timeout: Duration) -> Result<String, String> {
    let _guard = session.cmd_lock.lock().unwrap();
    {
        let (lock, _) = &*session.buf;
        lock.lock().unwrap().text.clear();
    }
    {
        let mut w = session.writer.lock().unwrap();
        w.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
        // Trong ConPTY, Enter là CR (\r) — gửi \n thì sftp không coi là hết dòng và treo.
        // (Giống đoạn tự điền mật khẩu trong ssh.rs cũng dùng "\r".)
        w.write_all(b"\r").map_err(|e| e.to_string())?;
        w.flush().map_err(|e| e.to_string())?;
    }
    wait_prompt(session, timeout)?;
    let raw = {
        let (lock, _) = &*session.buf;
        lock.lock().unwrap().text.clone()
    };
    Ok(strip_prompt_and_echo(&raw, line))
}

fn session_of(state: &SftpState, id: &str) -> Result<Arc<SftpSession>, String> {
    state.sessions.lock().unwrap().get(id).cloned().ok_or_else(|| "Phiên SFTP không tồn tại".into())
}

/// Mở một phiên SFTP mới: chạy sftp.exe trong ConPTY, auth (tự điền mật khẩu đã lưu), chờ dấu nhắc đầu.
/// CHẶN (chờ tới 30s) → phải gọi qua `spawn_blocking`, không chạy trên main thread.
fn open_blocking(cfg: SftpCfg) -> Result<Arc<SftpSession>, String> {
    let pair = native_pty_system()
        .openpty(PtySize { rows: 24, cols: 120, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new("sftp");
    cmd.arg("-P"); // sftp dùng -P hoa cho cổng (khác ssh -p thường).
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
    cmd.env("TERM", "xterm-256color");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| if cfg!(windows) { format!("Không chạy được sftp.exe ({e}). Cài 'OpenSSH Client' trong Windows Features.") } else { format!("Không chạy được sftp ({e}). Cài openssh-client (apt install openssh-client / brew install openssh).") })?;
    drop(pair.slave);

    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer: SharedWriter = Arc::new(Mutex::new(pair.master.take_writer().map_err(|e| e.to_string())?));

    let key = format!("{}@{}:{}", cfg.user, cfg.host, cfg.port);
    let pw = Arc::new(Mutex::new(PwState::new(key, keyring_get(&format!("{}@{}:{}", cfg.user, cfg.host, cfg.port)))));

    let buf = Arc::new((Mutex::new(SftpBuf { text: String::new(), closed: false }), Condvar::new()));

    {
        let pw = pw.clone();
        let writer = writer.clone();
        let buf = buf.clone();
        std::thread::spawn(move || {
            let mut reader = reader;
            let mut b = [0u8; 16384];
            loop {
                match reader.read(&mut b) {
                    Ok(0) | Err(_) => {
                        let (lock, cv) = &*buf;
                        lock.lock().unwrap().closed = true;
                        cv.notify_all();
                        break;
                    }
                    Ok(n) => {
                        handle_output(&pw, &writer, &b[..n]); // tự điền/học mật khẩu lúc auth (cần bytes thô)
                        let clean = strip_ansi(&String::from_utf8_lossy(&b[..n]));
                        let (lock, cv) = &*buf;
                        let mut g = lock.lock().unwrap();
                        g.text.push_str(&clean);
                        // Chặn phình to (listing lớn) — giữ phần đuôi.
                        if g.text.len() > 4_000_000 {
                            let cut = g.text.len() - 2_000_000;
                            g.text = g.text.split_off(cut);
                        }
                        cv.notify_all();
                    }
                }
            }
        });
    }

    let session = Arc::new(SftpSession {
        writer,
        buf,
        pw,
        cmd_lock: Mutex::new(()),
        child: Mutex::new(child),
        _master: Mutex::new(pair.master),
    });

    // Chờ dấu nhắc đầu tiên = đăng nhập xong (30s).
    if let Err(e) = wait_prompt(&session, Duration::from_secs(30)) {
        let _ = session.child.lock().unwrap().kill();
        if e == "__NO_PASSWORD__" {
            return Err(
                "Chưa lưu mật khẩu cho host này. Mở terminal đăng nhập một lần (để lưu mật khẩu) hoặc dùng private key, rồi thử lại.".into(),
            );
        }
        return Err(format!("Không mở được SFTP: {e}"));
    }
    Ok(session)
}

#[tauri::command]
pub async fn sftp_open(state: State<'_, SftpState>, cfg: SftpCfg) -> Result<String, String> {
    let session = tauri::async_runtime::spawn_blocking(move || open_blocking(cfg))
        .await
        .map_err(|e| e.to_string())??;
    let id = next_session_id("f");
    state.sessions.lock().unwrap().insert(id.clone(), session);
    Ok(id)
}

/// Đóng phiên SFTP.
#[tauri::command]
pub async fn sftp_close(state: State<'_, SftpState>, id: String) -> Result<(), String> {
    let s = state.sessions.lock().unwrap().remove(&id);
    if let Some(s) = s {
        tauri::async_runtime::spawn_blocking(move || {
            let _ = run_cmd(&s, "bye", Duration::from_secs(3));
            let _ = s.child.lock().unwrap().kill();
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Thư mục làm việc hiện tại trên server (để panel bắt đầu ở home).
#[tauri::command]
pub async fn sftp_home(state: State<'_, SftpState>, id: String) -> Result<String, String> {
    let s = session_of(&state, &id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let out = run_cmd(&s, "pwd", Duration::from_secs(15))?;
        // sftp in: "Remote working directory: /home/user"
        for line in out.lines() {
            if let Some(p) = line.split(':').nth(1) {
                let p = p.trim();
                if p.starts_with('/') {
                    return Ok(p.to_string());
                }
            }
        }
        Ok("/".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Resolve + kiểm tra một lệnh `cd`: neo về `cwd` (panel đang xem) rồi `cd <arg>`.
/// Thành công → trả đường dẫn tuyệt đối sau cd; thất bại (thư mục không tồn tại) → Err.
#[tauri::command]
pub async fn sftp_cd(state: State<'_, SftpState>, id: String, cwd: String, arg: String) -> Result<String, String> {
    let s = session_of(&state, &id)?;
    tauri::async_runtime::spawn_blocking(move || {
        // Neo về đúng thư mục panel đang hiển thị (để path tương đối resolve đúng gốc).
        let anchor = run_cmd(&s, &format!("cd {}", q(&cwd)), Duration::from_secs(15))?;
        if let Some(e) = looks_like_error(&anchor) {
            return Err(e);
        }
        // Áp lệnh cd của người dùng — lỗi = thư mục không hợp lệ.
        let out = run_cmd(&s, &format!("cd {}", q(&arg)), Duration::from_secs(15))?;
        if let Some(e) = looks_like_error(&out) {
            return Err(e);
        }
        // Lấy đường dẫn tuyệt đối sau khi cd.
        let pwd = run_cmd(&s, "pwd", Duration::from_secs(15))?;
        for line in pwd.lines() {
            if let Some(p) = line.split(':').nth(1) {
                let p = p.trim();
                if p.starts_with('/') {
                    return Ok(p.to_string());
                }
            }
        }
        Err("Không lấy được thư mục sau cd".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Liệt kê một thư mục (dir trước, bỏ `.`/`..`).
#[tauri::command]
pub async fn sftp_list(state: State<'_, SftpState>, id: String, path: String) -> Result<Vec<Entry>, String> {
    let s = session_of(&state, &id)?;
    tauri::async_runtime::spawn_blocking(move || {
        // Chỉ dùng `ls -la` chuẩn (mọi server đều hiểu) rồi tự định dạng ngày trong Rust.
        // (Không dùng --time-style: tham số đó không đi qua được sftp trên vài server.)
        let out = run_cmd(&s, &format!("ls -la {}", q(&path)), Duration::from_secs(30))?;
        let mut entries = parse_ls(&out);
        if entries.is_empty() {
            if let Some(err) = looks_like_error(&out) {
                return Err(err);
            }
        }
        entries.sort_by(|a, b| {
            let da = a.kind == "dir";
            let db = b.kind == "dir";
            db.cmp(&da).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(entries)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Tên tháng viết tắt (en) → số 1..12.
fn month_num(s: &str) -> Option<u32> {
    const M: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    let l = s.to_lowercase();
    M.iter().position(|m| *m == l).map(|i| i as u32 + 1)
}

/// Năm hiện tại (theo giờ máy) — dùng cho file `ls` chỉ in "Mon DD HH:MM".
fn current_year() -> i32 {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    // Thuật toán civil-from-days (Howard Hinnant).
    let z = secs.div_euclid(86400) + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }) as i32
}

/// Phân tích output `ls -l` kiểu Unix thành danh sách Entry.
pub(crate) fn parse_ls(out: &str) -> Vec<Entry> {
    let mut v = Vec::new();
    for raw in out.lines() {
        let line = raw.trim_end();
        let toks: Vec<&str> = line.split_whitespace().collect();
        if toks.len() < 8 {
            continue; // 7 cột đầu + ít nhất 1 token tên (kiểu --time-style chỉ có 7 cột)
        }
        let perms = toks[0];
        // Dòng entry hợp lệ: cột quyền dài 10, ký tự đầu là loại file.
        let first = perms.chars().next().unwrap_or(' ');
        if perms.len() < 10 || !"dl-bcps".contains(first) {
            continue; // bỏ "total 24" và các dòng lạ
        }
        let size: u64 = toks[4].parse().unwrap_or(0);
        // Cột thời gian kiểu `ls -l`: "Mon DD HH:MM" (file gần đây) hoặc "Mon DD YYYY" (file cũ).
        // Đổi sang `yyyy/mm/dd HH:MM` cho dễ đọc; file cũ không có giờ → "00:00".
        // Chỉ lấy HH:mm (bỏ giây nếu server in kèm).
        let hhmm = |s: &str| s.chars().take(5).collect::<String>();
        let (mtime, name_idx) = if toks[5].contains('/') {
            // Nếu server trả sẵn dạng YYYY/MM/DD (2 token thời gian) thì giữ nguyên.
            (format!("{} {}", toks[5], hhmm(toks[6])), 7)
        } else if let Some(mo) = month_num(toks[5]) {
            let day: u32 = toks[6].parse().unwrap_or(0);
            let t7 = toks.get(7).copied().unwrap_or("");
            let (year, time) = if t7.contains(':') {
                (current_year(), hhmm(t7))
            } else {
                (t7.parse::<i32>().unwrap_or_else(|_| current_year()), "00:00".to_string())
            };
            (format!("{year:04}/{mo:02}/{day:02} {time}"), 8)
        } else {
            (format!("{} {} {}", toks[5], toks[6], toks[7]), 8)
        };
        // Tên = phần sau cột thời gian. Dùng vị trí token trong dòng để giữ nguyên khoảng trắng tên.
        let name_full = match find_nth_token_start(line, name_idx) {
            Some(i) => line[i..].to_string(),
            None => toks[name_idx..].join(" "),
        };
        // `ls -la <path>` (có tham số) in tên đầy đủ "/path/tên" → lấy basename cho cột tên.
        // (Chỉ cắt phần TÊN; đích của symlink giữ nguyên.)
        let (name_raw, link_target) = if first == 'l' {
            match name_full.split_once(" -> ") {
                Some((n, t)) => (n, Some(t.to_string())),
                None => (name_full.as_str(), None),
            }
        } else {
            (name_full.as_str(), None)
        };
        let name = name_raw.trim_end_matches('/').rsplit('/').next().unwrap_or(name_raw).to_string();
        if name.is_empty() || name == "." || name == ".." {
            continue;
        }
        let kind = match first {
            'd' => "dir",
            'l' => "link",
            _ => "file",
        };
        v.push(Entry { name, kind: kind.to_string(), size, mtime, perms: perms.to_string(), link_target });
    }
    v
}

/// Vị trí byte bắt đầu của token thứ `n` (0-based) trong một dòng (tách theo khoảng trắng).
fn find_nth_token_start(line: &str, n: usize) -> Option<usize> {
    let mut idx = 0usize;
    let mut in_tok = false;
    let mut count = 0usize;
    for (i, c) in line.char_indices() {
        let ws = c == ' ' || c == '\t';
        if !ws && !in_tok {
            in_tok = true;
            if count == n {
                idx = i;
                return Some(idx);
            }
            count += 1;
        } else if ws && in_tok {
            in_tok = false;
        }
    }
    let _ = idx;
    None
}

/// Preview cho file quá lớn (không tải nội dung về).
pub(crate) fn preview_toolarge(size: u64) -> Preview {
    Preview { kind: "toolarge".into(), data: String::new(), mime: String::new(), size }
}

/// Phân loại nội dung file tải về cho preview.
pub(crate) fn classify(bytes: &[u8], ext: &str, max: u64) -> Preview {
    let size = bytes.len() as u64;
    let image_mime = match ext {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "svg" => Some("image/svg+xml"),
        "ico" => Some("image/x-icon"),
        _ => None,
    };
    if size > max {
        return Preview { kind: "toolarge".into(), data: String::new(), mime: String::new(), size };
    }
    if let Some(mime) = image_mime {
        let data = base64::engine::general_purpose::STANDARD.encode(bytes);
        return Preview { kind: "image".into(), data, mime: mime.into(), size };
    }
    match std::str::from_utf8(bytes) {
        Ok(txt) => {
            let ctrl = txt.chars().filter(|c| c.is_control() && *c != '\n' && *c != '\r' && *c != '\t').count();
            if ctrl * 20 < txt.chars().count().max(1) {
                Preview { kind: "text".into(), data: txt.to_string(), mime: "text/plain".into(), size }
            } else {
                Preview { kind: "binary".into(), data: String::new(), mime: String::new(), size }
            }
        }
        Err(_) => Preview { kind: "binary".into(), data: String::new(), mime: String::new(), size },
    }
}

/// Tải một file nhỏ về để preview: phân loại text/image/binary; file lớn hơn `max` thì trả "toolarge".
#[tauri::command]
pub async fn sftp_read(state: State<'_, SftpState>, id: String, path: String, max: u64) -> Result<Preview, String> {
    let s = session_of(&state, &id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let tmp = std::env::temp_dir().join(format!("ds-sftp-{}.tmp", next_session_id("p")));
        let tmp_str = tmp.to_string_lossy().to_string();
        let out = run_cmd(&s, &format!("get {} {}", q(&path), q(&tmp_str)), Duration::from_secs(60))?;
        if let Some(err) = looks_like_error(&out) {
            let _ = std::fs::remove_file(&tmp);
            return Err(err);
        }
        let bytes = std::fs::read(&tmp).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&tmp);
        let ext = path.rsplit('.').next().unwrap_or("").to_lowercase();
        Ok(classify(&bytes, &ext, max))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Chạy một lệnh sftp đơn (thao tác file) ngoài main thread, báo lỗi nếu output có dấu hiệu lỗi.
async fn run_op(s: Arc<SftpSession>, line: String, timeout: Duration) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let out = run_cmd(&s, &line, timeout)?;
        match looks_like_error(&out) {
            Some(e) => Err(e),
            None => Ok(()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Tải file/thư mục remote về local. `recursive` = tải cả thư mục (`get -r`).
/// Local do UI chọn: file → save dialog; thư mục → chọn thư mục cha (sftp tạo thư mục con trong đó).
#[tauri::command]
pub async fn sftp_get(
    state: State<'_, SftpState>,
    id: String,
    remote: String,
    local: String,
    recursive: Option<bool>,
) -> Result<(), String> {
    let s = session_of(&state, &id)?;
    let r = if recursive.unwrap_or(false) { "-r " } else { "" };
    // Thư mục lớn có thể lâu — cho 30 phút.
    run_op(s, format!("get {}{} {}", r, q(&remote), q(&local)), Duration::from_secs(1800)).await
}

/// Tải file local lên thư mục remote.
#[tauri::command]
pub async fn sftp_put(state: State<'_, SftpState>, id: String, local: String, remote: String) -> Result<(), String> {
    let s = session_of(&state, &id)?;
    run_op(s, format!("put {} {}", q(&local), q(&remote)), Duration::from_secs(600)).await
}

#[tauri::command]
pub async fn sftp_mkdir(state: State<'_, SftpState>, id: String, path: String) -> Result<(), String> {
    let s = session_of(&state, &id)?;
    run_op(s, format!("mkdir {}", q(&path)), Duration::from_secs(30)).await
}

/// Tạo file rỗng trên remote. sftp.exe không có `touch` → đẩy một file tạm 0 byte lên.
#[tauri::command]
pub async fn sftp_touch(state: State<'_, SftpState>, id: String, path: String) -> Result<(), String> {
    let s = session_of(&state, &id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let tmp = std::env::temp_dir().join(format!("ds-sftp-{}.empty", next_session_id("t")));
        std::fs::write(&tmp, b"").map_err(|e| e.to_string())?;
        let tmp_str = tmp.to_string_lossy().to_string();
        let out = run_cmd(&s, &format!("put {} {}", q(&tmp_str), q(&path)), Duration::from_secs(60))?;
        let _ = std::fs::remove_file(&tmp);
        match looks_like_error(&out) {
            Some(e) => Err(e),
            None => Ok(()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn sftp_rm(state: State<'_, SftpState>, id: String, path: String) -> Result<(), String> {
    let s = session_of(&state, &id)?;
    run_op(s, format!("rm {}", q(&path)), Duration::from_secs(30)).await
}

#[tauri::command]
pub async fn sftp_rmdir(state: State<'_, SftpState>, id: String, path: String) -> Result<(), String> {
    let s = session_of(&state, &id)?;
    run_op(s, format!("rmdir {}", q(&path)), Duration::from_secs(30)).await
}

#[tauri::command]
pub async fn sftp_rename(state: State<'_, SftpState>, id: String, from: String, to: String) -> Result<(), String> {
    let s = session_of(&state, &id)?;
    run_op(s, format!("rename {} {}", q(&from), q(&to)), Duration::from_secs(30)).await
}
