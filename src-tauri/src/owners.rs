//! Gắn mỗi phiên (terminal SSH, thống kê, SFTP, tunnel của DB/Redis, kết nối DB/Redis) với cửa sổ đã mở nó.
//!
//! Mỗi app là một cửa sổ riêng; đóng cửa sổ (nút X) thì webview bị huỷ NGAY — cleanup của React
//! không kịp chạy → phiên phía Rust sẽ sống tới khi tắt hẳn app (vòng lặp thống kê vẫn chạy trên server,
//! phiên ssh/sftp vẫn giữ). Vì vậy Rust tự dọn theo nhãn cửa sổ khi cửa sổ bị huỷ hoặc tải lại trang.

use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Term,
    Stat,
    Sftp,
    Tunnel,
    Db,
    Redis,
    /// Lượt tải image của app Registry (đóng cửa sổ → hủy).
    RegJob,
}

#[derive(Default)]
pub struct Owners(Mutex<HashMap<String, Vec<(Kind, String)>>>);

impl Owners {
    pub fn add(&self, label: &str, kind: Kind, id: &str) {
        let mut m = self.0.lock().unwrap();
        let v = m.entry(label.to_string()).or_default();
        // Phiên đã đóng bình thường vẫn nằm đây (đóng lại là no-op) → chặn danh sách phình vô hạn khi app mở cả ngày.
        if v.len() > 500 {
            v.drain(..250);
        }
        v.push((kind, id.to_string()));
    }

    fn take(&self, label: &str) -> Vec<(Kind, String)> {
        self.0.lock().unwrap().remove(label).unwrap_or_default()
    }
}

/// Ghi nhận phiên `id` thuộc cửa sổ `label`.
pub fn track(app: &AppHandle, label: &str, kind: Kind, id: &str) {
    app.state::<Owners>().add(label, kind, id);
}

/// Đóng mọi phiên của cửa sổ `label` (cửa sổ bị huỷ / trang tải lại).
pub fn cleanup(app: &AppHandle, label: &str) {
    let items = app.state::<Owners>().take(label);
    if items.is_empty() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        for (kind, id) in items {
            match kind {
                Kind::Term => {
                    let _ = crate::ssh::ssh_disconnect(app.state(), id);
                }
                Kind::Stat => {
                    let _ = crate::ssh::ssh_stat_stop(app.state(), id);
                }
                Kind::Tunnel => {
                    let _ = crate::ssh::ssh_tunnel_close(app.state(), id);
                }
                Kind::Sftp => {
                    let _ = crate::sftp::sftp_close(app.state(), id).await;
                }
                Kind::Db => {
                    let _ = crate::db::db_disconnect(app.state(), id).await;
                }
                Kind::RegJob => {
                    let _ = crate::registry::registry_cancel(app.state(), id);
                }
                Kind::Redis => {
                    let _ = crate::redis::redis_disconnect(app.state(), id).await;
                }
            }
        }
    });
}
