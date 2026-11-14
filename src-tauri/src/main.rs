// Ẩn cửa sổ console khi chạy bản release trên Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod db;
mod git;
mod http;
mod redis;
mod sftp;
mod ssh;

/// Lệnh mẫu để UI kiểm tra cầu nối Rust ↔ webview.
/// Các module git / http / ssh sẽ đăng ký lệnh của mình vào đây.
#[tauri::command]
fn app_info() -> serde_json::Value {
    serde_json::json!({
        "name": "DevStation",
        "version": env!("CARGO_PKG_VERSION"),
    })
}

/// Ghi nội dung text ra file (dùng cho "Dump SQL" sau khi người dùng chọn đường dẫn).
#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| format!("Không ghi được {path}: {e}"))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Tự cập nhật: đọc latest.json trên GitHub Releases, kiểm chữ ký bằng pubkey trong tauri.conf.json.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(db::DbState::default())
        .manage(ssh::SshState::default())
        .manage(sftp::SftpState::default())
        .manage(redis::RedisState::default())
        .invoke_handler(tauri::generate_handler![
            app_info,
            write_text_file,
            db::db_connect,
            db::db_disconnect,
            db::db_query,
            db::db_cancel,
            db::db_tables,
            db::db_databases,
            db::db_columns,
            db::db_table_columns,
            db::db_struct,
            db::db_save_password,
            db::db_get_password,
            db::db_forget_password,
            git::git_status,
            git::git_root,
            git::git_find_repos,
            git::git_diff,
            git::git_file_diff,
            git::git_log,
            git::git_show,
            git::git_undo_commit,
            git::git_commit_message,
            git::git_reword_head,
            git::git_revert,
            git::git_reset_to,
            git::git_checkout_commit,
            git::git_branch_at,
            git::git_open_commit_remote,
            git::git_head_pushed,
            git::git_branches,
            git::git_merge,
            git::git_rename_branch,
            git::git_delete_branch,
            git::git_stage,
            git::git_unstage,
            git::git_discard,
            git::git_discard_all,
            git::git_commit,
            git::git_switch,
            git::git_switch_bring,
            git::git_stash,
            git::git_remote,
            git::git_ignore,
            git::git_reveal,
            git::git_clone,
            git::git_identity,
            git::git_set_identity,
            git::git_enable_manager,
            git::git_store_credential,
            git::git_account,
            git::git_sign_out,
            http::http_send,
            http::http_read_file,
            http::http_read_dir,
            ssh::ssh_connect,
            ssh::ssh_send,
            ssh::ssh_resize,
            ssh::ssh_disconnect,
            ssh::ssh_forget_password,
            ssh::ssh_has_password,
            ssh::ssh_tunnel_open,
            ssh::ssh_tunnel_close,
            ssh::ssh_stat_start,
            ssh::ssh_stat_stop,
            ssh::ssh_docker_ps,
            ssh::docker_fs_list,
            ssh::docker_fs_home,
            ssh::docker_fs_cd,
            ssh::docker_fs_read,
            ssh::docker_fs_get,
            ssh::docker_fs_mkdir,
            ssh::docker_fs_rm,
            ssh::docker_fs_rmdir,
            ssh::docker_fs_rename,
            ssh::docker_fs_touch,
            sftp::sftp_open,
            sftp::sftp_close,
            sftp::sftp_home,
            sftp::sftp_cd,
            sftp::sftp_list,
            sftp::sftp_read,
            sftp::sftp_get,
            sftp::sftp_put,
            sftp::sftp_mkdir,
            sftp::sftp_touch,
            sftp::sftp_rm,
            sftp::sftp_rmdir,
            sftp::sftp_rename,
            redis::redis_connect,
            redis::redis_disconnect,
            redis::redis_scan,
            redis::redis_key,
            redis::redis_set_string,
            redis::redis_del,
            redis::redis_dbsize,
            redis::redis_select,
            redis::redis_databases,
            redis::redis_info,
            redis::redis_save_password,
            redis::redis_get_password,
            redis::redis_forget_password,
        ])
        .run(tauri::generate_context!())
        .expect("không khởi động được DevStation");
}
