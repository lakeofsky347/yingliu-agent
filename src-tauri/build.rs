fn main() {
    // Custom app commands must be declared so they enter the ACL (they are denied unless a capability allows them).
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["pick_project", "quit_app"])),
    )
    .expect("tauri build script");
}
