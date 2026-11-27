//! App Editor (soạn thảo kiểu Notepad++): đọc / ghi file kèm nhận encoding, bản nháp tab chưa lưu (giữ qua lần tắt app),
//! hàng đợi file mở từ Explorer, đăng ký + đặt Editor làm app mặc định cho từng đuôi file (giống app PDF).

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
pub struct EditorState {
    pending: Mutex<Vec<String>>,
}

/// File lớn hơn mức này không mở (CodeMirror vẫn chạy nhưng WebView tốn RAM gấp nhiều lần dung lượng file).
const MAX_OPEN: u64 = 50 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFile {
    text: String,
    encoding: &'static str,
    bom: bool,
    eol: &'static str,
    size: u64,
    lossy: bool,
}

/// Nhận encoding: BOM (UTF-8 / UTF-16 LE / BE) → UTF-8 hợp lệ → không thì Windows-1252 (byte nào cũng giải mã được,
/// chữ có dấu có thể sai — `lossy` báo để hỏi trước khi lưu đè).
fn decode(bytes: &[u8]) -> (String, &'static str, bool, bool) {
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        let (s, _, bad) = encoding_rs::UTF_8.decode(rest);
        return (s.into_owned(), "utf-8", true, bad);
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        let (s, bad) = encoding_rs::UTF_16LE.decode_without_bom_handling(rest);
        return (s.into_owned(), "utf-16le", true, bad);
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        let (s, bad) = encoding_rs::UTF_16BE.decode_without_bom_handling(rest);
        return (s.into_owned(), "utf-16be", true, bad);
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => (s.to_string(), "utf-8", false, false),
        Err(_) => {
            // Không phải UTF-8: đọc bằng Windows-1252 (không bao giờ lỗi) nhưng có thể sai chữ / là file nhị phân → lossy.
            let (s, _, _) = encoding_rs::WINDOWS_1252.decode(bytes);
            (s.into_owned(), "windows-1252", false, true)
        }
    }
}

fn eol_of(text: &str) -> &'static str {
    let crlf = text.matches("\r\n").count();
    let lf = text.matches('\n').count() - crlf;
    if crlf >= lf && crlf > 0 { "\r\n" } else if lf > 0 { "\n" } else { "\r\n" }
}

#[tauri::command]
pub async fn editor_read(path: String) -> Result<ReadFile, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
        if meta.is_dir() {
            return Err("Là thư mục, không phải file".into());
        }
        if meta.len() > MAX_OPEN {
            return Err(format!("File quá lớn ({} MB, tối đa {} MB)", meta.len() / 1048576, MAX_OPEN / 1048576));
        }
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        let (text, encoding, bom, lossy) = decode(&bytes);
        let eol = eol_of(&text);
        Ok(ReadFile { text, encoding, bom, eol, size: meta.len(), lossy })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Ghi file theo encoding (+ BOM). Ghi ra file tạm cạnh đích rồi đổi tên → mất điện / lỗi giữa chừng không làm hỏng file.
#[tauri::command]
pub async fn editor_write(path: String, text: String, encoding: String, bom: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut out: Vec<u8> = Vec::with_capacity(text.len() + 4);
        match encoding.as_str() {
            "utf-16le" => {
                out.extend_from_slice(&[0xFF, 0xFE]);
                for u in text.encode_utf16() {
                    out.extend_from_slice(&u.to_le_bytes());
                }
            }
            "utf-16be" => {
                out.extend_from_slice(&[0xFE, 0xFF]);
                for u in text.encode_utf16() {
                    out.extend_from_slice(&u.to_be_bytes());
                }
            }
            "windows-1252" => {
                let (b, _, bad) = encoding_rs::WINDOWS_1252.encode(&text);
                if bad {
                    return Err("Có ký tự không lưu được bằng Windows-1252 — đổi encoding sang UTF-8 rồi lưu lại".into());
                }
                out.extend_from_slice(&b);
            }
            _ => {
                if bom {
                    out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
                }
                out.extend_from_slice(text.as_bytes());
            }
        }
        let dest = std::path::Path::new(&path);
        let tmp = dest.with_file_name(format!(".{}.ds-tmp", dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()));
        std::fs::write(&tmp, &out).map_err(|e| e.to_string())?;
        // Giữ thuộc tính chỉ-đọc: rename đè lên file read-only sẽ lỗi → báo rõ.
        if let Err(e) = std::fs::rename(&tmp, dest) {
            let _ = std::fs::remove_file(&tmp);
            return Err(e.to_string());
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/* ── Bản nháp tab chưa lưu ── */

/// Bản dev dùng thư mục riêng: danh sách tab (localStorage) của bản dev và bản cài khác nhau (khác origin) → dùng chung
/// thư mục thì bước dọn nháp của bản này xoá nhầm nháp của bản kia.
fn drafts_dir() -> std::path::PathBuf {
    crate::pdf::data_dir().join(if cfg!(debug_assertions) { "editor-session-dev" } else { "editor-session" })
}
/// Id do UI sinh ("e…"): chỉ cho chữ/số để không ghi ra ngoài thư mục bản nháp.
fn draft_path(id: &str) -> Result<std::path::PathBuf, String> {
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("id bản nháp không hợp lệ".into());
    }
    Ok(drafts_dir().join(format!("{id}.txt")))
}

#[tauri::command]
pub async fn editor_draft_put(id: String, text: String) -> Result<(), String> {
    let p = draft_path(&id)?;
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(drafts_dir()).map_err(|e| e.to_string())?;
        let tmp = p.with_extension("tmp");
        std::fs::write(&tmp, text.as_bytes()).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn editor_draft_get(id: String) -> Result<Option<String>, String> {
    let p = draft_path(&id)?;
    Ok(std::fs::read(&p).ok().map(|b| String::from_utf8_lossy(&b).into_owned()))
}

#[tauri::command]
pub fn editor_draft_del(id: String) -> Result<(), String> {
    let _ = std::fs::remove_file(draft_path(&id)?);
    Ok(())
}

/// Xoá bản nháp không còn tab nào dùng (lúc mở lại phiên) — CHỈ file không đổi > 1 ngày: lỡ danh sách phiên bị hỏng /
/// ghi thiếu thì bản nháp vẫn còn một ngày để cứu, không mất ngay.
#[tauri::command]
pub fn editor_draft_gc(keep: Vec<String>) {
    let Ok(rd) = std::fs::read_dir(drafts_dir()) else { return };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let id = name.trim_end_matches(".txt").trim_end_matches(".tmp");
        let old = e.metadata().ok().and_then(|m| m.modified().ok()).and_then(|t| t.elapsed().ok()).is_some_and(|d| d.as_secs() > 86_400);
        if old && !keep.iter().any(|k| k == id) {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/* ── File mở từ Explorer ── */

/// Tham số dòng lệnh là file có thật, KHÔNG phải .pdf (app PDF lo) và không phải file tạm chọn app mặc định.
pub fn file_args<I: IntoIterator<Item = String>>(args: I, cwd: Option<&std::path::Path>) -> Vec<String> {
    args.into_iter()
        .filter(|a| !a.starts_with('-') && !a.to_ascii_lowercase().ends_with(".pdf") && !crate::pdf::is_chooser_file(a))
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

pub fn queue(app: &AppHandle, files: Vec<String>) {
    app.state::<EditorState>().pending.lock().unwrap().extend(files);
}

/// Tiến trình thứ hai (double-click file khi app đang chạy): xếp hàng + báo một cửa sổ (ưu tiên cửa sổ Editor) — KHÔNG
/// đưa cửa sổ đó lên trước (có thể đang là app khác); JS mở / đưa cửa sổ Editor lên (`fileOpen.ts`).
pub fn open_from_explorer(app: &AppHandle, files: Vec<String>) {
    queue(app, files);
    let wins = app.webview_windows();
    let target = ["app-editor", "main"]
        .iter()
        .find_map(|l| wins.get(*l).cloned())
        .or_else(|| wins.values().find(|w| !w.label().starts_with("webtr-")).cloned());
    if let Some(w) = target {
        let _ = app.emit_to(w.label(), "editor-open-request", ());
    }
}

#[tauri::command]
pub fn editor_has_pending(state: State<'_, EditorState>) -> bool {
    !state.pending.lock().unwrap().is_empty()
}

#[tauri::command]
pub fn editor_take_pending(state: State<'_, EditorState>) -> Vec<String> {
    std::mem::take(&mut *state.pending.lock().unwrap())
}

/* ── App mặc định cho file văn bản (giống app PDF: đăng ký + OpenWith.exe, người dùng chọn) ── */

/// Đuôi file hiện trong thẻ "App mặc định" của Editor.
pub const TEXT_EXTS: &[&str] = &[
    ".txt", ".log", ".json", ".xml", ".yaml", ".yml", ".ini", ".conf", ".cfg", ".env", ".properties", ".toml", ".md", ".csv",
    ".js", ".ts", ".sql", ".sh", ".ps1", ".html", ".css",
];
const PROGID: &str = "DevStation.Text";
const OPT_OUT: &str = "TextUnregistered";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtStatus {
    ext: String,
    is_default: bool,
    /// Tên exe đang mở đuôi này (notepad.exe, Code.exe…), rỗng nếu chưa có.
    current: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextDefaultStatus {
    supported: bool,
    registered: bool,
    dev: bool,
    exts: Vec<ExtStatus>,
}

#[cfg(windows)]
fn write_registration(exe: &str) -> Result<(), String> {
    use crate::pdf::winreg::{notify, set};
    let open = format!("\"{exe}\" \"%1\"");
    set(&format!("Software\\Classes\\{PROGID}"), None, "Text Document")?;
    set(&format!("Software\\Classes\\{PROGID}"), Some("FriendlyTypeName"), "Text Document")?;
    set(&format!("Software\\Classes\\{PROGID}\\DefaultIcon"), None, &format!("\"{exe}\",0"))?;
    set(&format!("Software\\Classes\\{PROGID}\\Application"), Some("ApplicationName"), "DevStation")?;
    set(&format!("Software\\Classes\\{PROGID}\\shell\\open\\command"), None, &open)?;
    let exe_name = std::path::Path::new(exe).file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "devstation.exe".into());
    set(&format!("Software\\Classes\\Applications\\{exe_name}"), Some("FriendlyAppName"), "DevStation")?;
    set(&format!("Software\\Classes\\Applications\\{exe_name}\\shell\\open\\command"), None, &open)?;
    set("Software\\DevStation\\Capabilities", Some("ApplicationName"), "DevStation")?;
    set("Software\\DevStation\\Capabilities", Some("ApplicationDescription"), "DevStation — PDF viewer, text editor")?;
    for ext in TEXT_EXTS {
        set(&format!("Software\\Classes\\{ext}\\OpenWithProgids"), Some(PROGID), "")?;
        set(&format!("Software\\Classes\\Applications\\{exe_name}\\SupportedTypes"), Some(ext), "")?;
        set("Software\\DevStation\\Capabilities\\FileAssociations", Some(ext), PROGID)?;
    }
    set("Software\\RegisteredApplications", Some("DevStation"), "Software\\DevStation\\Capabilities")?;
    notify();
    Ok(())
}

/// Bản cài, lúc khởi động: thiếu đăng ký / trỏ exe khác → ghi lại (người dùng đã "Gỡ đăng ký" thì thôi).
#[cfg(all(windows, not(debug_assertions)))]
pub fn ensure_registered() {
    use crate::pdf::winreg::get;
    let Ok(exe) = crate::pdf::exe_path() else { return };
    if get("Software\\DevStation", Some(OPT_OUT)).as_deref() == Some("1") {
        return;
    }
    let want = format!("\"{exe}\" \"%1\"");
    let ok = get(&format!("Software\\Classes\\{PROGID}\\shell\\open\\command"), None).is_some_and(|c| c.eq_ignore_ascii_case(&want))
        && get("Software\\RegisteredApplications", Some("DevStation")).is_some()
        && TEXT_EXTS.iter().all(|e| get("Software\\DevStation\\Capabilities\\FileAssociations", Some(e)).is_some());
    if !ok {
        let _ = write_registration(&exe);
    }
}

#[tauri::command]
pub fn editor_default_status() -> TextDefaultStatus {
    #[cfg(windows)]
    {
        use crate::pdf::winreg::{default_exe_for, get};
        let exe = crate::pdf::exe_path().unwrap_or_default();
        let registered = get(&format!("Software\\Classes\\{PROGID}\\shell\\open\\command"), None)
            .is_some_and(|c| c.to_ascii_lowercase().contains(&exe.to_ascii_lowercase()));
        let exts = TEXT_EXTS
            .iter()
            .map(|e| {
                // Chưa có app nào: Windows trả về chính hộp thoại chọn app (OpenWith.exe) → coi là trống.
                let cur = default_exe_for(e).filter(|p| !p.to_ascii_lowercase().ends_with("\\openwith.exe")).unwrap_or_default();
                ExtStatus {
                    ext: e.to_string(),
                    is_default: !cur.is_empty() && cur.eq_ignore_ascii_case(&exe),
                    current: std::path::Path::new(&cur).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                }
            })
            .collect();
        TextDefaultStatus { supported: true, registered, dev: cfg!(debug_assertions), exts }
    }
    #[cfg(not(windows))]
    TextDefaultStatus { supported: false, registered: false, dev: cfg!(debug_assertions), exts: vec![] }
}

/// Đặt Editor làm app mặc định cho `ext`: ghi đăng ký rồi mở hộp thoại Windows (OpenWith.exe) cho file tạm
/// `DevStation-default-app<ext>` — chọn xong Windows mở file đó bằng DevStation → bị bỏ qua (`is_chooser_file`).
#[tauri::command]
pub async fn editor_register_default(ext: String) -> Result<TextDefaultStatus, String> {
    #[cfg(windows)]
    {
        if !TEXT_EXTS.contains(&ext.as_str()) {
            return Err(format!("Đuôi không hỗ trợ: {ext}"));
        }
        let exe = crate::pdf::exe_path()?;
        write_registration(&exe)?;
        crate::pdf::winreg::del_value("Software\\DevStation", OPT_OUT);
        let p = std::env::temp_dir().join(format!("{}{ext}", crate::pdf::CHOOSER_STEM));
        if !p.is_file() {
            std::fs::write(&p, b"").map_err(|e| e.to_string())?;
        }
        crate::pdf::open_with_dialog(p.to_string_lossy().into_owned()).await?;
        Ok(editor_default_status())
    }
    #[cfg(not(windows))]
    {
        let _ = ext;
        Err("Chỉ hỗ trợ trên Windows".into())
    }
}

/// Gỡ đăng ký Editor (chỉ phần của Editor; Capabilities dùng chung với app PDF).
#[tauri::command]
pub fn editor_unregister_default() -> Result<(), String> {
    #[cfg(windows)]
    {
        use crate::pdf::winreg::{del_tree, del_value, has_values, notify, set};
        let exe = crate::pdf::exe_path()?;
        let exe_name = std::path::Path::new(&exe).file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "devstation.exe".into());
        del_tree(&format!("Software\\Classes\\{PROGID}"));
        for ext in TEXT_EXTS {
            del_value(&format!("Software\\Classes\\{ext}\\OpenWithProgids"), PROGID);
            del_value(&format!("Software\\Classes\\Applications\\{exe_name}\\SupportedTypes"), ext);
            del_value("Software\\DevStation\\Capabilities\\FileAssociations", ext);
        }
        if !has_values("Software\\DevStation\\Capabilities\\FileAssociations") {
            del_tree(&format!("Software\\Classes\\Applications\\{exe_name}"));
            del_tree("Software\\DevStation\\Capabilities");
            del_value("Software\\RegisteredApplications", "DevStation");
        }
        let _ = set("Software\\DevStation", Some(OPT_OUT), "1");
        notify();
        Ok(())
    }
    #[cfg(not(windows))]
    Err("Chỉ hỗ trợ trên Windows".into())
}
