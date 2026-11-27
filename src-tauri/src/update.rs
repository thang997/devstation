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
pub fn install_on_exit(state: &UpdState) {
    let Some((update, bytes)) = state.inner.lock().ok().and_then(|mut i| i.ready.take()) else { return };
    let _ = update.restart_after_install(false).install(&bytes);
}
