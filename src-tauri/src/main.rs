// Ẩn cửa sổ console khi chạy bản release trên Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;

mod db;
mod git;
mod http;
mod owners;
mod pdf;
mod pdfsig;
mod procjob;
mod redis;
mod registry;
mod sftp;
mod ssh;
mod webtr;
mod update;

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
    let builder = tauri::Builder::default();
    // Phải đăng ký ĐẦU TIÊN: mở file .pdf khi app đang chạy → chuyển cho tiến trình đang chạy (app PDF).
    // Chỉ ở bản cài: bản dev (`app:dev`) cùng identifier → đang mở bản cài thì bản dev bị chuyển sang đó rồi tự thoát.
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| pdf::on_second_instance(app, argv, cwd)));
    builder
        .plugin(tauri_plugin_dialog::init())
        // Tự cập nhật: đọc latest.json trên GitHub Releases, kiểm chữ ký bằng pubkey trong tauri.conf.json.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(webtr::plugin())
        .manage(db::DbState::default())
        .manage(ssh::SshState::default())
        .manage(sftp::SftpState::default())
        .manage(redis::RedisState::default())
        .manage(owners::Owners::default())
        .manage(registry::RegistryState::default())
        .manage(pdf::PdfState::default())
        .manage(update::UpdState::default())
        .setup(|app| {
            git::init(app.handle().clone());
            pdf::init(app.handle());
            Ok(())
        })
        // Đóng cửa sổ app (nút X) / tải lại trang: React không kịp dọn → Rust đóng mọi phiên của cửa sổ đó.
        .on_window_event(|window, ev| {
            if let tauri::WindowEvent::Destroyed = ev {
                owners::cleanup(window.app_handle(), window.label());
            }
        })
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                owners::cleanup(webview.app_handle(), webview.label());
            }
        })
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
            git::git_set_trace,
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
            git::git_resolve_side,
            git::git_merge_abort,
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
            http::http_cancel,
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
            ssh::ssh_tunnel_running,
            ssh::ssh_stat_start,
            ssh::ssh_stat_stop,
            ssh::ssh_docker_ps,
            ssh::ssh_shell_history,
            ssh::ssh_sudo_fs,
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
            ssh::docker_fs_write,
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
            sftp::sftp_write,
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
            registry::registry_login,
            registry::registry_projects,
            registry::registry_repos,
            registry::registry_artifacts,
            registry::registry_pull,
            registry::registry_cancel,
            registry::registry_zip,
            webtr::webtr_open,
            webtr::webtr_test,
            webtr::webtr_save_key,
            webtr::webtr_has_key,
            webtr::webtr_forget_key,
            webtr::webtr_clear_cache,
            webtr::webtr_cache_size,
            registry::registry_temp_dir,
            registry::registry_move,
            registry::registry_discard,
            registry::registry_save_password,
            registry::registry_get_password,
            registry::registry_forget_password,
            pdf::pdf_read,
            pdf::pdf_verify,
            pdf::pdf_verify_path,
            pdf::pdf_open_url,
            pdf::pdf_has_pending,
            pdf::pdf_take_pending,
            pdf::pdf_trust_list,
            pdf::pdf_trust_add,
            pdf::pdf_trust_remove,
            pdf::pdf_default_status,
            pdf::pdf_register_default,
            pdf::pdf_unregister_default,
            update::update_status,
            update::update_check,
            update::update_install,
            pdf::pdf_open_settings,
        ])
        .build(tauri::generate_context!())
        .expect("không khởi động được DevStation")
        .run(|app, ev| {
            // Tắt app: kill tiến trình ssh/sftp con (Windows không tự kill con → tunnel mồ côi giữ kết nối server).
            if let tauri::RunEvent::Exit = ev {
                ssh::kill_all(&app.state::<ssh::SshState>());
                sftp::kill_all(&app.state::<sftp::SftpState>());
                // Đã tải sẵn bản mới mà chọn "Muộn hơn" → tắt hẳn app là cài luôn (không mở lại app).
                update::install_on_exit(&app.state::<update::UpdState>());
            }
        });
}
