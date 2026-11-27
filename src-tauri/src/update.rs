//! Tự cập nhật, giữ bản đã tải ở phía Rust (tauri-plugin-updater API Rust).
//!
//! Trước đây tải bằng API JS của plugin → byte bản mới nằm trong tài nguyên của CỬA SỔ main: chọn "Muộn hơn" rồi tắt
//! app là mất, lần mở sau phải tải lại và hỏi lại. Giờ:
//! - `update_check` (chỉ cửa sổ main gọi định kỳ / người dùng bấm): kiểm tra latest.json → có bản mới thì tải ngầm
//!   (kiểm chữ ký) → giữ trong `UpdState`; phát `ds-update` tới MỌI cửa sổ (cửa sổ nào cũng hiện nút `⬇ vX`).
//! - `update_install`: "Khởi động lại ngay" → cài (NSIS quiet) + mở lại app.
//! - `install_on_exit` (RunEvent::Exit): đã tải mà người dùng chọn "Muộn hơn" → tắt hẳn app là cài luôn, KHÔNG mở lại
//!   app (người dùng vừa tắt) → lần mở sau là bản mới.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
pub struct UpdState {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    /// Đang tải bản này (version) — không kiểm tra/tải lại song song.
    downloading: Option<UpdInfo>,
    done: u64,
    total: u64,
    /// Bản đã tải xong, chờ cài.
    ready: Option<(Update, Vec<u8>)>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdInfo {
    version: String,
    current_version: String,
    body: Option<String>,
}

/// Trạng thái cho UI: `phase` = idle | downloading | ready.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdStatus {
    phase: &'static str,
    info: Option<UpdInfo>,
    done: u64,
    total: u64,
}

fn info_of(u: &Update) -> UpdInfo {
    UpdInfo { version: u.version.clone(), current_version: u.current_version.clone(), body: u.body.clone() }
}

fn status_of(i: &Inner) -> UpdStatus {
    if let Some((u, _)) = &i.ready {
        return UpdStatus { phase: "ready", info: Some(info_of(u)), done: i.total, total: i.total };
    }
    if let Some(info) = &i.downloading {
        return UpdStatus { phase: "downloading", info: Some(info.clone()), done: i.done, total: i.total };
    }
    UpdStatus { phase: "idle", info: None, done: 0, total: 0 }
}

#[tauri::command]
pub fn update_status(state: State<'_, UpdState>) -> UpdStatus {
    status_of(&state.inner.lock().unwrap())
}

/// Kiểm tra + tải ngầm. Trả trạng thái sau cùng (idle = đã là bản mới nhất). Lỗi mạng trả Err (UI tự kiểm tra thì im lặng).
#[tauri::command]
pub async fn update_check(app: AppHandle, state: State<'_, UpdState>) -> Result<UpdStatus, String> {
    {
        let i = state.inner.lock().unwrap();
        if i.ready.is_some() || i.downloading.is_some() {
            return Ok(status_of(&i));
        }
    }
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    let Some(update) = update else {
        return Ok(status_of(&state.inner.lock().unwrap()));
    };
    {
        let mut i = state.inner.lock().unwrap();
        i.downloading = Some(info_of(&update));
        i.done = 0;
        i.total = 0;
    }
    let _ = app.emit("ds-update", status_of(&state.inner.lock().unwrap()));
    let res = update
        .download(
            |chunk, total| {
                let mut i = state.inner.lock().unwrap();
                i.done += chunk as u64;
                if let Some(t) = total {
                    i.total = t;
                }
            },
            || {},
        )
        .await;
    let st = {
        let mut i = state.inner.lock().unwrap();
        i.downloading = None;
        match res {
            Ok(bytes) => i.ready = Some((update, bytes)),
            Err(e) => {
                drop(i);
                let _ = app.emit("ds-update", status_of(&state.inner.lock().unwrap()));
                return Err(e.to_string());
            }
        }
        status_of(&i)
    };
    let _ = app.emit("ds-update", st.clone());
    Ok(st)
}

/// "Khởi động lại ngay": cài bản đã tải rồi mở lại app (Windows: trình cài NSIS quiet tự mở lại; app thoát ngay).
#[tauri::command]
pub fn update_install(app: AppHandle, state: State<'_, UpdState>) -> Result<(), String> {
    let Some((update, bytes)) = state.inner.lock().unwrap().ready.take() else {
        return Err("Chưa có bản cập nhật đã tải".into());
    };
    update.restart_after_install(true).install(&bytes).map_err(|e| e.to_string())?;
    // macOS / Linux: install xong thì tự khởi động lại (Windows không tới đây — install() đã thoát tiến trình).
    app.restart();
}

/// Tắt hẳn app (RunEvent::Exit) khi đã có bản tải sẵn (người dùng chọn "Muộn hơn") → cài luôn, KHÔNG mở lại app.
/// Ghi mốc `update-installing` (version đang cài) để lần mở lại TRONG LÚC trình cài còn chạy biết mà chờ
/// (`defer_if_installing`).
pub fn install_on_exit(state: &UpdState) {
    let Some((update, bytes)) = state.inner.lock().ok().and_then(|mut i| i.ready.take()) else { return };
    #[cfg(windows)]
    {
        let m = install_marker();
        if let Some(d) = m.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let _ = std::fs::write(&m, &update.version);
    }
    let _ = update.restart_after_install(false).install(&bytes);
}

#[cfg(windows)]
fn install_marker() -> std::path::PathBuf {
    crate::pdf::data_dir().join("update-installing")
}

/// Mở lại app khi trình cài cập nhật (chạy ngầm sau khi tắt app) CHƯA xong. Nếu cứ mở bản cũ thì trình cài
/// (Restart Manager) kill nó rồi tự mở lại → người dùng thấy cửa sổ nháy tắt rồi bật. Gọi ĐẦU TIÊN trong `main`,
/// trước khi tạo cửa sổ: còn đang cài → giao cho một PowerShell ẩn chờ trình cài xong rồi mở bản mới (cùng tham số
/// dòng lệnh, vd. file .pdf); tiến trình này thoát ngay, không hiện cửa sổ nào.
#[cfg(all(windows, not(debug_assertions)))]
pub fn defer_if_installing() {
    use std::os::windows::process::CommandExt;
    use std::time::Duration;
    let m = install_marker();
    let Ok(meta) = std::fs::metadata(&m) else { return };
    let ver = std::fs::read_to_string(&m).unwrap_or_default();
    let age = meta.modified().ok().and_then(|t| t.elapsed().ok()).unwrap_or(Duration::MAX);
    // Đã là bản vừa cài (cài xong) hoặc mốc quá cũ (trình cài lỗi / bị huỷ) → bỏ mốc, mở bình thường.
    if ver.trim() == env!("CARGO_PKG_VERSION") || age > Duration::from_secs(600) {
        let _ = std::fs::remove_file(&m);
        return;
    }
    let Ok(exe) = std::env::current_exe() else { return };
    // Chuỗi PowerShell trong nháy đơn: ' → ''.
    let q = |s: &str| format!("'{}'", s.replace('\'', "''"));
    let args: Vec<String> =
        std::env::args_os().skip(1).map(|a| q(&format!("\"{}\"", a.to_string_lossy()))).collect();
    let start = if args.is_empty() {
        format!("Start-Process -FilePath {}", q(&exe.to_string_lossy()))
    } else {
        format!("Start-Process -FilePath {} -ArgumentList @({})", q(&exe.to_string_lossy()), args.join(","))
    };
    // Trình cài của tauri-plugin-updater tên `<app>-<version>-installer.exe` (thư mục tạm). Chờ nó xuất hiện tối đa 5s
    // (vừa tắt app xong mở lại ngay), rồi chờ nó chạy xong (tối đa 5 phút); bỏ mốc trước khi mở để không lặp lại.
    let script = format!(
        "$f={{@(Get-Process -EA 0 | ? {{ $_.Name -like 'devstation-*-installer' }}).Count -gt 0}}; \
         $d=(Get-Date).AddSeconds(5); while(-not (& $f) -and (Get-Date) -lt $d){{Start-Sleep -m 150}}; \
         $d=(Get-Date).AddMinutes(5); while((& $f) -and (Get-Date) -lt $d){{Start-Sleep -m 150}}; \
         Remove-Item -LiteralPath {} -EA 0; {}",
        q(&m.to_string_lossy()),
        start
    );
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let ok = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &script])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .is_ok();
    if ok {
        std::process::exit(0);
    }
    let _ = std::fs::remove_file(&m);
}
