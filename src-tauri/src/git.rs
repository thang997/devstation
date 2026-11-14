//! App Git: mọi thao tác gọi thẳng `git.exe` của máy.
//!
//! Lý do không dùng libgit2: dùng lại đúng config, hook, credential manager, autocrlf, sparse/worktree
//! của người dùng — kết quả giống hệt khi họ gõ lệnh trong terminal.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::process::{Output, Stdio};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Khoá theo từng repo: hai lệnh git trên cùng repo sẽ xếp hàng thay vì cùng ghi .git/index
/// (nguyên nhân gây "Unable to create index.lock" khi bấm nhanh hai nút).
static REPO_LOCKS: OnceLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> = OnceLock::new();

fn repo_lock(path: &str) -> Arc<tokio::sync::Mutex<()>> {
    let map = REPO_LOCKS.get_or_init(Default::default);
    map.lock()
        .unwrap()
        .entry(path.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

fn cmd(cwd: &str, args: &[&str]) -> Command {
    let mut c = Command::new("git");
    c.current_dir(cwd)
        // quotepath=false: tên file tiếng Việt không bị mã hoá thành \303\241...
        .args(["-c", "core.quotepath=false", "-c", "color.ui=never"])
        .args(args)
        // Không bao giờ hỏi mật khẩu qua terminal (không có terminal) — để Git Credential Manager lo.
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW); // không bật cửa sổ console đen
    c
}

fn spawn_err(e: std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::NotFound {
        if cfg!(windows) { "Không tìm thấy git.exe — cài Git for Windows và thêm vào PATH".into() } else { "Không tìm thấy git — cài git rồi thêm vào PATH (apt install git / brew install git)".into() }
    } else {
        e.to_string()
    }
}

fn lossy(b: &[u8]) -> String {
    String::from_utf8_lossy(b).into_owned()
}

fn err_text(out: &Output) -> String {
    let e = lossy(&out.stderr);
    let e = e.trim();
    if !e.is_empty() {
        if e.contains("index.lock") {
            return format!(
                "{e}

→ Một tiến trình git khác đang ghi index của repo này. Đợi vài giây rồi thử lại; nếu chắc chắn không còn tiến trình git nào, xoá file .git/index.lock."
            );
        }
        return e.to_string();
    }
    let o = lossy(&out.stdout);
    if !o.trim().is_empty() {
        return o.trim().to_string();
    }
    format!("git thoát với mã {:?}", out.status.code())
}

async fn raw(cwd: &str, args: &[&str]) -> Result<Output, String> {
    cmd(cwd, args).output().await.map_err(spawn_err)
}

async fn git(cwd: &str, args: &[&str]) -> Result<String, String> {
    let out = raw(cwd, args).await?;
    if out.status.success() {
        Ok(lossy(&out.stdout))
    } else {
        Err(err_text(&out))
    }
}

/* ── Status ──────────────────────────────────────── */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    path: String,
    /// Tên cũ khi đổi tên.
    orig: Option<String>,
    /// Trạng thái trong index (staged): M A D R C T U hoặc '.'.
    x: char,
    /// Trạng thái trong working tree.
    y: char,
    /// changed | renamed | conflict | untracked
    kind: &'static str,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// None = detached HEAD.
    branch: Option<String>,
    head: Option<String>,
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
    files: Vec<FileChange>,
    /// Đang merge/rebase dở (có file xung đột).
    conflicted: bool,
}

fn xy(s: &str) -> (char, char) {
    let mut c = s.chars();
    (c.next().unwrap_or('.'), c.next().unwrap_or('.'))
}

/// Đọc `git status --porcelain=v2 --branch -z`.
fn parse_status(text: &str) -> Status {
    let mut st = Status::default();
    let mut parts = text.split('\0').filter(|s| !s.is_empty());
    while let Some(e) = parts.next() {
        if let Some(h) = e.strip_prefix("# ") {
            let (k, v) = h.split_once(' ').unwrap_or((h, ""));
            match k {
                "branch.oid" if v != "(initial)" => st.head = Some(v.chars().take(8).collect()),
                "branch.head" if v != "(detached)" => st.branch = Some(v.into()),
                "branch.upstream" => st.upstream = Some(v.into()),
                "branch.ab" => {
                    for n in v.split(' ') {
                        if let Some(a) = n.strip_prefix('+') {
                            st.ahead = a.parse().unwrap_or(0);
                        } else if let Some(b) = n.strip_prefix('-') {
                            st.behind = b.parse().unwrap_or(0);
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        let kind = e.as_bytes()[0];
        match kind {
            b'1' => {
                let f: Vec<&str> = e.splitn(9, ' ').collect();
                if f.len() == 9 {
                    let (x, y) = xy(f[1]);
                    st.files.push(FileChange { path: f[8].into(), orig: None, x, y, kind: "changed" });
                }
            }
            b'2' => {
                let f: Vec<&str> = e.splitn(10, ' ').collect();
                let orig = parts.next().map(String::from); // -z: tên cũ nằm ở trường kế tiếp
                if f.len() == 10 {
                    let (x, y) = xy(f[1]);
                    st.files.push(FileChange { path: f[9].into(), orig, x, y, kind: "renamed" });
                }
            }
            b'u' => {
                let f: Vec<&str> = e.splitn(11, ' ').collect();
                if f.len() == 11 {
                    let (x, y) = xy(f[1]);
                    st.conflicted = true;
                    st.files.push(FileChange { path: f[10].into(), orig: None, x, y, kind: "conflict" });
                }
            }
            b'?' => st.files.push(FileChange { path: e[2..].into(), orig: None, x: '?', y: '?', kind: "untracked" }),
            _ => {}
        }
    }
    st
}

#[tauri::command]
pub async fn git_status(path: String) -> Result<Status, String> {
    let _serial = repo_lock(&path).lock_owned().await;
    let text = git(&path, &["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]).await?;
    Ok(parse_status(&text))
}

/* ── Repo ────────────────────────────────────────── */

/// Thư mục gốc của repo chứa `path` (dấu `/`), lỗi nếu không phải repo.
#[tauri::command]
pub async fn git_root(path: String) -> Result<String, String> {
    let _serial = repo_lock(&path).lock_owned().await;
    Ok(git(&path, &["rev-parse", "--show-toplevel"]).await?.trim().to_string())
}

/// Tìm các repo trong `dir` (sâu tối đa 3 cấp), dùng khi người dùng chọn thư mục cha chứa nhiều project.
#[tauri::command]
pub async fn git_find_repos(dir: String) -> Result<Vec<String>, String> {
    fn walk(p: &Path, depth: u32, out: &mut Vec<String>) {
        if p.join(".git").exists() {
            out.push(p.to_string_lossy().replace('\\', "/"));
            return;
        }
        if depth == 0 {
            return;
        }
        let Ok(rd) = std::fs::read_dir(p) else { return };
        let mut dirs: Vec<PathBuf> = rd
            .flatten()
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .map(|e| e.path())
            .filter(|p| {
                let n = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                !n.starts_with('.') && !matches!(n, "node_modules" | "target" | "vendor" | "dist" | "build")
            })
            .collect();
        dirs.sort();
        for d in dirs {
            walk(&d, depth - 1, out);
        }
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::new();
        walk(Path::new(&dir), 3, &mut out);
        out
    })
    .await
    .map_err(|e| e.to_string())
}

/* ── Diff / log / branch ─────────────────────────── */

#[tauri::command]
pub async fn git_diff(path: String, file: String, staged: bool, untracked: bool) -> Result<String, String> {
    let _serial = repo_lock(&path).lock_owned().await;
    if untracked {
        // So file mới với rỗng; --no-index trả mã 1 khi có khác biệt — đó không phải lỗi.
        let out = raw(&path, &["diff", "--no-index", "--", "/dev/null", &file]).await?;
        return match out.status.code() {
            Some(0) | Some(1) => Ok(lossy(&out.stdout)),
            _ => Err(err_text(&out)),
        };
    }
    let mut args = vec!["diff"];
    if staged {
        args.push("--cached");
    }
    args.extend(["--", file.as_str()]);
    git(&path, &args).await
}

/// Toàn bộ thay đổi của một file so với HEAD (gộp cả đã stage lẫn chưa stage) — cho giao diện kiểu GitHub Desktop.
#[tauri::command]
pub async fn git_file_diff(path: String, file: String, untracked: bool) -> Result<String, String> {
    let _serial = repo_lock(&path).lock_owned().await;
    if untracked {
        let out = raw(&path, &["diff", "--no-index", "--", "/dev/null", &file]).await?;
        return match out.status.code() {
            Some(0) | Some(1) => Ok(lossy(&out.stdout)),
            _ => Err(err_text(&out)),
        };
    }
    // Repo chưa có commit nào (chưa có HEAD) → so với vùng staged cho đỡ lỗi.
    let base: &str = if raw(&path, &["rev-parse", "--verify", "-q", "HEAD"]).await?.status.success() {
        "HEAD"
    } else {
        "--cached"
    };
    git(&path, &["diff", base, "--", file.as_str()]).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    hash: String,
    short: String,
    author: String,
    /// Unix giây.
    time: i64,
    refs: String,
    subject: String,
}

#[tauri::command]
pub async fn git_log(path: String, limit: Option<u32>) -> Result<Vec<Commit>, String> {
    let _serial = repo_lock(&path).lock_owned().await;
    let n = format!("-n{}", limit.unwrap_or(200));
    let out = raw(&path, &["log", &n, "--format=%H%x1f%h%x1f%an%x1f%at%x1f%D%x1f%s%x1e"]).await?;
    if !out.status.success() {
        let e = err_text(&out);
        // Repo mới chưa có commit nào.
        if e.contains("does not have any commits") || e.contains("bad default revision") {
            return Ok(vec![]);
        }
        return Err(e);
    }
    Ok(lossy(&out.stdout)
        .split('\x1e')
        .filter_map(|rec| {
            let f: Vec<&str> = rec.trim_start_matches('\n').split('\x1f').collect();
            (f.len() == 6).then(|| Commit {
                hash: f[0].into(),
                short: f[1].into(),
                author: f[2].into(),
                time: f[3].parse().unwrap_or(0),
                refs: f[4].into(),
                subject: f[5].into(),
            })
        })
        .collect())
}

#[tauri::command]
pub async fn git_show(path: String, hash: String) -> Result<String, String> {
    let _serial = repo_lock(&path).lock_owned().await;
    git(&path, &["show", "--stat", "--patch", "--format=fuller", &hash]).await
}

/// Toàn bộ message của commit HEAD (tiêu đề + thân).
async fn head_message(path: &str) -> Result<String, String> {
    Ok(git(path, &["log", "-1", "--format=%B"]).await?.trim_end().to_string())
}

/// Repo đã có commit nào chưa.
async fn has_commit(path: &str) -> bool {
    git(path, &["rev-parse", "--verify", "--quiet", "HEAD"]).await.is_ok()
}

/// Commit HEAD đã có trên remote nào chưa. Chưa push = false.
#[tauri::command]
pub async fn git_head_pushed(path: String) -> Result<bool, String> {
    let _serial = repo_lock(&path).lock_owned().await;
    if !has_commit(&path).await {
        return Ok(false);
    }
    Ok(!git(&path, &["branch", "-r", "--contains", "HEAD"]).await?.trim().is_empty())
}

/// Bỏ commit gần nhất CHƯA PUSH: reset --soft HEAD~1 — commit biến mất, toàn bộ thay đổi của nó
/// vẫn nằm nguyên trong index (Staged) để sửa rồi commit lại. Trả về message cũ.
#[tauri::command]
pub async fn git_undo_commit(path: String) -> Result<String, String> {
    let _serial = repo_lock(&path).lock_owned().await;
    if !has_commit(&path).await {
        return Err("Repo chưa có commit nào".into());
    }
    if git(&path, &["rev-parse", "--verify", "--quiet", "HEAD~1"]).await.is_err() {
        return Err("Đây là commit duy nhất của nhánh — không có commit trước để lùi về".into());
    }
    // Đã push thì bỏ commit sẽ làm lịch sử local lệch remote → phải force push. Không tự làm.
    if !git(&path, &["branch", "-r", "--contains", "HEAD"]).await?.trim().is_empty() {
        return Err("Commit này đã push lên remote nên không bỏ được. Nếu cần hoàn tác trên remote, dùng git revert.".into());
    }
    let msg = head_message(&path).await?;
    git(&path, &["reset", "--soft", "HEAD~1"]).await?;
    Ok(msg)
}

/// Commit `hash` đã có trên remote nào chưa (để chặn sửa lịch sử đã đẩy).
async fn commit_pushed(path: &str, hash: &str) -> Result<bool, String> {
    Ok(!git(path, &["branch", "-r", "--contains", hash]).await?.trim().is_empty())
}

/// Toàn bộ message (tiêu đề + thân) của một commit — dùng để điền sẵn khi sửa message.
#[tauri::command]
pub async fn git_commit_message(path: String, hash: String) -> Result<String, String> {
    let _serial = repo_lock(&path).lock_owned().await;
    Ok(git(&path, &["log", "-1", "--format=%B", &hash]).await?.trim_end().to_string())
}

/// Sửa message commit GẦN NHẤT (amend) — chỉ khi commit đó chưa push (tránh phải force push).
#[tauri::command]
pub async fn git_reword_head(path: String, message: String) -> Result<String, String> {
    let _serial = repo_lock(&path).lock_owned().await;
    if !has_commit(&path).await {
        return Err("Repo chưa có commit nào".into());
    }
    if commit_pushed(&path, "HEAD").await? {
        return Err("Commit này đã push nên không sửa message được (sẽ phải force push).".into());
    }
    let mut child = cmd(&path, &["commit", "--amend", "-F", "-"]).stdin(Stdio::piped()).spawn().map_err(spawn_err)?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(message.as_bytes()).await.map_err(|e| e.to_string())?;
    }
    let out = child.wait_with_output().await.map_err(|e| e.to_string())?;
    if out.status.success() { Ok(lossy(&out.stdout).trim().to_string()) } else { Err(err_text(&out)) }
}

/// Revert một commit: tạo commit mới đảo ngược thay đổi (an toàn — không viết lại lịch sử).
#[tauri::command]
pub async fn git_revert(path: String, hash: String) -> Result<String, String> {
    let _serial = repo_lock(&path).lock_owned().await;
    let out = raw(&path, &["revert", "--no-edit", &hash]).await?;
    if out.status.success() {
        return Ok(lossy(&out.stdout).trim().to_string());
    }
    let e = err_text(&out);
    if e.contains("conflict") || e.to_lowercase().contains("could not revert") {
        return Err(format!("{e}\n\n→ Revert gây xung đột. Giải quyết xong rồi commit, hoặc chạy `git revert --abort` trong terminal để huỷ."));
    }
    Err(e)
}

/// Reset nhánh hiện tại về `hash`. hard=false: giữ mọi thay đổi ở Staged (soft). hard=true: xoá sạch.
#[tauri::command]
pub async fn git_reset_to(path: String, hash: String, hard: bool) -> Result<(), String> {
    let _serial = repo_lock(&path).lock_owned().await;
    git(&path, &["reset", if hard { "--hard" } else { "--soft" }, &hash]).await.map(|_| ())
}

/// Checkout một commit ở trạng thái detached HEAD (chỉ để xem; không nằm trên nhánh nào).
#[tauri::command]
pub async fn git_checkout_commit(path: String, hash: String) -> Result<(), String> {
    let _serial = repo_lock(&path).lock_owned().await;
    git(&path, &["switch", "--detach", &hash]).await.map(|_| ())
}

/// Tạo nhánh mới từ `hash` và chuyển sang nhánh đó.
#[tauri::command]
pub async fn git_branch_at(path: String, name: String, hash: String) -> Result<(), String> {
    let _serial = repo_lock(&path).lock_owned().await;
    let n = name.trim();
    if n.is_empty() {
        return Err("Nhập tên nhánh".into());
    }
    git(&path, &["switch", "-c", n, &hash]).await.map(|_| ())
}

/// Mở một URL bằng trình duyệt mặc định của hệ điều hành.
fn open_url(url: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // cmd /C start "" <url>: "" là tiêu đề cửa sổ rỗng, giúp start không hiểu nhầm URL là tiêu đề.
        std::process::Command::new("cmd")
            .args(["/C", "start", "", url])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(url).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open").arg(url).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Dựng URL web của một commit từ URL remote (github/gitlab/bitbucket/chung).
fn commit_web_url(remote: &str, hash: &str) -> Option<String> {
    let r = remote.trim();
    let https = if let Some(rest) = r.strip_prefix("git@") {
        // scp-style: git@host:owner/repo.git → https://host/owner/repo.git
        format!("https://{}", rest.replacen(':', "/", 1))
    } else if let Some(rest) = r.strip_prefix("ssh://") {
        format!("https://{}", rest.trim_start_matches("git@"))
    } else if r.starts_with("http://") || r.starts_with("https://") {
        r.to_string()
    } else {
        return None;
    };
    let base = https.trim_end_matches('/').trim_end_matches(".git").to_string();
    Some(if base.contains("gitlab") {
        format!("{base}/-/commit/{hash}")
    } else if base.contains("bitbucket") {
        format!("{base}/commits/{hash}")
    } else {
        format!("{base}/commit/{hash}")
    })
}

/// Mở trang commit trên remote origin bằng trình duyệt.
#[tauri::command]
pub async fn git_open_commit_remote(path: String, hash: String) -> Result<(), String> {
    let _serial = repo_lock(&path).lock_owned().await;
    let remote = git(&path, &["remote", "get-url", "origin"])
        .await
        .map_err(|_| "Repo chưa có remote 'origin'".to_string())?;
    let url = commit_web_url(remote.trim(), &hash)
        .ok_or_else(|| format!("Không dựng được URL web từ remote: {}", remote.trim()))?;
    open_url(&url)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    name: String,
    remote: bool,
    upstream: String,
    current: bool,
    /// Thời điểm commit gần nhất của nhánh (unix giây) — để hiện "hoạt động gần nhất".
    time: i64,
    /// Tiêu đề commit gần nhất.
    subject: String,
}

#[tauri::command]
pub async fn git_branches(path: String) -> Result<Vec<Branch>, String> {
    let _serial = repo_lock(&path).lock_owned().await;
    let text = git(
        &path,
        &[
            "for-each-ref",
            "--format=%(refname)%1f%(refname:short)%1f%(upstream:short)%1f%(HEAD)%1f%(committerdate:unix)%1f%(subject)",
            "refs/heads",
            "refs/remotes",
        ],
    )
    .await?;
    Ok(text
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\x1f').collect();
            if f.len() < 6 || f[0].ends_with("/HEAD") {
                return None;
            }
            Some(Branch {
                name: f[1].into(),
                remote: f[0].starts_with("refs/remotes/"),
                upstream: f[2].into(),
                current: f[3] == "*",
                time: f[4].parse().unwrap_or(0),
                subject: f[5].into(),
            })
        })
        .collect())
}

/// Hợp nhất `branch` vào nhánh hiện tại (`git merge --no-edit`). Xung đột → báo rõ cách xử lý.
#[tauri::command]
pub async fn git_merge(path: String, branch: String) -> Result<String, String> {
    let _serial = repo_lock(&path).lock_owned().await;
    let out = raw(&path, &["merge", "--no-edit", &branch]).await?;
    if out.status.success() {
        return Ok(lossy(&out.stdout).trim().to_string());
    }
    let stdout = lossy(&out.stdout);
    let e = err_text(&out);
    if stdout.contains("CONFLICT") || e.to_lowercase().contains("conflict") {
        let all = format!("{}\n{}", stdout.trim(), e).trim().to_string();
        return Err(format!(
            "{all}\n\n→ Có xung đột khi merge. Giải quyết các file rồi commit, hoặc chạy `git merge --abort` trong terminal để huỷ."
        ));
    }
    Err(e)
}

/// Đổi tên một nhánh local (`git branch -m <old> <new>`).
#[tauri::command]
pub async fn git_rename_branch(path: String, old: String, new: String) -> Result<(), String> {
    let _serial = repo_lock(&path).lock_owned().await;
    let n = new.trim();
    if n.is_empty() {
        return Err("Nhập tên nhánh mới".into());
    }
    git(&path, &["branch", "-m", &old, n]).await.map(|_| ())
}

/// Xoá nhánh. Local: `git branch -d/-D`; remote (tên dạng `origin/x`): `git push <remote> --delete <x>`.
/// Nhánh local chưa merge mà `force=false` → trả lỗi gắn tiền tố `__UNMERGED__` để UI mời xoá ép.
#[tauri::command]
pub async fn git_delete_branch(path: String, name: String, remote: bool, force: bool) -> Result<String, String> {
    let _serial = repo_lock(&path).lock_owned().await;
    if remote {
        // name dạng "origin/feature/x" → tách tên remote (phần đầu) khỏi tên nhánh.
        let (rem, branch) = name.split_once('/').ok_or("Tên nhánh remote không hợp lệ")?;
        let out = raw(&path, &["push", rem, "--delete", branch]).await?;
        return if out.status.success() {
            Ok(format!("đã xoá nhánh remote {name}"))
        } else {
            Err(err_text(&out))
        };
    }
    let out = raw(&path, &["branch", if force { "-D" } else { "-d" }, &name]).await?;
    if out.status.success() {
        return Ok(format!("đã xoá nhánh {name}"));
    }
    let e = err_text(&out);
    if !force && e.to_lowercase().contains("not fully merged") {
        return Err(format!("__UNMERGED__{e}"));
    }
    Err(e)
}

/* ── Ghi ─────────────────────────────────────────── */

fn with_files<'a>(base: &[&'a str], files: &'a [String]) -> Vec<&'a str> {
    let mut v = base.to_vec();
    v.push("--");
    v.extend(files.iter().map(String::as_str));
    v
}

#[tauri::command]
pub async fn git_stage(path: String, files: Vec<String>) -> Result<(), String> {
    let _serial = repo_lock(&path).lock_owned().await;
    git(&path, &with_files(&["add", "-A"], &files)).await.map(|_| ())
}

#[tauri::command]
pub async fn git_unstage(path: String, files: Vec<String>) -> Result<(), String> {
    let _serial = repo_lock(&path).lock_owned().await;
    // `reset` chạy được cả khi repo chưa có commit nào (khác với `restore --staged`).
    git(&path, &with_files(&["reset", "-q"], &files)).await.map(|_| ())
}

/// Bỏ thay đổi chưa stage: file đã theo dõi thì khôi phục, file mới thì xoá.
#[tauri::command]
pub async fn git_discard(path: String, tracked: Vec<String>, untracked: Vec<String>) -> Result<(), String> {
    let _serial = repo_lock(&path).lock_owned().await;
    if !tracked.is_empty() {
        git(&path, &with_files(&["restore"], &tracked)).await?;
    }
    if !untracked.is_empty() {
        git(&path, &with_files(&["clean", "-f", "-q"], &untracked)).await?;
    }
    Ok(())
}

/// Bỏ MỌI thay đổi: đưa file đã theo dõi về đúng HEAD (cả staged) và xoá file chưa track.
#[tauri::command]
pub async fn git_discard_all(path: String) -> Result<(), String> {
    let _serial = repo_lock(&path).lock_owned().await;
    // Repo đã có commit thì reset cứng về HEAD; repo mới tinh thì chỉ cần dọn file chưa track.
    if raw(&path, &["rev-parse", "--verify", "-q", "HEAD"]).await?.status.success() {
        git(&path, &["reset", "-q", "--hard", "HEAD"]).await?;
    }
    git(&path, &["clean", "-f", "-d"]).await.map(|_| ())
}

#[tauri::command]
pub async fn git_commit(path: String, message: String) -> Result<String, String> {
    let _serial = repo_lock(&path).lock_owned().await;
    // Message qua stdin: giữ nguyên xuống dòng và ký tự đặc biệt.
    let args = ["commit", "-F", "-"];
    let mut child = cmd(&path, &args).stdin(Stdio::piped()).spawn().map_err(spawn_err)?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(message.as_bytes()).await.map_err(|e| e.to_string())?;
    }
    let out = child.wait_with_output().await.map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(lossy(&out.stdout).trim().to_string())
    } else {
        Err(err_text(&out))
    }
}

fn switch_args<'a>(branch: &'a str, create: bool, track: bool) -> Vec<&'a str> {
    let mut args = vec!["switch"];
    if create {
        args.push("-c");
    } else if track {
        args.push("--track");
    }
    args.push(branch);
    args
}

/// True nếu git từ chối checkout vì có thay đổi chưa commit sẽ bị ghi đè.
fn is_dirty_refusal(msg: &str) -> bool {
    let m = msg.to_lowercase();
    m.contains("would be overwritten") || m.contains("commit your changes or stash")
}

#[tauri::command]
pub async fn git_switch(path: String, branch: String, create: bool, track: bool) -> Result<(), String> {
    let _serial = repo_lock(&path).lock_owned().await;
    let out = raw(&path, &switch_args(&branch, create, track)).await?;
    if out.status.success() {
        return Ok(());
    }
    let e = err_text(&out);
    // Có thay đổi chưa commit → gắn tiền tố để UI mời "mang theo sang nhánh mới".
    if is_dirty_refusal(&e) {
        return Err(format!("__DIRTY__{e}"));
    }
    Err(e)
}

/// Chuyển nhánh kèm theo thay đổi chưa commit: stash (cả file chưa track) → switch → pop.
/// Nếu switch lỗi thì trả stash về chỗ cũ; nếu pop xung đột thì báo rõ (đã chuyển nhánh nhưng còn xung đột).
#[tauri::command]
pub async fn git_switch_bring(path: String, branch: String, create: bool, track: bool) -> Result<String, String> {
    let _serial = repo_lock(&path).lock_owned().await;
    let st = raw(&path, &["stash", "push", "-u", "-m", "DevStation: chuyển nhánh"]).await?;
    if !st.status.success() {
        return Err(err_text(&st));
    }
    let stashed = !lossy(&st.stdout).contains("No local changes");
    let sw = raw(&path, &switch_args(&branch, create, track)).await?;
    if !sw.status.success() {
        if stashed {
            let _ = raw(&path, &["stash", "pop"]).await; // khôi phục trạng thái cũ
        }
        return Err(err_text(&sw));
    }
    if !stashed {
        return Ok(format!("đã chuyển sang {branch}"));
    }
    let pop = raw(&path, &["stash", "pop"]).await?;
    if pop.status.success() {
        Ok(format!("đã chuyển sang {branch}, mang theo thay đổi chưa commit"))
    } else {
        Err(format!(
            "Đã chuyển sang {branch} nhưng mang thay đổi sang bị xung đột — giải quyết trong danh sách file:\n{}",
            err_text(&pop)
        ))
    }
}

#[tauri::command]
pub async fn git_stash(path: String, pop: bool) -> Result<String, String> {
    let _serial = repo_lock(&path).lock_owned().await;
    let args: &[&str] = if pop { &["stash", "pop"] } else { &["stash", "push", "-u", "-m", "DevStation"] };
    git(&path, args).await.map(|s| s.trim().to_string())
}

/// Chạy một lệnh git dài (mạng) và stream tiến trình (stderr) qua event `git-progress`.
/// Trả về toàn bộ output gộp lại; lỗi cũng kèm output để hiển thị nguyên văn.
async fn run_streaming(app: &AppHandle, mut child: tokio::process::Child, job: &str, label: &str) -> Result<String, String> {
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let out_task = tokio::spawn(async move {
        let mut v = Vec::new();
        let _ = stdout.read_to_end(&mut v).await;
        v
    });

    // git ghi tiến trình ra stderr, dòng phần trăm kết thúc bằng \r (ghi đè), dòng thật kết thúc bằng \n.
    let emit = |text: &str, done: bool| {
        let _ = app.emit("git-progress", serde_json::json!({ "job": job, "line": text, "done": done }));
    };
    let (mut buf, mut line, mut log) = ([0u8; 4096], Vec::<u8>::new(), String::new());
    loop {
        let n = stderr.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        for &b in &buf[..n] {
            if b == b'\n' || b == b'\r' {
                if !line.is_empty() {
                    let text = lossy(&line);
                    emit(&text, b == b'\n');
                    if b == b'\n' {
                        log.push_str(&text);
                        log.push('\n');
                    }
                    line.clear();
                }
            } else {
                line.push(b);
            }
        }
    }
    if !line.is_empty() {
        let text = lossy(&line);
        emit(&text, true);
        log.push_str(&text);
    }
    let status = child.wait().await.map_err(|e| e.to_string())?;
    let stdout = lossy(&out_task.await.unwrap_or_default());
    let all = format!("{}\n{}", stdout.trim(), log.trim()).trim().to_string();
    if status.success() {
        Ok(all)
    } else if all.is_empty() {
        Err(format!("git {label} thất bại (mã {:?})", status.code()))
    } else {
        Err(all)
    }
}

/// fetch / pull / push: chạy lâu, cần mạng → stream tiến trình qua event `git-progress`.
#[tauri::command]
pub async fn git_remote(app: AppHandle, path: String, op: String, job: String) -> Result<String, String> {
    let _serial = repo_lock(&path).lock_owned().await;
    let args: &[&str] = match op.as_str() {
        "fetch" => &["fetch", "--all", "--prune", "--progress"],
        "pull" => &["pull", "--progress"],
        "push" => &["push", "--progress"],
        // Nhánh chưa có upstream: đẩy lên origin và đặt upstream luôn.
        "push-upstream" => &["push", "--progress", "-u", "origin", "HEAD"],
        _ => return Err(format!("thao tác không hỗ trợ: {op}")),
    };
    let child = cmd(&path, args).spawn().map_err(spawn_err)?;
    run_streaming(&app, child, &job, &op).await
}

/// Tên thư mục mặc định suy ra từ URL clone (bỏ đuôi .git và phần sau dấu /).
fn repo_folder_from_url(url: &str) -> String {
    let s = url.trim().trim_end_matches('/');
    let last = s.rsplit(|c| c == '/' || c == ':').next().unwrap_or(s);
    last.strip_suffix(".git").unwrap_or(last).to_string()
}

/// Clone repo vào `parent/folder`. Trả về đường dẫn thư mục đã clone (dấu `/`).
/// Dùng credential helper (GCM...) của máy — repo private vẫn hiện cửa sổ đăng nhập như bình thường.
#[tauri::command]
pub async fn git_clone(app: AppHandle, url: String, parent: String, folder: String, job: String) -> Result<String, String> {
    let name = {
        let f = folder.trim();
        if f.is_empty() { repo_folder_from_url(&url) } else { f.to_string() }
    };
    if name.is_empty() {
        return Err("Không xác định được tên thư mục đích từ URL".into());
    }
    let dest = Path::new(&parent).join(&name);
    if dest.exists() && std::fs::read_dir(&dest).map(|mut d| d.next().is_some()).unwrap_or(false) {
        return Err(format!("Thư mục đích đã tồn tại và không rỗng: {}", dest.display()));
    }
    let dest_str = dest.to_string_lossy().to_string();
    let child = cmd(&parent, &["clone", "--progress", "--", url.trim(), &dest_str])
        .spawn()
        .map_err(spawn_err)?;
    run_streaming(&app, child, &job, "clone").await?;
    Ok(dest_str.replace('\\', "/"))
}

/* ── Danh tính & đăng nhập ───────────────────────── */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    name: String,
    email: String,
    /// credential.helper toàn cục (vd. "manager"). Rỗng = chưa cấu hình, mật khẩu sẽ không được nhớ.
    helper: String,
}

/// Thư mục trung lập để chạy `git config --global` / `git credential` (không cần repo).
fn neutral_dir() -> String {
    std::env::temp_dir().to_string_lossy().to_string()
}

/// Đọc một giá trị config global, rỗng nếu chưa đặt.
async fn config_global(key: &str) -> String {
    let dir = neutral_dir();
    match raw(&dir, &["config", "--global", key]).await {
        Ok(out) if out.status.success() => lossy(&out.stdout).trim().to_string(),
        _ => String::new(),
    }
}

#[tauri::command]
pub async fn git_identity() -> Result<Identity, String> {
    Ok(Identity {
        name: config_global("user.name").await,
        email: config_global("user.email").await,
        helper: config_global("credential.helper").await,
    })
}

#[tauri::command]
pub async fn git_set_identity(name: String, email: String) -> Result<(), String> {
    let dir = neutral_dir();
    git(&dir, &["config", "--global", "user.name", name.trim()]).await?;
    git(&dir, &["config", "--global", "user.email", email.trim()]).await?;
    Ok(())
}

/// Bật Git Credential Manager để mật khẩu/token được lưu lại giữa các lần.
#[tauri::command]
pub async fn git_enable_manager() -> Result<(), String> {
    let dir = neutral_dir();
    git(&dir, &["config", "--global", "credential.helper", "manager"]).await.map(|_| ())
}

/// Lưu username + token cho một host vào credential helper của máy (giống `git credential approve`).
/// Với host GitHub: xác minh token qua API trước khi lưu để báo lỗi ngay nếu sai.
/// DevStation KHÔNG tự lưu token ở đâu khác — chỉ chuyển cho git. Token không bị ghi log.
/// Trả về tên tài khoản (login GitHub nếu xác minh được, không thì chính username).
#[tauri::command]
pub async fn git_store_credential(host: String, username: String, token: String) -> Result<String, String> {
    let host = host.trim();
    if host.is_empty() || username.trim().is_empty() || token.is_empty() {
        return Err("Cần đủ host, username và token".into());
    }
    let mut login = username.trim().to_string();
    if is_github(host) {
        login = github_login(host, &token).await?.0; // 401 → trả lỗi ngay, không lưu token sai
    }
    let dir = neutral_dir();
    let input = format!("protocol=https\nhost={host}\nusername={}\npassword={token}\n\n", username.trim());
    let mut child = cmd(&dir, &["credential", "approve"])
        .stdin(Stdio::piped())
        .spawn()
        .map_err(spawn_err)?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(input.as_bytes()).await.map_err(|e| e.to_string())?;
    }
    let out = child.wait_with_output().await.map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(login)
    } else {
        Err(err_text(&out))
    }
}

fn is_github(host: &str) -> bool {
    host == "github.com" || host.ends_with(".github.com") || host.contains("github")
}

/// Gọi API GitHub (hoặc GitHub Enterprise) để lấy login + tên thật từ token.
async fn github_login(host: &str, token: &str) -> Result<(String, Option<String>), String> {
    let api = if host == "github.com" {
        "https://api.github.com/user".to_string()
    } else {
        format!("https://{host}/api/v3/user")
    };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent(concat!("DevStation/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&api)
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| format!("Không gọi được GitHub: {e}"))?;
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("Token không hợp lệ hoặc đã hết hạn".into());
    }
    if !resp.status().is_success() {
        return Err(format!("GitHub trả về mã {}", resp.status().as_u16()));
    }
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let login = v.get("login").and_then(|x| x.as_str()).unwrap_or_default().to_string();
    if login.is_empty() {
        return Err("Không đọc được tài khoản từ phản hồi GitHub".into());
    }
    let name = v.get("name").and_then(|x| x.as_str()).filter(|s| !s.is_empty()).map(String::from);
    Ok((login, name))
}

/// Đọc credential đã lưu cho host MÀ KHÔNG bật cửa sổ đăng nhập (chỉ để xem trạng thái).
/// Trả (username, password) nếu helper đang giữ sẵn; None nếu chưa đăng nhập.
async fn credential_fill(host: &str) -> Option<(String, String)> {
    let dir = neutral_dir();
    // credential.interactive=false + GIT_TERMINAL_PROMPT=0: không bao giờ hiện popup đăng nhập.
    let mut c = cmd(&dir, &["-c", "credential.interactive=false", "credential", "fill"]);
    c.env("GCM_INTERACTIVE", "never").stdin(Stdio::piped());
    let mut child = c.spawn().ok()?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(format!("protocol=https\nhost={host}\n\n").as_bytes()).await;
    }
    let out = child.wait_with_output().await.ok()?;
    if !out.status.success() {
        return None;
    }
    let (mut user, mut pass) = (None, None);
    for line in lossy(&out.stdout).lines() {
        if let Some(v) = line.strip_prefix("username=") {
            user = Some(v.to_string());
        } else if let Some(v) = line.strip_prefix("password=") {
            pass = Some(v.to_string());
        }
    }
    match (user, pass) {
        (Some(u), Some(p)) if !p.is_empty() => Some((u, p)),
        _ => None,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitAccount {
    host: String,
    /// Đã có credential lưu cho host này chưa.
    signed_in: bool,
    /// Username lưu trong credential helper.
    username: Option<String>,
    /// Login GitHub (nếu xác minh được qua API).
    login: Option<String>,
    /// Tên hiển thị trên GitHub.
    name: Option<String>,
    /// Ghi chú khi đã lưu nhưng chưa xác minh được (vd. mất mạng, token hết hạn).
    note: Option<String>,
}

/// Trạng thái đăng nhập của một host: ai đang đăng nhập (với GitHub lấy luôn login + tên thật).
/// KHÔNG trả token về UI.
#[tauri::command]
pub async fn git_account(host: String) -> Result<GitAccount, String> {
    let host = host.trim().to_string();
    let Some((username, token)) = credential_fill(&host).await else {
        return Ok(GitAccount { host, signed_in: false, username: None, login: None, name: None, note: None });
    };
    if is_github(&host) {
        return Ok(match github_login(&host, &token).await {
            Ok((login, name)) => GitAccount { host, signed_in: true, username: Some(username), login: Some(login), name, note: None },
            Err(e) => GitAccount {
                host,
                signed_in: true,
                username: Some(username),
                login: None,
                name: None,
                note: Some(format!("Đã lưu đăng nhập nhưng chưa xác minh được với GitHub: {e}")),
            },
        });
    }
    Ok(GitAccount { host, signed_in: true, username: Some(username), login: None, name: None, note: None })
}

/// Đăng xuất: xoá credential đã lưu cho host (git credential reject).
#[tauri::command]
pub async fn git_sign_out(host: String, username: String) -> Result<(), String> {
    let host = host.trim();
    let dir = neutral_dir();
    let input = if username.trim().is_empty() {
        format!("protocol=https\nhost={host}\n\n")
    } else {
        format!("protocol=https\nhost={host}\nusername={}\n\n", username.trim())
    };
    let mut child = cmd(&dir, &["credential", "reject"]).stdin(Stdio::piped()).spawn().map_err(spawn_err)?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(input.as_bytes()).await.map_err(|e| e.to_string())?;
    }
    let out = child.wait_with_output().await.map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(err_text(&out))
    }
}

/// Mẫu .gitignore cho một file: đúng file đó, cả thư mục cha, hay theo đuôi mở rộng.
fn ignore_pattern(file: &str, scope: &str) -> String {
    let p = file.trim_start_matches('/').replace('\\', "/");
    match scope {
        "ext" => p
            .rsplit('.')
            .next()
            .filter(|e| !e.is_empty() && *e != p)
            .map(|e| format!("*.{e}"))
            .unwrap_or_default(),
        "parent" => match p.rfind('/') {
            Some(i) => format!("/{}/", &p[..i]),
            None => String::new(),
        },
        _ => format!("/{p}"),
    }
}

/// Thêm mẫu vào .gitignore (bỏ qua nếu đã có). File đang được theo dõi thì phải bỏ theo dõi nữa,
/// vì .gitignore chỉ có tác dụng với file chưa track. Trả về mẫu đã thêm.
#[tauri::command]
pub async fn git_ignore(path: String, file: String, scope: String, untrack: bool) -> Result<String, String> {
    let _serial = repo_lock(&path).lock_owned().await;
    let pattern = ignore_pattern(&file, &scope);
    if pattern.is_empty() {
        return Err("Không xác định được mẫu bỏ qua cho file này".into());
    }
    let gi = Path::new(&path).join(".gitignore");
    let mut content = std::fs::read_to_string(&gi).unwrap_or_default();
    if !content.lines().any(|l| l.trim() == pattern) {
        if !content.is_empty() && !content.ends_with('\n') {
            content.push('\n');
        }
        content.push_str(&pattern);
        content.push('\n');
        std::fs::write(&gi, content).map_err(|e| e.to_string())?;
    }
    if untrack {
        git(&path, &["rm", "--cached", "--ignore-unmatch", "-q", "--", &file]).await?;
    }
    Ok(pattern)
}

/// Mở Explorer tại file (chọn sẵn file đó) hoặc tại thư mục repo.
#[tauri::command]
pub fn git_reveal(path: String, file: Option<String>) -> Result<(), String> {
    let full = match file.as_deref() {
        Some(f) => Path::new(&path).join(f),
        None => PathBuf::from(&path),
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut c = std::process::Command::new("explorer.exe");
        match file {
            // raw_arg: đưa nguyên văn /select,"đường dẫn" để explorer không hiểu sai khi có dấu cách.
            Some(_) => c.raw_arg(format!("/select,\"{}\"", full.display())),
            None => c.raw_arg(format!("\"{}\"", full.display())),
        };
        c.spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        let dir = if file.is_some() {
            full.parent().map(Path::to_path_buf).unwrap_or(full)
        } else {
            full
        };
        if file.is_some() {
            std::process::Command::new("open").arg("-R").arg(dir).spawn().map_err(|e| e.to_string())?;
        } else {
            std::process::Command::new("open").arg(dir).spawn().map_err(|e| e.to_string())?;
        }
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        let dir = if file.is_some() {
            full.parent().map(Path::to_path_buf).unwrap_or(full)
        } else {
            full
        };
        std::process::Command::new("xdg-open").arg(dir).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ten_thu_muc_tu_url() {
        assert_eq!(repo_folder_from_url("https://github.com/a/admin_hub.git"), "admin_hub");
        assert_eq!(repo_folder_from_url("git@github.com:a/admin_hub.git"), "admin_hub");
        assert_eq!(repo_folder_from_url("https://gitlab.com/g/proj/"), "proj");
    }

    #[test]
    fn url_commit_tu_remote() {
        let h = "abc123";
        assert_eq!(commit_web_url("git@github.com:a/admin_hub.git", h).unwrap(), "https://github.com/a/admin_hub/commit/abc123");
        assert_eq!(commit_web_url("https://github.com/a/admin_hub.git", h).unwrap(), "https://github.com/a/admin_hub/commit/abc123");
        assert_eq!(commit_web_url("git@gitlab.com:g/proj.git", h).unwrap(), "https://gitlab.com/g/proj/-/commit/abc123");
        assert_eq!(commit_web_url("https://bitbucket.org/t/repo.git", h).unwrap(), "https://bitbucket.org/t/repo/commits/abc123");
        assert_eq!(commit_web_url("ssh://git@github.com/a/b.git", h).unwrap(), "https://github.com/a/b/commit/abc123");
        assert!(commit_web_url("/local/path", h).is_none());
    }

    #[test]
    fn mau_gitignore() {
        assert_eq!(ignore_pattern("src/app/Foo.cs", "file"), "/src/app/Foo.cs");
        assert_eq!(ignore_pattern("src/app/Foo.cs", "parent"), "/src/app/");
        assert_eq!(ignore_pattern("src/app/Foo.cs", "ext"), "*.cs");
        assert_eq!(ignore_pattern("Makefile", "ext"), ""); // không có đuôi
        assert_eq!(ignore_pattern("README", "parent"), ""); // file ở gốc repo
    }

    #[test]
    fn doc_status_porcelain_v2() {
        let text = "# branch.oid 1234567890abcdef\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0\
            1 .M N... 100644 100644 100644 aaa bbb src/Tiếng Việt.ts\0\
            1 A. N... 000000 100644 100644 000 ccc new file.txt\0\
            2 R. N... 100644 100644 100644 ddd eee R100 b.txt\0a.txt\0\
            u UU N... 100644 100644 100644 100644 f1 f2 f3 conflict.rs\0\
            ? chưa theo dõi.md\0";
        let st = parse_status(text);
        assert_eq!(st.branch.as_deref(), Some("main"));
        assert_eq!(st.upstream.as_deref(), Some("origin/main"));
        assert_eq!((st.ahead, st.behind), (2, 1));
        assert_eq!(st.head.as_deref(), Some("12345678"));
        assert_eq!(st.files.len(), 5);
        assert_eq!(st.files[0].path, "src/Tiếng Việt.ts");
        assert_eq!((st.files[0].x, st.files[0].y), ('.', 'M'));
        assert_eq!(st.files[1].path, "new file.txt");
        assert_eq!(st.files[2].orig.as_deref(), Some("a.txt"));
        assert_eq!(st.files[3].kind, "conflict");
        assert!(st.conflicted);
        assert_eq!(st.files[4].path, "chưa theo dõi.md");
    }

    #[test]
    fn detached_va_repo_moi() {
        let st = parse_status("# branch.oid (initial)\0# branch.head (detached)\0");
        assert!(st.branch.is_none() && st.head.is_none());
    }

    /// Chạy git thật trên repo tạm: commit → sửa → status → diff → stage → log.
    #[tokio::test]
    async fn vong_doi_repo_that() {
        let dir = std::env::temp_dir().join(format!("devstation-git-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.to_string_lossy().to_string();
        git(&p, &["init", "-q", "-b", "main"]).await.unwrap();
        git(&p, &["config", "user.name", "Test"]).await.unwrap();
        git(&p, &["config", "user.email", "test@example.com"]).await.unwrap();
        assert!(git_log(p.clone(), None).await.unwrap().is_empty());

        std::fs::write(dir.join("a.txt"), "dòng 1\n").unwrap();
        git_stage(p.clone(), vec!["a.txt".into()]).await.unwrap();
        git_commit(p.clone(), "Commit đầu\n\nthân".into()).await.unwrap();

        std::fs::write(dir.join("a.txt"), "dòng 1\ndòng 2\n").unwrap();
        std::fs::write(dir.join("mới.txt"), "x\n").unwrap();
        let st = git_status(p.clone()).await.unwrap();
        assert_eq!(st.branch.as_deref(), Some("main"));
        assert_eq!(st.files.len(), 2);

        let d = git_diff(p.clone(), "a.txt".into(), false, false).await.unwrap();
        assert!(d.contains("+dòng 2"));
        let d = git_diff(p.clone(), "mới.txt".into(), false, true).await.unwrap();
        assert!(d.contains("+x"));

        git_stage(p.clone(), vec!["a.txt".into()]).await.unwrap();
        let st = git_status(p.clone()).await.unwrap();
        let a = st.files.iter().find(|f| f.path == "a.txt").unwrap();
        assert_eq!((a.x, a.y), ('M', '.'));

        git_discard(p.clone(), vec![], vec!["mới.txt".into()]).await.unwrap();
        git_commit(p.clone(), "Commit hai".into()).await.unwrap();
        let log = git_log(p.clone(), None).await.unwrap();
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].subject, "Commit hai");
        assert!(git_status(p.clone()).await.unwrap().files.is_empty());

        assert!(!git_head_pushed(p.clone()).await.unwrap()); // chưa có remote

        // Bỏ commit chưa push: commit biến mất, thay đổi vẫn ở Staged, message được trả lại.
        let msg = git_undo_commit(p.clone()).await.unwrap();
        assert_eq!(msg, "Commit hai");
        assert_eq!(git_log(p.clone(), None).await.unwrap().len(), 1);
        let a = git_status(p.clone()).await.unwrap().files.into_iter().find(|f| f.path == "a.txt").unwrap();
        assert_eq!(a.x, 'M');

        // Commit duy nhất → không còn commit trước để lùi.
        assert!(git_undo_commit(p.clone()).await.is_err());
        git_commit(p.clone(), "Commit hai".into()).await.unwrap();
        git_switch(p.clone(), "feature/x".into(), true, false).await.unwrap();
        let br = git_branches(p.clone()).await.unwrap();
        assert!(br.iter().any(|b| b.name == "feature/x" && b.current));

        // Bỏ qua file chưa track: chỉ cần .gitignore.
        std::fs::write(dir.join("bỏ.txt"), "x\n").unwrap();
        assert_eq!(git_ignore(p.clone(), "bỏ.txt".into(), "file".into(), false).await.unwrap(), "/bỏ.txt");
        assert!(std::fs::read_to_string(dir.join(".gitignore")).unwrap().contains("/bỏ.txt"));
        assert!(!git_status(p.clone()).await.unwrap().files.iter().any(|f| f.path == "bỏ.txt"));

        // Bỏ qua file đã track: thêm .gitignore + bỏ theo dõi (không còn trong index).
        git_ignore(p.clone(), "a.txt".into(), "ext".into(), true).await.unwrap();
        assert!(git(&p, &["ls-files", "a.txt"]).await.unwrap().trim().is_empty());
        assert!(std::fs::read_to_string(dir.join(".gitignore")).unwrap().contains("*.txt"));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
