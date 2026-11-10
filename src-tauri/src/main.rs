// Ẩn cửa sổ console khi chạy bản release trên Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// Lệnh mẫu để UI kiểm tra cầu nối Rust ↔ webview.
/// Các module git / http / ssh sẽ đăng ký lệnh của mình vào đây.
#[tauri::command]
fn app_info() -> serde_json::Value {
    serde_json::json!({
        "name": "DevStation",
        "version": env!("CARGO_PKG_VERSION"),
    })
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![app_info])
        .run(tauri::generate_context!())
        .expect("không khởi động được DevStation");
}
