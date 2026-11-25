fn main() {
    // Plugin nội bộ `webtr` (Web Translate): sinh permission `webtr:allow-translate` để cấp RIÊNG lệnh này cho
    // trang web ngoài trong cửa sổ `webtr-*` (capabilities/webtr.json). Lệnh của app vẫn bị chặn với origin remote.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .plugin("webtr", tauri_build::InlinedPlugin::new().commands(&["translate"])),
    )
    .expect("tauri build");
}
