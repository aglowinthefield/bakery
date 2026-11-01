fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["connect", "saved_server"])),
    )
    .expect("failed to build Bakery desktop");
}
