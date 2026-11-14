//! App HTTP client: gửi request thật bằng `reqwest` phía Rust.
//!
//! Chạy ở Rust nên KHÔNG dính CORS (khác với gọi fetch trong webview) và dùng lại được
//! chứng chỉ hệ thống. Việc tách curl làm ở phía UI; ở đây chỉ nhận request đã dựng sẵn.

use std::path::Path;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// Một header do UI gửi xuống (đã lọc bỏ dòng tắt/rỗng).
#[derive(Deserialize)]
pub struct HeaderKV {
    name: String,
    value: String,
}

#[derive(Deserialize)]
pub struct HttpReq {
    method: String,
    url: String,
    headers: Vec<HeaderKV>,
    /// Thân request (đã thay {{var}} ở UI); None/"" = không gửi thân.
    body: Option<String>,
    /// Bỏ qua kiểm tra chứng chỉ TLS (repo/dev self-signed). Mặc định false.
    insecure: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResp {
    status: u16,
    status_text: String,
    headers: Vec<(String, String)>,
    /// Thân phản hồi dạng văn bản (UTF-8 lossy), có thể bị cắt nếu quá lớn.
    body: String,
    /// Kích thước thật của thân (byte), kể cả khi `body` bị cắt.
    body_bytes: usize,
    time_ms: u128,
    truncated: bool,
}

/// Giới hạn thân trả về để không nuốt cả trăm MB vào webview.
const MAX_BODY: usize = 8 * 1024 * 1024;

#[tauri::command]
pub async fn http_send(req: HttpReq) -> Result<HttpResp, String> {
    let mut url = req.url.trim().to_string();
    if url.is_empty() {
        return Err("URL trống".into());
    }
    // Thiếu scheme thì mặc định https (giống thanh địa chỉ trình duyệt).
    if !url.contains("://") {
        url = format!("https://{url}");
    }

    let method = reqwest::Method::from_bytes(req.method.trim().to_uppercase().as_bytes())
        .map_err(|_| format!("Method không hợp lệ: {}", req.method))?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .danger_accept_invalid_certs(req.insecure)
        .user_agent(concat!("DevStation/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;

    let mut rb = client.request(method, &url);
    for h in &req.headers {
        let name = h.name.trim();
        if name.is_empty() {
            continue;
        }
        let hn = reqwest::header::HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| format!("Tên header không hợp lệ: {name}"))?;
        let hv = reqwest::header::HeaderValue::from_str(&h.value)
            .map_err(|_| format!("Giá trị header không hợp lệ cho “{name}”"))?;
        rb = rb.header(hn, hv);
    }
    if let Some(b) = &req.body {
        if !b.is_empty() {
            rb = rb.body(b.clone());
        }
    }

    let t0 = Instant::now();
    let resp = rb.send().await.map_err(friendly)?;

    let status = resp.status();
    let status_text = status.canonical_reason().unwrap_or("").to_string();
    let headers: Vec<(String, String)> = resp
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();

    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    let time_ms = t0.elapsed().as_millis();
    let total = bytes.len();
    let truncated = total > MAX_BODY;
    let slice = if truncated { &bytes[..MAX_BODY] } else { &bytes[..] };
    let body = String::from_utf8_lossy(slice).into_owned();

    Ok(HttpResp {
        status: status.as_u16(),
        status_text,
        headers,
        body,
        body_bytes: total,
        time_ms,
        truncated,
    })
}

/* ── Import collections: đọc file / thư mục chứa lệnh curl ── */

#[derive(Serialize)]
pub struct ImportedFile {
    /// Đường dẫn tương đối so với thư mục đã chọn (dùng dấu `/`).
    name: String,
    content: String,
}

/// Giới hạn mỗi file khi import (file lệnh thường rất nhỏ).
const MAX_IMPORT_FILE: u64 = 512 * 1024;

/// Đọc nội dung một file văn bản (để tách lệnh curl ở phía UI).
#[tauri::command]
pub async fn http_read_file(path: String) -> Result<String, String> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_IMPORT_FILE * 8 {
        return Err("File quá lớn để import".into());
    }
    let data = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&data).into_owned())
}

/// Chỉ nhận các file dạng văn bản hay chứa lệnh (và file không có đuôi — nhiều file curl không đuôi).
fn is_textlike(p: &Path) -> bool {
    match p.extension().and_then(|e| e.to_str()).map(|s| s.to_ascii_lowercase()).as_deref() {
        Some("sh" | "bash" | "txt" | "curl" | "http" | "rest" | "cmd" | "ps1" | "text" | "md") => true,
        None => true,
        _ => false,
    }
}

/// Duyệt một thư mục (sâu tối đa 4 cấp), trả về nội dung các file văn bản để UI tách lệnh.
#[tauri::command]
pub async fn http_read_dir(dir: String) -> Result<Vec<ImportedFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = std::path::PathBuf::from(&dir);
        let mut out: Vec<ImportedFile> = Vec::new();

        fn walk(base: &Path, p: &Path, depth: u32, out: &mut Vec<ImportedFile>) {
            if out.len() >= 1000 {
                return;
            }
            let Ok(rd) = std::fs::read_dir(p) else { return };
            let mut entries: Vec<_> = rd.flatten().map(|e| e.path()).collect();
            entries.sort();
            for path in entries {
                if out.len() >= 1000 {
                    break;
                }
                if path.is_dir() {
                    let n = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    if n.starts_with('.') || matches!(n, "node_modules" | "target" | "vendor") {
                        continue;
                    }
                    if depth > 0 {
                        walk(base, &path, depth - 1, out);
                    }
                } else if is_textlike(&path) {
                    if std::fs::metadata(&path).map(|m| m.len() > MAX_IMPORT_FILE).unwrap_or(true) {
                        continue;
                    }
                    if let Ok(bytes) = std::fs::read(&path) {
                        // Bỏ file nhị phân (không phải UTF-8 hợp lệ).
                        if std::str::from_utf8(&bytes).is_ok() {
                            let rel = path.strip_prefix(base).unwrap_or(&path).to_string_lossy().replace('\\', "/");
                            out.push(ImportedFile { name: rel, content: String::from_utf8_lossy(&bytes).into_owned() });
                        }
                    }
                }
            }
        }

        walk(&base, &base, 4, &mut out);
        out
    })
    .await
    .map_err(|e| e.to_string())
}

/// Thông báo lỗi dễ hiểu cho các trường hợp hay gặp.
fn friendly(e: reqwest::Error) -> String {
    if e.is_timeout() {
        return "Hết thời gian chờ (quá 30 giây)".into();
    }
    if e.is_connect() {
        return format!("Không kết nối được tới máy chủ: {e}");
    }
    if e.is_builder() {
        return format!("URL không hợp lệ: {e}");
    }
    e.to_string()
}
