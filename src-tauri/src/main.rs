// P0 spike shell (W2). Responsibilities: spawn the production sidecar, wait for its ready handshake, load the trusted
// editor from the sidecar's exact loopback origin, expose two narrow commands, and shut the sidecar down on quit.
// It never loads generated scenes: the sidecar serves the editor with frame-src 'none'.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod sidecar;
use sidecar::{Ready, SidecarProcess};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::ipc::CapabilityBuilder;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

struct Sidecar {
    process: Mutex<SidecarProcess>,
    origin: String,
}

fn sidecar_path() -> std::path::PathBuf {
    if let Ok(p) = std::env::var("YINGLIU_SIDECAR") {
        return p.into();
    }
    let exe = std::env::current_exe().expect("current_exe");
    exe.parent()
        .unwrap()
        .join("sidecar")
        .join(if cfg!(windows) {
            "yingliu-sidecar.exe"
        } else {
            "yingliu-sidecar"
        })
}

fn spawn_sidecar(data: &std::path::Path) -> Result<(SidecarProcess, Ready), String> {
    let bin = sidecar_path();
    let resources = bin
        .parent()
        .ok_or("sidecar 路径缺少父目录")?
        .join("resources");
    let t0 = Instant::now();
    let mut command = Command::new(&bin);
    command
        .arg("--data-root")
        .arg(data.join("data"))
        .arg("--projects-root")
        .arg(data.join("projects"))
        .arg("--resource-root")
        .arg(&resources);
    if std::env::var("YINGLIU_P0_MOCK").is_ok() {
        command.arg("--mock");
    }
    let (owned, ready) = SidecarProcess::spawn(&mut command, Duration::from_secs(30))?;
    eprintln!(
        "[p0-shell] sidecar ready in {} ms profile={} origin={}",
        t0.elapsed().as_millis(),
        ready.profile_id,
        ready.origin
    );
    Ok((owned, ready))
}

fn shutdown(state: &Sidecar) {
    state
        .process
        .lock()
        .unwrap()
        .shutdown(Duration::from_secs(15));
}

#[tauri::command]
async fn pick_project(app: tauri::AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .set_title("打开影片工程目录")
        .blocking_pick_folder()
        .map(|p| p.to_string())
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![pick_project, quit_app])
        .setup(|app| {
            let data = std::env::var("YINGLIU_DATA_DIR")
                .map(std::path::PathBuf::from)
                .unwrap_or(app.path().app_data_dir()?);
            let (process, ready) = spawn_sidecar(&data).map_err(|e| {
                eprintln!("[p0-shell] {e}");
                e
            })?;
            let origin = ready.origin.trim_end_matches('/').to_string();
            // Exact-origin capability for the trusted editor only: our two app commands, nothing else.
            app.add_capability(
                CapabilityBuilder::new("editor-exact-origin")
                    .window("main")
                    .remote(format!("{origin}/*"))
                    .permission("allow-pick-project")
                    .permission("allow-quit-app"),
            )?;
            let url: url::Url = format!("{origin}/").parse().unwrap();
            let allowed = origin.clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("映流智能体（P0 Tauri 验证壳）")
                .inner_size(1600.0, 1000.0)
                .min_inner_size(1100.0, 700.0)
                // Navigation escape guard: the main WebView may only show the editor origin.
                .on_navigation(move |u| u.origin().ascii_serialization() == allowed)
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                // Measurement hook for docs/p0/MEASUREMENT.md (cold start = process spawn → editor page load finished).
                .on_page_load(|w, p| {
                    if matches!(p.event(), tauri::webview::PageLoadEvent::Finished) {
                        eprintln!(
                            "[p0-shell] page-load-finished url={} pid={}",
                            p.url().origin().ascii_serialization(),
                            std::process::id()
                        );
                        let _ = w;
                    }
                })
                .build()?;
            app.manage(Sidecar {
                process: Mutex::new(process),
                origin,
            });
            if std::env::var("YINGLIU_P0_EXIT_AFTER_READY").is_ok() {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(3));
                    handle.exit(0);
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("tauri build");
    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = handle.try_state::<Sidecar>() {
                let _ = &state.origin;
                shutdown(&state);
            }
        }
    });
}
