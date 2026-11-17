//! App Registry: duyệt **Harbor** (REST API `/api/v2.0`) và tải image về máy bằng **Docker Registry API v2**
//! — KHÔNG cần Docker trên máy. Kết quả là file `.tar` định dạng docker-archive, nạp bằng `docker load -i`.
//!
//! Tải image: manifest (chọn nền tảng nếu là multi-arch) → config + layer tải SONG SONG (4 luồng), mỗi blob
//! ghi ra file `.part` trong thư mục tạm, tải tiếp được (HTTP Range) khi rớt mạng, kiểm tra sha256, rồi
//! ráp thành tar (`manifest.json` + `<config>.json` + `<layer>/layer.tar` — layer giữ nguyên dạng nén,
//! `docker load` tự giải nén). Token Bearer hết hạn giữa chừng thì xin lại.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RegCfg {
    url: String,
    #[serde(default)]
    user: String,
    #[serde(default)]
    password: String,
    /// Bỏ qua kiểm tra chứng chỉ TLS (Harbor nội bộ dùng chứng chỉ tự ký).
    #[serde(default)]
    insecure: bool,
}

impl RegCfg {
    fn base(&self) -> String {
        let u = self.url.trim().trim_end_matches('/');
        if u.starts_with("http://") || u.starts_with("https://") {
            u.to_string()
        } else {
            format!("https://{u}")
        }
    }
    fn has_auth(&self) -> bool {
        !self.user.trim().is_empty()
    }
}

#[derive(Default)]
pub struct RegistryState {
    /// Cờ hủy của từng lượt tải (job id → cờ).
    jobs: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

fn client(insecure: bool) -> &'static reqwest::Client {
    static SAFE: OnceLock<reqwest::Client> = OnceLock::new();
    static INSECURE: OnceLock<reqwest::Client> = OnceLock::new();
    let cell = if insecure { &INSECURE } else { &SAFE };
    cell.get_or_init(|| {
        reqwest::Client::builder()
            .danger_accept_invalid_certs(insecure)
            .connect_timeout(Duration::from_secs(15))
            .user_agent("DevStation")
            .build()
            .expect("reqwest client")
    })
}

/// Lỗi mạng kèm nguyên nhân gốc (reqwest chỉ in tầng ngoài cùng).
fn net_err(e: reqwest::Error) -> String {
    let mut s = format!("Không kết nối được registry: {e}");
    let mut src = std::error::Error::source(&e);
    while let Some(x) = src {
        s.push_str(" — ");
        s.push_str(&x.to_string());
        src = x.source();
    }
    s
}

fn api_err(status: reqwest::StatusCode, body: &str) -> String {
    let msg = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v["errors"][0]["message"].as_str().map(str::to_string))
        .unwrap_or_else(|| body.chars().take(200).collect());
    match status.as_u16() {
        401 => format!("Sai tài khoản / mật khẩu hoặc cần đăng nhập (401). {msg}"),
        403 => format!("Không có quyền (403). {msg}"),
        404 => format!("Không tìm thấy (404) — URL có đúng là Harbor (API v2.0)? {msg}"),
        _ => format!("Registry trả lỗi {status}: {msg}"),
    }
}

/// Percent-encode một thành phần URL (giữ ký tự không cần mã hoá).
fn enc(s: &str) -> String {
    let mut o = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => o.push(b as char),
            _ => o.push_str(&format!("%{b:02X}")),
        }
    }
    o
}

/// GET một API Harbor (basic auth nếu có tài khoản) → (JSON, X-Total-Count).
async fn api_get(cfg: &RegCfg, path: &str) -> Result<(Value, Option<u64>), String> {
    let mut rq = client(cfg.insecure)
        .get(format!("{}{}", cfg.base(), path))
        .timeout(Duration::from_secs(30))
        .header("Accept", "application/json");
    if cfg.has_auth() {
        rq = rq.basic_auth(cfg.user.trim(), Some(&cfg.password));
    }
    let r = rq.send().await.map_err(net_err)?;
    let status = r.status();
    let total = r.headers().get("x-total-count").and_then(|v| v.to_str().ok()?.parse().ok());
    let text = r.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(api_err(status, &text));
    }
    let v = serde_json::from_str(&text).map_err(|_| {
        format!("Phản hồi không phải JSON (URL có đúng là Harbor?): {}", text.chars().take(200).collect::<String>())
    })?;
    Ok((v, total))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegInfo {
    user: String,
    version: String,
}

/// Kiểm tra kết nối + tài khoản. Trả về user đăng nhập và phiên bản Harbor.
#[tauri::command]
pub async fn registry_login(cfg: RegCfg) -> Result<RegInfo, String> {
    let (sys, _) = api_get(&cfg, "/api/v2.0/systeminfo").await?;
    let version = sys["harbor_version"].as_str().unwrap_or("").to_string();
    let user = if cfg.has_auth() {
        match api_get(&cfg, "/api/v2.0/users/current").await {
            Ok((u, _)) => u["username"].as_str().unwrap_or(cfg.user.trim()).to_string(),
            // Robot account không có users/current → xác minh bằng một API cần quyền đọc.
            Err(_) => {
                api_get(&cfg, "/api/v2.0/projects?page=1&page_size=1").await?;
                cfg.user.trim().to_string()
            }
        }
    } else {
        String::new()
    };
    Ok(RegInfo { user, version })
}

#[derive(Serialize)]
pub struct Page<T> {
    items: Vec<T>,
    total: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegProject {
    name: String,
    public: bool,
    repo_count: u64,
}

#[tauri::command]
pub async fn registry_projects(cfg: RegCfg, q: Option<String>, page: Option<u32>) -> Result<Page<RegProject>, String> {
    let mut path = format!("/api/v2.0/projects?page={}&page_size=100&sort=name", page.unwrap_or(1));
    if let Some(q) = q.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        path.push_str(&format!("&name={}", enc(q)));
    }
    let (v, total) = api_get(&cfg, &path).await?;
    let items: Vec<RegProject> = v
        .as_array()
        .map(|a| {
            a.iter()
                .map(|p| RegProject {
                    name: p["name"].as_str().unwrap_or("").to_string(),
                    public: p["metadata"]["public"].as_str() == Some("true"),
                    repo_count: p["repo_count"].as_u64().unwrap_or(0),
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(Page { total: total.unwrap_or(items.len() as u64), items })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegRepo {
    /// Tên đầy đủ "project/repo".
    name: String,
    artifact_count: u64,
    pull_count: u64,
    update_time: String,
}

#[tauri::command]
pub async fn registry_repos(cfg: RegCfg, project: String, q: Option<String>, page: Option<u32>) -> Result<Page<RegRepo>, String> {
    let mut path = format!(
        "/api/v2.0/projects/{}/repositories?page={}&page_size=100&sort=name",
        enc(&project),
        page.unwrap_or(1)
    );
    if let Some(q) = q.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        path.push_str(&format!("&q={}", enc(&format!("name=~{q}"))));
    }
    let (v, total) = api_get(&cfg, &path).await?;
    let items: Vec<RegRepo> = v
        .as_array()
        .map(|a| {
            a.iter()
                .map(|r| RegRepo {
                    name: r["name"].as_str().unwrap_or("").to_string(),
                    artifact_count: r["artifact_count"].as_u64().unwrap_or(0),
                    pull_count: r["pull_count"].as_u64().unwrap_or(0),
                    update_time: r["update_time"].as_str().unwrap_or("").to_string(),
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(Page { total: total.unwrap_or(items.len() as u64), items })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegArtifact {
    digest: String,
    size: u64,
    push_time: String,
    tags: Vec<String>,
    /// "os/arch" của image đơn; rỗng với image multi-arch (xem `platforms`).
    platform: String,
    /// Các nền tảng của image multi-arch (index).
    platforms: Vec<String>,
    created: String,
}

fn platform_str(p: &Value) -> String {
    let os = p["os"].as_str().unwrap_or("");
    let arch = p["architecture"].as_str().unwrap_or("");
    if os.is_empty() && arch.is_empty() {
        return String::new();
    }
    match p["variant"].as_str().filter(|v| !v.is_empty()) {
        Some(v) => format!("{os}/{arch}/{v}"),
        None => format!("{os}/{arch}"),
    }
}

#[tauri::command]
pub async fn registry_artifacts(cfg: RegCfg, project: String, repo: String, page: Option<u32>) -> Result<Page<RegArtifact>, String> {
    // Tên repo bỏ phần project; dấu "/" trong tên phải mã hoá HAI lần (Harbor yêu cầu: a/b → a%252Fb).
    let short = repo.strip_prefix(&format!("{project}/")).unwrap_or(&repo);
    let path = format!(
        "/api/v2.0/projects/{}/repositories/{}/artifacts?page={}&page_size=50&with_tag=true&with_label=false\
         &with_scan_overview=false&with_signature=false&with_immutable_status=false&sort=-push_time",
        enc(&project),
        enc(&enc(short)),
        page.unwrap_or(1)
    );
    let (v, total) = api_get(&cfg, &path).await?;
    let items: Vec<RegArtifact> = v
        .as_array()
        .map(|a| {
            a.iter()
                .map(|x| RegArtifact {
                    digest: x["digest"].as_str().unwrap_or("").to_string(),
                    size: x["size"].as_u64().unwrap_or(0),
                    push_time: x["push_time"].as_str().unwrap_or("").to_string(),
                    tags: x["tags"]
                        .as_array()
                        .map(|t| t.iter().filter_map(|t| t["name"].as_str().map(str::to_string)).collect())
                        .unwrap_or_default(),
                    platform: platform_str(&x["extra_attrs"]),
                    platforms: x["references"]
                        .as_array()
                        .map(|r| {
                            r.iter()
                                .map(|c| platform_str(&c["platform"]))
                                .filter(|p| !p.is_empty() && !p.starts_with("unknown"))
                                .collect()
                        })
                        .unwrap_or_default(),
                    created: x["extra_attrs"]["created"].as_str().unwrap_or("").to_string(),
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(Page { total: total.unwrap_or(items.len() as u64), items })
}

/* ───────────────────────── Tải image (Registry API v2) ───────────────────────── */

#[derive(Clone)]
enum Auth {
    None,
    Basic,
    Bearer(String),
}

fn apply(rq: reqwest::RequestBuilder, auth: &Auth, cfg: &RegCfg) -> reqwest::RequestBuilder {
    match auth {
        Auth::None => rq,
        Auth::Basic => rq.basic_auth(cfg.user.trim(), Some(&cfg.password)),
        Auth::Bearer(t) => rq.bearer_auth(t),
    }
}

/// Tách `key="value"` trong header WWW-Authenticate.
fn auth_param(h: &str, key: &str) -> Option<String> {
    let pat = format!("{key}=\"");
    let i = h.find(&pat)? + pat.len();
    let j = h[i..].find('"')? + i;
    Some(h[i..j].to_string())
}

/// Xin quyền pull `repo`: /v2/ trả 401 kèm WWW-Authenticate → Basic dùng thẳng tài khoản, Bearer thì xin token ở realm.
async fn registry_auth(cfg: &RegCfg, repo: &str) -> Result<Auth, String> {
    let c = client(cfg.insecure);
    let r = c.get(format!("{}/v2/", cfg.base())).timeout(Duration::from_secs(30)).send().await.map_err(net_err)?;
    if r.status().is_success() {
        return Ok(Auth::None);
    }
    if r.status() != reqwest::StatusCode::UNAUTHORIZED {
        return Err(format!("/v2/ trả về {} — URL không phải Docker registry?", r.status()));
    }
    let h = r.headers().get("www-authenticate").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    if h.to_lowercase().starts_with("basic") {
        return Ok(Auth::Basic);
    }
    let realm = auth_param(&h, "realm").ok_or_else(|| format!("Không hiểu cơ chế xác thực của registry: {h}"))?;
    let mut url = format!("{realm}?scope={}", enc(&format!("repository:{repo}:pull")));
    if let Some(s) = auth_param(&h, "service") {
        url.push_str(&format!("&service={}", enc(&s)));
    }
    let mut rq = c.get(url).timeout(Duration::from_secs(30));
    if cfg.has_auth() {
        rq = rq.basic_auth(cfg.user.trim(), Some(&cfg.password));
    }
    let r = rq.send().await.map_err(net_err)?;
    let status = r.status();
    let text = r.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(api_err(status, &text));
    }
    let v: Value = serde_json::from_str(&text).map_err(|e| format!("Token không hợp lệ: {e}"))?;
    let tok = v["token"].as_str().or_else(|| v["access_token"].as_str()).ok_or("Registry không trả token")?;
    Ok(Auth::Bearer(tok.to_string()))
}

const MANIFEST_ACCEPT: &str = "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, \
     application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json";

async fn get_manifest(cfg: &RegCfg, auth: &Auth, repo: &str, reference: &str) -> Result<Value, String> {
    let rq = client(cfg.insecure)
        .get(format!("{}/v2/{}/manifests/{}", cfg.base(), repo, reference))
        .timeout(Duration::from_secs(60))
        .header("Accept", MANIFEST_ACCEPT);
    let r = apply(rq, auth, cfg).send().await.map_err(net_err)?;
    let status = r.status();
    let text = r.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(api_err(status, &text));
    }
    serde_json::from_str(&text).map_err(|e| format!("Manifest không hợp lệ: {e}"))
}

/// Manifest list / OCI index → chọn manifest theo nền tảng (mặc định linux/amd64).
fn pick_platform(index: &Value, want: Option<&str>) -> Result<String, String> {
    let list = index["manifests"].as_array().ok_or("Index không có manifests")?;
    let cands: Vec<(String, String)> = list
        .iter()
        .map(|m| (platform_str(&m["platform"]), m["digest"].as_str().unwrap_or("").to_string()))
        .filter(|(p, d)| !d.is_empty() && !p.starts_with("unknown"))
        .collect();
    let find = |p: &str| cands.iter().find(|(x, _)| x == p || x.starts_with(&format!("{p}/"))).map(|(_, d)| d.clone());
    want.filter(|w| !w.is_empty())
        .and_then(find)
        .or_else(|| find("linux/amd64"))
        .or_else(|| cands.first().map(|(_, d)| d.clone()))
        .ok_or_else(|| "Image không có nền tảng nào tải được".into())
}

/// Tải một blob vào `dir/<hex>` (qua `<hex>.part`, tải tiếp bằng Range, kiểm sha256). Thử lại khi rớt mạng.
#[allow(clippy::too_many_arguments)]
async fn download_blob(
    cfg: RegCfg,
    mut auth: Auth,
    repo: String,
    digest: String,
    size: u64,
    dir: PathBuf,
    done: Arc<AtomicU64>,
    cancel: Arc<AtomicBool>,
) -> Result<PathBuf, String> {
    let hex = digest.strip_prefix("sha256:").ok_or_else(|| format!("Digest không hỗ trợ: {digest}"))?.to_string();
    let fin = dir.join(&hex);
    if std::fs::metadata(&fin).map(|m| m.len() == size).unwrap_or(false) {
        done.fetch_add(size, Ordering::Relaxed);
        return Ok(fin);
    }
    let part = dir.join(format!("{hex}.part"));
    let mut counted = 0u64; // phần đã cộng vào `done` cho blob này
    let mut last_err = String::new();
    for _attempt in 0..4 {
        if cancel.load(Ordering::Relaxed) {
            return Err("Đã hủy".into());
        }
        // Băm lại phần đã tải (nếu có) để tải tiếp.
        let p2 = part.clone();
        let (mut hasher, have) = tokio::task::spawn_blocking(move || {
            let mut h = Sha256::new();
            let mut n = 0u64;
            if let Ok(mut f) = std::fs::File::open(&p2) {
                let mut buf = vec![0u8; 1 << 20];
                while let Ok(k) = f.read(&mut buf) {
                    if k == 0 {
                        break;
                    }
                    h.update(&buf[..k]);
                    n += k as u64;
                }
            }
            (h, n)
        })
        .await
        .map_err(|e| e.to_string())?;
        done.fetch_sub(counted, Ordering::Relaxed);
        done.fetch_add(have, Ordering::Relaxed);
        counted = have;

        let mut rq = client(cfg.insecure).get(format!("{}/v2/{}/blobs/{}", cfg.base(), repo, digest));
        if have > 0 {
            rq = rq.header("Range", format!("bytes={have}-"));
        }
        let mut r = match apply(rq, &auth, &cfg).send().await {
            Ok(r) => r,
            Err(e) => {
                last_err = net_err(e);
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            }
        };
        if r.status() == reqwest::StatusCode::UNAUTHORIZED {
            // Token hết hạn (Harbor mặc định 30 phút) → xin lại rồi thử tiếp.
            auth = registry_auth(&cfg, &repo).await?;
            last_err = "401".into();
            continue;
        }
        let append = have > 0 && r.status() == reqwest::StatusCode::PARTIAL_CONTENT;
        if !r.status().is_success() {
            let s = r.status();
            return Err(api_err(s, &r.text().await.unwrap_or_default()));
        }
        if !append && have > 0 {
            // Server bỏ qua Range → tải lại từ đầu.
            hasher = Sha256::new();
            done.fetch_sub(counted, Ordering::Relaxed);
            counted = 0;
        }
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(append)
            .truncate(!append)
            .open(&part)
            .map_err(|e| format!("Không ghi được file tạm: {e}"))?;
        let mut broken = false;
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err("Đã hủy".into());
            }
            match r.chunk().await {
                Ok(Some(c)) => {
                    file.write_all(&c).map_err(|e| format!("Không ghi được file tạm: {e}"))?;
                    hasher.update(&c);
                    done.fetch_add(c.len() as u64, Ordering::Relaxed);
                    counted += c.len() as u64;
                }
                Ok(None) => break,
                Err(e) => {
                    last_err = net_err(e);
                    broken = true;
                    break;
                }
            }
        }
        drop(file);
        if broken {
            tokio::time::sleep(Duration::from_secs(2)).await;
            continue; // tải tiếp từ chỗ dừng
        }
        if format!("{:x}", hasher.finalize()) != hex {
            let _ = std::fs::remove_file(&part);
            done.fetch_sub(counted, Ordering::Relaxed);
            return Err(format!("Sai checksum layer {}", &hex[..12.min(hex.len())]));
        }
        std::fs::rename(&part, &fin).map_err(|e| e.to_string())?;
        return Ok(fin);
    }
    Err(format!("Tải layer {} thất bại: {last_err}", &hex[..12.min(hex.len())]))
}

/// Tải image `repo` (`project/name`) theo `reference` (digest hoặc tag) về file `dest` (.tar cho `docker load`).
/// Tiến trình: event `registry-pull` { job, phase: manifest|download|pack|done, done, total, layersDone, layersTotal }.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn registry_pull(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, RegistryState>,
    cfg: RegCfg,
    repo: String,
    reference: String,
    tag: Option<String>,
    platform: Option<String>,
    dest: String,
    job: String,
) -> Result<u64, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    state.jobs.lock().unwrap().insert(job.clone(), cancel.clone());
    crate::owners::track(&app, window.label(), crate::owners::Kind::RegJob, &job);
    let r = pull(&app, &cfg, &repo, &reference, tag.as_deref(), platform.as_deref(), &dest, &job, cancel).await;
    state.jobs.lock().unwrap().remove(&job);
    r
}

#[tauri::command]
pub fn registry_cancel(state: State<RegistryState>, job: String) -> Result<(), String> {
    if let Some(c) = state.jobs.lock().unwrap().get(&job) {
        c.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn pull(
    app: &AppHandle,
    cfg: &RegCfg,
    repo: &str,
    reference: &str,
    tag: Option<&str>,
    platform: Option<&str>,
    dest: &str,
    job: &str,
    cancel: Arc<AtomicBool>,
) -> Result<u64, String> {
    let emit = |phase: &str, done: u64, total: u64, ld: usize, lt: usize| {
        let _ = app.emit(
            "registry-pull",
            serde_json::json!({ "job": job, "phase": phase, "done": done, "total": total, "layersDone": ld, "layersTotal": lt }),
        );
    };
    emit("manifest", 0, 0, 0, 0);
    let auth = registry_auth(cfg, repo).await?;
    let mut man = get_manifest(cfg, &auth, repo, reference).await?;
    if man["manifests"].is_array() {
        let d = pick_platform(&man, platform)?;
        man = get_manifest(cfg, &auth, repo, &d).await?;
    }
    let config = man["config"]["digest"].as_str().ok_or("Manifest không có config (không phải image?)")?.to_string();
    let config_size = man["config"]["size"].as_u64().unwrap_or(0);
    let layers: Vec<(String, u64)> = man["layers"]
        .as_array()
        .ok_or("Manifest không có layers")?
        .iter()
        .map(|l| (l["digest"].as_str().unwrap_or("").to_string(), l["size"].as_u64().unwrap_or(0)))
        .collect();
    if layers.iter().any(|(d, _)| d.is_empty()) {
        return Err("Manifest có layer thiếu digest".into());
    }

    let dir = std::env::temp_dir().join("devstation-registry");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // Blob duy nhất cần tải (config + layer, bỏ trùng).
    let mut blobs: Vec<(String, u64)> = vec![(config.clone(), config_size)];
    for l in &layers {
        if !blobs.iter().any(|(d, _)| d == &l.0) {
            blobs.push(l.clone());
        }
    }
    let total: u64 = blobs.iter().map(|(_, s)| s).sum();
    let n_layers = blobs.len();

    let done = Arc::new(AtomicU64::new(0));
    let finished = Arc::new(AtomicUsize::new(0));
    let stop = Arc::new(AtomicBool::new(false));
    {
        let (app, job, done, finished, stop) = (app.clone(), job.to_string(), done.clone(), finished.clone(), stop.clone());
        tauri::async_runtime::spawn(async move {
            while !stop.load(Ordering::Relaxed) {
                let _ = app.emit(
                    "registry-pull",
                    serde_json::json!({ "job": job, "phase": "download", "done": done.load(Ordering::Relaxed), "total": total,
                                        "layersDone": finished.load(Ordering::Relaxed), "layersTotal": n_layers }),
                );
                tokio::time::sleep(Duration::from_millis(400)).await;
            }
        });
    }

    // Tải song song tối đa 4 blob.
    let sem = Arc::new(tokio::sync::Semaphore::new(4));
    let mut set = tokio::task::JoinSet::new();
    for (d, s) in blobs.clone() {
        let (cfg, auth, repo, dir, done, cancel, sem, finished) =
            (cfg.clone(), auth.clone(), repo.to_string(), dir.clone(), done.clone(), cancel.clone(), sem.clone(), finished.clone());
        set.spawn(async move {
            let _permit = sem.acquire_owned().await.map_err(|e| e.to_string())?;
            let r = download_blob(cfg, auth, repo, d, s, dir, done, cancel).await;
            if r.is_ok() {
                finished.fetch_add(1, Ordering::Relaxed);
            }
            r
        });
    }
    let mut first_err: Option<String> = None;
    while let Some(r) = set.join_next().await {
        let r = r.map_err(|e| e.to_string()).and_then(|x| x);
        if let Err(e) = r {
            if first_err.is_none() {
                first_err = Some(e);
                cancel.store(true, Ordering::Relaxed); // một layer lỗi → dừng các layer khác
            }
        }
    }
    stop.store(true, Ordering::Relaxed);
    if let Some(e) = first_err {
        return Err(e); // file .part còn lại → lần tải sau tiếp tục từ chỗ dừng
    }

    // Ráp tar docker-archive.
    emit("pack", total, total, n_layers, n_layers);
    let hex = |d: &str| d.trim_start_matches("sha256:").to_string();
    let repo_tag = tag.filter(|t| !t.is_empty()).map(|t| {
        let host = cfg.base().split("://").nth(1).unwrap_or("").to_string();
        format!("{host}/{repo}:{t}")
    });
    let cfg_name = format!("{}.json", hex(&config));
    let layer_names: Vec<String> = layers.iter().map(|(d, _)| format!("{}/layer.tar", hex(d))).collect();
    let manifest_json = serde_json::to_vec(&serde_json::json!([{
        "Config": cfg_name,
        "RepoTags": repo_tag.map(|t| vec![t]).unwrap_or_default(),
        "Layers": layer_names,
    }]))
    .map_err(|e| e.to_string())?;
    let dest_p = PathBuf::from(dest);
    let tmp = PathBuf::from(format!("{dest}.part"));
    let blob_paths: Vec<(String, PathBuf)> = blobs.iter().map(|(d, _)| (hex(d), dir.join(hex(d)))).collect();
    let config_hex = hex(&config);
    let size = tokio::task::spawn_blocking(move || -> Result<u64, String> {
        let f = std::fs::File::create(&tmp).map_err(|e| format!("Không tạo được file {}: {e}", tmp.display()))?;
        let mut tar = tar::Builder::new(std::io::BufWriter::with_capacity(1 << 20, f));
        for (h, p) in &blob_paths {
            let name = if *h == config_hex { format!("{h}.json") } else { format!("{h}/layer.tar") };
            tar.append_path_with_name(p, &name).map_err(|e| e.to_string())?;
        }
        let mut hdr = tar::Header::new_gnu();
        hdr.set_size(manifest_json.len() as u64);
        hdr.set_mode(0o644);
        hdr.set_cksum();
        tar.append_data(&mut hdr, "manifest.json", manifest_json.as_slice()).map_err(|e| e.to_string())?;
        let mut w = tar.into_inner().map_err(|e| e.to_string())?;
        w.flush().map_err(|e| e.to_string())?;
        drop(w);
        let _ = std::fs::remove_file(&dest_p);
        std::fs::rename(&tmp, &dest_p).map_err(|e| e.to_string())?;
        // Xoá blob tạm (đã nằm trong file tar).
        for (_, p) in &blob_paths {
            let _ = std::fs::remove_file(p);
        }
        Ok(std::fs::metadata(&dest_p).map(|m| m.len()).unwrap_or(0))
    })
    .await
    .map_err(|e| e.to_string())??;
    emit("done", total, total, n_layers, n_layers);
    Ok(size)
}

/* ───────────────────────── Mật khẩu (keyring) ───────────────────────── */

fn pw_entry(id: &str) -> Option<keyring::Entry> {
    keyring::Entry::new("DevStation Registry", id).ok()
}
#[tauri::command]
pub fn registry_save_password(id: String, password: String) -> Result<(), String> {
    if let Some(e) = pw_entry(&id) {
        let _ = e.set_password(&password);
    }
    Ok(())
}
#[tauri::command]
pub fn registry_get_password(id: String) -> Result<Option<String>, String> {
    Ok(pw_entry(&id).and_then(|e| e.get_password().ok()))
}
#[tauri::command]
pub fn registry_forget_password(id: String) -> Result<(), String> {
    if let Some(e) = pw_entry(&id) {
        let _ = e.delete_credential();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn www_authenticate_and_encoding() {
        let h = r#"Bearer realm="https://h.example/service/token",service="harbor-registry""#;
        assert_eq!(auth_param(h, "realm").as_deref(), Some("https://h.example/service/token"));
        assert_eq!(auth_param(h, "service").as_deref(), Some("harbor-registry"));
        assert_eq!(enc(&enc("a/b")), "a%252Fb");
        assert_eq!(enc("name=~web"), "name%3D~web");
    }

    #[test]
    fn picks_platform_from_index() {
        let idx = serde_json::json!({ "manifests": [
            { "digest": "sha256:arm", "platform": { "os": "linux", "architecture": "arm64", "variant": "v8" } },
            { "digest": "sha256:amd", "platform": { "os": "linux", "architecture": "amd64" } },
            { "digest": "sha256:att", "platform": { "os": "unknown", "architecture": "unknown" } }
        ]});
        assert_eq!(pick_platform(&idx, None).unwrap(), "sha256:amd");
        assert_eq!(pick_platform(&idx, Some("linux/arm64")).unwrap(), "sha256:arm");
    }
}
