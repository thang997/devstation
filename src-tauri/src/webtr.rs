//! Web Translate: mở một trang web ngoài trong cửa sổ riêng (`webtr-<n>`) và dịch chữ trên trang theo thời gian thực.
//!
//! An toàn: trang ngoài là mã KHÔNG tin cậy. Tauri chặn lệnh của app (`invoke_handler`) với origin remote khi app
//! không có app manifest, nên trang ngoài KHÔNG gọi được db_query, ssh_send, write_text_file… Nó chỉ gọi được
//! đúng một lệnh của plugin nội bộ `webtr` (`plugin:webtr|translate`), được cấp qua capability `webtr.json`
//! (`windows: ["webtr-*"]`, `remote.urls`). Lệnh này chỉ nhận chuỗi → trả chuỗi dịch, có giới hạn kích thước;
//! dịch vụ/khoá dịch do app quyết định theo nhãn cửa sổ, trang không chọn được.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Runtime, WebviewUrl, WebviewWindowBuilder};

const KEYRING_SERVICE: &str = "DevStation Translate";
/// Giới hạn mỗi lần trang gọi (chống trang lạ đốt hạn mức dịch).
const MAX_ITEMS: usize = 300;
const MAX_ITEM_CHARS: usize = 5_000;
const MAX_TOTAL_CHARS: usize = 40_000;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrCfg {
    /// `google` (không key, endpoint web công khai) | `google-cloud` (Cloud Translation, API key) | `deepl`
    pub provider: String,
    /// Ngôn ngữ nguồn (`auto` = tự nhận diện).
    pub from: String,
    /// Ngôn ngữ đích (vd `vi`).
    pub to: String,
}

fn windows() -> &'static Mutex<HashMap<String, TrCfg>> {
    static W: OnceLock<Mutex<HashMap<String, TrCfg>>> = OnceLock::new();
    W.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Cache bản dịch theo câu, LƯU XUỐNG ĐĨA (`%LOCALAPPDATA%/DevStation/webtr-cache.json`) → mở lại trang / trang cùng
/// site (menu, footer lặp lại) hiện bản dịch ngay, không gọi dịch vụ. Ghi trễ ~3s sau lần thêm mới.
fn cache() -> &'static Mutex<HashMap<String, String>> {
    static C: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    C.get_or_init(|| {
        let m = std::fs::read(cache_path())
            .ok()
            .and_then(|b| serde_json::from_slice::<HashMap<String, String>>(&b).ok())
            .unwrap_or_default();
        Mutex::new(m)
    })
}
const CACHE_MAX: usize = 80_000;

fn cache_path() -> std::path::PathBuf {
    let base = std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("DevStation").join("webtr-cache.json")
}

static SAVE_PENDING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
fn schedule_save() {
    if SAVE_PENDING.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async {
        tokio::time::sleep(Duration::from_secs(3)).await;
        SAVE_PENDING.store(false, Ordering::SeqCst);
        let data = { serde_json::to_vec(&*cache().lock().unwrap()).unwrap_or_default() };
        let p = cache_path();
        let _ = tokio::task::spawn_blocking(move || {
            if let Some(d) = p.parent() {
                let _ = std::fs::create_dir_all(d);
            }
            let tmp = p.with_extension("json.tmp");
            if std::fs::write(&tmp, data).is_ok() {
                let _ = std::fs::rename(&tmp, &p);
            }
        })
        .await;
    });
}

fn http() -> &'static reqwest::Client {
    static H: OnceLock<reqwest::Client> = OnceLock::new();
    H.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(25))
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) DevStation")
            .build()
            .unwrap_or_default()
    })
}

fn key_of(provider: &str) -> Option<String> {
    keyring::Entry::new(KEYRING_SERVICE, provider).ok()?.get_password().ok().filter(|k| !k.trim().is_empty())
}

/* ───────────────────────── Dịch vụ dịch ───────────────────────── */

/// Chia danh sách thành các lô theo số mục + tổng ký tự.
fn chunks(texts: &[String], max_items: usize, max_chars: usize) -> Vec<Vec<String>> {
    let mut out: Vec<Vec<String>> = Vec::new();
    let mut cur: Vec<String> = Vec::new();
    let mut n = 0usize;
    for t in texts {
        let l = t.chars().count();
        if !cur.is_empty() && (cur.len() >= max_items || n + l > max_chars) {
            out.push(std::mem::take(&mut cur));
            n = 0;
        }
        n += l;
        cur.push(t.clone());
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

async fn google_free_chunk(batch: Vec<String>, from: String, to: String, fmt: &'static str) -> Result<Vec<String>, String> {
    let form: Vec<(&str, &str)> = batch.iter().map(|t| ("q", t.as_str())).collect();
    let url = format!(
        "https://translate.googleapis.com/translate_a/t?client=gtx&format={}&sl={}&tl={}",
        fmt,
        urlenc(&from),
        urlenc(&to)
    );
    let r = http().post(url).form(&form).send().await.map_err(|e| format!("Google: {e}"))?;
    let st = r.status();
    let body = r.text().await.map_err(|e| e.to_string())?;
    if !st.is_success() {
        return Err(format!("Google: HTTP {st} {}", body.chars().take(200).collect::<String>()));
    }
    let v: Value = serde_json::from_str(&body).map_err(|_| format!("Google: phản hồi lạ: {}", body.chars().take(200).collect::<String>()))?;
    let arr = v.as_array().ok_or("Google: phản hồi không phải mảng")?;
    // Mỗi phần tử: "bản dịch" (sl cố định) hoặc ["bản dịch", "ngôn ngữ"] (sl=auto).
    let mut out: Vec<String> = arr
        .iter()
        .enumerate()
        .map(|(i, it)| it.as_str().or_else(|| it.get(0).and_then(|x| x.as_str())).map(String::from).unwrap_or_else(|| batch.get(i).cloned().unwrap_or_default()))
        .collect();
    if out.len() < batch.len() {
        out.extend(batch[out.len()..].iter().cloned());
    }
    out.truncate(batch.len());
    Ok(out)
}

async fn google_free(texts: &[String], from: &str, to: &str, html: bool) -> Result<Vec<String>, String> {
    let parts = chunks(texts, 60, 3_500);
    let mut set = tokio::task::JoinSet::new();
    for (i, b) in parts.into_iter().enumerate() {
        let (from, to) = (from.to_string(), to.to_string());
        set.spawn(async move { (i, google_free_chunk(b, from, to, if html { "html" } else { "text" }).await) });
    }
    let mut res: Vec<(usize, Vec<String>)> = Vec::new();
    while let Some(j) = set.join_next().await {
        let (i, r) = j.map_err(|e| e.to_string())?;
        res.push((i, r?));
    }
    res.sort_by_key(|x| x.0);
    Ok(res.into_iter().flat_map(|x| x.1).collect())
}

async fn google_cloud(texts: &[String], from: &str, to: &str, html: bool) -> Result<Vec<String>, String> {
    let key = key_of("google-cloud").ok_or("Chưa nhập API key Google Cloud Translation")?;
    let mut out = Vec::with_capacity(texts.len());
    for batch in chunks(texts, 128, 25_000) {
        let mut body = serde_json::json!({ "q": batch, "target": to, "format": if html { "html" } else { "text" } });
        if from != "auto" {
            body["source"] = Value::String(from.into());
        }
        let r = http()
            .post(format!("https://translation.googleapis.com/language/translate/v2?key={}", urlenc(&key)))
            .header("Content-Type", "application/json")
            .body(body.to_string())
            .send()
            .await
            .map_err(|e| format!("Google Cloud: {e}"))?;
        let st = r.status();
        let v: Value = serde_json::from_str(&r.text().await.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        if !st.is_success() {
            let msg = v["error"]["message"].as_str().unwrap_or("lỗi không rõ");
            return Err(format!("Google Cloud: HTTP {st} — {msg}"));
        }
        let arr = v["data"]["translations"].as_array().ok_or("Google Cloud: phản hồi thiếu data.translations")?;
        for (i, it) in arr.iter().enumerate() {
            out.push(it["translatedText"].as_str().map(String::from).unwrap_or_else(|| batch[i].clone()));
        }
    }
    Ok(out)
}

async fn deepl(texts: &[String], from: &str, to: &str, html: bool) -> Result<Vec<String>, String> {
    let key = key_of("deepl").ok_or("Chưa nhập API key DeepL")?;
    // Key gói Free kết thúc bằng ":fx" → host api-free.
    let host = if key.trim().ends_with(":fx") { "https://api-free.deepl.com" } else { "https://api.deepl.com" };
    let mut out = Vec::with_capacity(texts.len());
    for batch in chunks(texts, 50, 25_000) {
        let mut body = serde_json::json!({ "text": batch, "target_lang": deepl_lang(to) });
        if html {
            body["tag_handling"] = Value::String("html".into());
        }
        if from != "auto" {
            body["source_lang"] = Value::String(deepl_lang(from).split('-').next().unwrap_or("").to_string());
        }
        let r = http()
            .post(format!("{host}/v2/translate"))
            .header("Authorization", format!("DeepL-Auth-Key {}", key.trim()))
            .header("Content-Type", "application/json")
            .body(body.to_string())
            .send()
            .await
            .map_err(|e| format!("DeepL: {e}"))?;
        let st = r.status();
        let text = r.text().await.map_err(|e| e.to_string())?;
        if !st.is_success() {
            return Err(format!("DeepL: HTTP {st} {}", text.chars().take(200).collect::<String>()));
        }
        let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        let arr = v["translations"].as_array().ok_or("DeepL: phản hồi thiếu translations")?;
        for (i, it) in arr.iter().enumerate() {
            out.push(it["text"].as_str().map(String::from).unwrap_or_else(|| batch[i].clone()));
        }
    }
    Ok(out)
}

fn deepl_lang(l: &str) -> String {
    match l {
        "zh-CN" | "zh" => "ZH-HANS".into(),
        "zh-TW" => "ZH-HANT".into(),
        "en" => "EN-US".into(),
        "pt" => "PT-BR".into(),
        x => x.to_uppercase(),
    }
}

fn urlenc(s: &str) -> String {
    let mut o = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => o.push(b as char),
            _ => o.push_str(&format!("%{b:02X}")),
        }
    }
    o
}

/// Dịch theo cấu hình, có cache theo câu (dịch vụ + cặp ngôn ngữ + câu gốc).
/// `html` = chuỗi là HTML (trang gửi đoạn có thẻ <a i=N> đánh dấu từng mẩu) → dịch vụ giữ thẻ, dịch trọn câu.
async fn translate_with(cfg: &TrCfg, texts: Vec<String>, html: bool) -> Result<Vec<String>, String> {
    let prefix = format!("{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}", cfg.provider, cfg.from, cfg.to, if html { "h" } else { "t" });
    let mut out: Vec<Option<String>> = vec![None; texts.len()];
    let mut need: Vec<String> = Vec::new();
    {
        let c = cache().lock().unwrap();
        for (i, t) in texts.iter().enumerate() {
            if let Some(v) = c.get(&format!("{prefix}{t}")) {
                out[i] = Some(v.clone());
            } else if !need.contains(t) {
                need.push(t.clone());
            }
        }
    }
    if !need.is_empty() {
        let got = match cfg.provider.as_str() {
            "google-cloud" => google_cloud(&need, &cfg.from, &cfg.to, html).await?,
            "deepl" => deepl(&need, &cfg.from, &cfg.to, html).await?,
            _ => google_free(&need, &cfg.from, &cfg.to, html).await?,
        };
        let mut c = cache().lock().unwrap();
        if c.len() > CACHE_MAX {
            c.clear();
        }
        let map: HashMap<&String, &String> = need.iter().zip(got.iter()).collect();
        for (i, t) in texts.iter().enumerate() {
            if out[i].is_none() {
                let v = map.get(t).map(|s| (*s).clone()).unwrap_or_else(|| t.clone());
                c.insert(format!("{prefix}{t}"), v.clone());
                out[i] = Some(v);
            }
        }
        drop(c);
        schedule_save();
    }
    Ok(out.into_iter().map(|x| x.unwrap_or_default()).collect())
}

/* ───────────────────────── Plugin cho trang ngoài ───────────────────────── */

/// Lệnh DUY NHẤT trang ngoài gọi được: dịch danh sách chuỗi theo cấu hình của cửa sổ.
#[tauri::command]
async fn translate<R: Runtime>(webview: tauri::Webview<R>, texts: Vec<String>, html: Option<bool>) -> Result<Vec<String>, String> {
    let cfg = windows().lock().unwrap().get(webview.label()).cloned().ok_or("Cửa sổ không phải Web Translate")?;
    if texts.len() > MAX_ITEMS {
        return Err("Quá nhiều đoạn trong một lần dịch".into());
    }
    let mut total = 0usize;
    for t in &texts {
        let l = t.chars().count();
        if l > MAX_ITEM_CHARS {
            return Err("Đoạn văn quá dài".into());
        }
        total += l;
    }
    if total > MAX_TOTAL_CHARS {
        return Err("Quá nhiều chữ trong một lần dịch".into());
    }
    translate_with(&cfg, texts, html.unwrap_or(false)).await
}

pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("webtr").invoke_handler(tauri::generate_handler![translate]).build()
}

/* ───────────────────────── Lệnh cho app (cửa sổ local) ───────────────────────── */

const INJECT: &str = include_str!("webtr_inject.js");

/// Mở `url` trong cửa sổ mới và dịch trang. `ui` = chuỗi giao diện thanh nổi (theo ngôn ngữ app).
#[tauri::command]
pub async fn webtr_open(app: AppHandle, url: String, cfg: TrCfg, ui: Value) -> Result<String, String> {
    let mut u = url.trim().to_string();
    if !u.contains("://") {
        u = format!("https://{u}");
    }
    let parsed: tauri::Url = u.parse().map_err(|_| format!("URL không hợp lệ: {url}"))?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err("Chỉ hỗ trợ http / https".into());
    }
    static N: AtomicU64 = AtomicU64::new(1);
    let label = format!("webtr-{}", N.fetch_add(1, Ordering::Relaxed));
    windows().lock().unwrap().insert(label.clone(), cfg.clone());
    let boot = serde_json::json!({ "from": cfg.from, "to": cfg.to, "ui": ui });
    let script = format!("window.__DSTR_BOOT__ = {boot};\n{INJECT}");
    let host = parsed.host_str().unwrap_or("").to_string();
    let w = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(parsed))
        .title(format!("DevStation — Translate · {host}"))
        .inner_size(1200.0, 860.0)
        .initialization_script(&script)
        .build()
        .map_err(|e| {
            windows().lock().unwrap().remove(&label);
            e.to_string()
        })?;
    let l2 = label.clone();
    w.on_window_event(move |ev| {
        if let tauri::WindowEvent::Destroyed = ev {
            windows().lock().unwrap().remove(&l2);
        }
    });
    let _ = w.set_focus();
    Ok(label)
}

/// Thử dịch một câu với cấu hình đang chọn (nút "Kiểm tra" trong app).
#[tauri::command]
pub async fn webtr_test(cfg: TrCfg) -> Result<String, String> {
    let r = translate_with(&cfg, vec!["Hello, how are you today?".into()], false).await?;
    Ok(r.into_iter().next().unwrap_or_default())
}

#[tauri::command]
pub fn webtr_save_key(provider: String, key: String) -> Result<(), String> {
    keyring::Entry::new(KEYRING_SERVICE, &provider).map_err(|e| e.to_string())?.set_password(key.trim()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn webtr_has_key(provider: String) -> bool {
    key_of(&provider).is_some()
}

#[tauri::command]
pub fn webtr_forget_key(provider: String) -> Result<(), String> {
    if let Ok(e) = keyring::Entry::new(KEYRING_SERVICE, &provider) {
        let _ = e.delete_credential();
    }
    Ok(())
}

/// Xoá cache bản dịch (đổi dịch vụ / muốn dịch lại).
#[tauri::command]
pub fn webtr_clear_cache() {
    cache().lock().unwrap().clear();
    let _ = std::fs::remove_file(cache_path());
}

/// Số câu đang có trong cache (hiện ở app).
#[tauri::command]
pub fn webtr_cache_size() -> usize {
    cache().lock().unwrap().len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunking() {
        let t: Vec<String> = (0..250).map(|i| format!("x{i}")).collect();
        let c = chunks(&t, 100, 10_000);
        assert_eq!(c.len(), 3);
        assert_eq!(c.iter().map(|x| x.len()).sum::<usize>(), 250);
        let big = vec!["a".repeat(3000), "b".repeat(3000), "c".repeat(10)];
        assert_eq!(chunks(&big, 100, 4500).len(), 2);
    }
}
