//! App Redis: duyệt key (SCAN), xem giá trị theo kiểu dữ liệu, xoá key, xem INFO.
//!
//! Dùng `ConnectionManager` — tự kết nối lại khi mất mạng, phù hợp app mở cả ngày.
//! Mỗi lệnh đọc đều CHẶN số lượng (SCAN COUNT, LRANGE 0..199...) để không kéo cả DB về.

use std::collections::HashMap;
use std::sync::Mutex;

use redis::aio::ConnectionManager;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisConfig {
    #[serde(default)]
    host: String,
    port: Option<u16>,
    #[serde(default)]
    password: String,
    db: Option<i64>,
    #[serde(default)]
    tls: bool,
}

#[derive(Default)]
pub struct RedisState {
    conns: Mutex<HashMap<String, ConnectionManager>>,
    next: Mutex<u64>,
}

/// Mã hoá ký tự đặc biệt trong mật khẩu để nhét vào URL.
fn pct(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn url(cfg: &RedisConfig) -> String {
    let host = if cfg.host.is_empty() { "127.0.0.1" } else { &cfg.host };
    let auth = if cfg.password.is_empty() {
        String::new()
    } else {
        format!(":{}@", pct(&cfg.password))
    };
    format!(
        "{}://{}{}:{}/{}",
        if cfg.tls { "rediss" } else { "redis" },
        auth,
        host,
        cfg.port.unwrap_or(6379),
        cfg.db.unwrap_or(0)
    )
}

fn get(state: &RedisState, id: &str) -> Result<ConnectionManager, String> {
    state
        .conns
        .lock()
        .unwrap()
        .get(id)
        .cloned()
        .ok_or_else(|| "Kết nối đã đóng, hãy kết nối lại".to_string())
}

#[tauri::command]
pub async fn redis_connect(state: State<'_, RedisState>, cfg: RedisConfig) -> Result<String, String> {
    let client = redis::Client::open(url(&cfg)).map_err(|e| e.to_string())?;
    let mut conn = client.get_connection_manager().await.map_err(|e| e.to_string())?;
    // PING để biết sai mật khẩu / sai host ngay, thay vì lỗi mơ hồ ở lệnh đầu tiên.
    let _: String = redis::cmd("PING").query_async(&mut conn).await.map_err(|e| e.to_string())?;
    let id = {
        let mut n = state.next.lock().unwrap();
        *n += 1;
        format!("r{}", *n)
    };
    state.conns.lock().unwrap().insert(id.clone(), conn);
    Ok(id)
}

#[tauri::command]
pub async fn redis_disconnect(state: State<'_, RedisState>, id: String) -> Result<(), String> {
    state.conns.lock().unwrap().remove(&id);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeysPage {
    /// 0 = đã hết.
    cursor: u64,
    keys: Vec<String>,
}

#[tauri::command]
pub async fn redis_scan(
    state: State<'_, RedisState>,
    id: String,
    cursor: u64,
    pattern: String,
    count: u32,
) -> Result<KeysPage, String> {
    let mut conn = get(&state, &id)?;
    let pattern = if pattern.trim().is_empty() { "*".to_string() } else { pattern };
    let (next, keys): (String, Vec<String>) = redis::cmd("SCAN")
        .arg(cursor)
        .arg("MATCH")
        .arg(&pattern)
        .arg("COUNT")
        .arg(count.max(1))
        .query_async(&mut conn)
        .await
        .map_err(|e| e.to_string())?;
    Ok(KeysPage { cursor: next.parse().unwrap_or(0), keys })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyDetail {
    key: String,
    /// string | list | set | zset | hash | stream | none | …
    kind: String,
    /// -1 = không hết hạn, -2 = key không tồn tại.
    ttl: i64,
    /// Số phần tử (độ dài chuỗi, số field, ...).
    size: i64,
    columns: Vec<String>,
    rows: Vec<Vec<String>>,
    /// Với kiểu string: nội dung. Kiểu khác: null.
    text: Option<String>,
}

const PAGE: i64 = 200;

#[tauri::command]
pub async fn redis_key(state: State<'_, RedisState>, id: String, key: String) -> Result<KeyDetail, String> {
    let mut conn = get(&state, &id)?;
    let kind: String = redis::cmd("TYPE").arg(&key).query_async(&mut conn).await.map_err(|e| e.to_string())?;
    let ttl: i64 = redis::cmd("TTL").arg(&key).query_async(&mut conn).await.map_err(|e| e.to_string())?;
    let err = |e: redis::RedisError| e.to_string();

    let mut d = KeyDetail {
        key: key.clone(),
        kind: kind.clone(),
        ttl,
        size: 0,
        columns: vec![],
        rows: vec![],
        text: None,
    };

    match kind.as_str() {
        "string" => {
            d.size = redis::cmd("STRLEN").arg(&key).query_async(&mut conn).await.map_err(err)?;
            d.text = Some(redis::cmd("GET").arg(&key).query_async(&mut conn).await.map_err(err)?);
        }
        "hash" => {
            let map: HashMap<String, String> = redis::cmd("HGETALL").arg(&key).query_async(&mut conn).await.map_err(err)?;
            d.size = map.len() as i64;
            let mut items: Vec<(String, String)> = map.into_iter().collect();
            items.sort_by(|a, b| a.0.cmp(&b.0));
            d.columns = vec!["field".into(), "value".into()];
            d.rows = items.into_iter().map(|(f, v)| vec![f, v]).collect();
        }
        "list" => {
            d.size = redis::cmd("LLEN").arg(&key).query_async(&mut conn).await.map_err(err)?;
            let items: Vec<String> = redis::cmd("LRANGE").arg(&key).arg(0).arg(PAGE - 1).query_async(&mut conn).await.map_err(err)?;
            d.columns = vec!["#".into(), "value".into()];
            d.rows = items.into_iter().enumerate().map(|(i, v)| vec![i.to_string(), v]).collect();
        }
        "set" => {
            d.size = redis::cmd("SCARD").arg(&key).query_async(&mut conn).await.map_err(err)?;
            let (_c, items): (String, Vec<String>) = redis::cmd("SSCAN")
                .arg(&key).arg(0).arg("COUNT").arg(PAGE)
                .query_async(&mut conn).await.map_err(err)?;
            d.columns = vec!["member".into()];
            d.rows = items.into_iter().map(|v| vec![v]).collect();
        }
        "zset" => {
            d.size = redis::cmd("ZCARD").arg(&key).query_async(&mut conn).await.map_err(err)?;
            let flat: Vec<String> = redis::cmd("ZRANGE")
                .arg(&key).arg(0).arg(PAGE - 1).arg("WITHSCORES")
                .query_async(&mut conn).await.map_err(err)?;
            d.columns = vec!["#".into(), "member".into(), "score".into()];
            d.rows = flat
                .chunks(2)
                .enumerate()
                .map(|(i, c)| vec![i.to_string(), c[0].clone(), c.get(1).cloned().unwrap_or_default()])
                .collect();
        }
        "stream" => {
            d.size = redis::cmd("XLEN").arg(&key).query_async(&mut conn).await.map_err(err)?;
            let entries: Vec<(String, Vec<String>)> = redis::cmd("XRANGE")
                .arg(&key).arg("-").arg("+").arg("COUNT").arg(50)
                .query_async(&mut conn).await.map_err(err)?;
            d.columns = vec!["id".into(), "fields".into()];
            d.rows = entries
                .into_iter()
                .map(|(id, fields)| {
                    vec![id, fields.chunks(2).map(|c| format!("{}={}", c[0], c.get(1).cloned().unwrap_or_default())).collect::<Vec<_>>().join("  ")]
                })
                .collect();
        }
        "none" => return Err(format!("Key không tồn tại: {key}")),
        other => {
            // Kiểu lạ (module, json, geo...): vẫn cho xem độ dài nếu đo được.
            d.size = redis::cmd("STRLEN").arg(&key).query_async::<i64>(&mut conn).await.unwrap_or(0);
            d.text = Some(format!("Kiểu `{other}` chưa được hỗ trợ xem chi tiết."));
        }
    }
    Ok(d)
}

/// Ghi đè giá trị string (chỉ dùng cho kiểu string).
#[tauri::command]
pub async fn redis_set_string(state: State<'_, RedisState>, id: String, key: String, value: String) -> Result<(), String> {
    let mut conn = get(&state, &id)?;
    // KEEPTTL: giữ nguyên thời gian hết hạn hiện tại của key. Cần Redis 6+.
    let with_ttl: Result<String, redis::RedisError> = redis::cmd("SET")
        .arg(&key)
        .arg(&value)
        .arg("KEEPTTL")
        .query_async(&mut conn)
        .await;
    if with_ttl.is_ok() {
        return Ok(());
    }
    // Server cũ không hiểu KEEPTTL → đặt lại giá trị (key mất TTL).
    let _: String = redis::cmd("SET").arg(&key).arg(&value).query_async(&mut conn).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn redis_del(state: State<'_, RedisState>, id: String, keys: Vec<String>) -> Result<i64, String> {
    if keys.is_empty() {
        return Ok(0);
    }
    let mut conn = get(&state, &id)?;
    let mut c = redis::cmd("DEL");
    for k in &keys {
        c.arg(k);
    }
    c.query_async(&mut conn).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn redis_dbsize(state: State<'_, RedisState>, id: String) -> Result<i64, String> {
    let mut conn = get(&state, &id)?;
    redis::cmd("DBSIZE").query_async(&mut conn).await.map_err(|e| e.to_string())
}

/// Đổi database (SELECT) — trả về số key trong db mới.
#[tauri::command]
pub async fn redis_select(state: State<'_, RedisState>, id: String, db: i64) -> Result<i64, String> {
    let mut conn = get(&state, &id)?;
    let _: String = redis::cmd("SELECT").arg(db).query_async(&mut conn).await.map_err(|e| e.to_string())?;
    redis::cmd("DBSIZE").query_async(&mut conn).await.map_err(|e| e.to_string())
}

/// Số database của server (CONFIG GET databases). ACL chặn CONFIG thì mặc định 16.
#[tauri::command]
pub async fn redis_databases(state: State<'_, RedisState>, id: String) -> Result<i64, String> {
    let mut conn = get(&state, &id)?;
    let map: HashMap<String, String> = match redis::cmd("CONFIG").arg("GET").arg("databases").query_async(&mut conn).await {
        Ok(m) => m,
        Err(_) => return Ok(16),
    };
    Ok(map.get("databases").and_then(|v| v.parse().ok()).unwrap_or(16))
}

/// Thông tin server + thống kê (INFO). Trả về văn bản thô, UI tự tách dòng.
#[tauri::command]
pub async fn redis_info(state: State<'_, RedisState>, id: String, section: Option<String>) -> Result<String, String> {
    let mut conn = get(&state, &id)?;
    let mut c = redis::cmd("INFO");
    if let Some(s) = section.as_deref().filter(|s| !s.is_empty()) {
        c.arg(s);
    }
    c.query_async(&mut conn).await.map_err(|e| e.to_string())
}

/* ── Lưu mật khẩu Redis vào kho của hệ điều hành (giống app DB) ── */
fn pw_entry(id: &str) -> Option<keyring::Entry> {
    keyring::Entry::new("DevStation Redis", id).ok()
}
#[tauri::command]
pub fn redis_save_password(id: String, password: String) -> Result<(), String> {
    if let Some(e) = pw_entry(&id) {
        let _ = e.set_password(&password);
    }
    Ok(())
}
#[tauri::command]
pub fn redis_get_password(id: String) -> Result<Option<String>, String> {
    Ok(pw_entry(&id).and_then(|e| e.get_password().ok()))
}
#[tauri::command]
pub fn redis_forget_password(id: String) -> Result<(), String> {
    if let Some(e) = pw_entry(&id) {
        let _ = e.delete_credential();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ma_hoa_mat_khau_trong_url() {
        let cfg = RedisConfig {
            host: "10.0.0.5".into(),
            port: Some(6380),
            password: "p@ss w/rd".into(),
            db: Some(2),
            tls: true,
        };
        assert_eq!(url(&cfg), "rediss://:p%40ss%20w%2Frd@10.0.0.5:6380/2");
        let plain = RedisConfig { host: String::new(), port: None, password: String::new(), db: None, tls: false };
        assert_eq!(url(&plain), "redis://127.0.0.1:6379/0");
    }
}
