// P0 spike shell (W2). Responsibilities: spawn the production sidecar, wait for its ready handshake, load the trusted
// editor from the sidecar's exact loopback origin, expose two narrow commands, and shut the sidecar down on quit.
// It never loads generated scenes: the sidecar serves the editor with frame-src 'none'.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::ipc::CapabilityBuilder;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

struct Sidecar { child: Mutex<Option<Child>>, stdin: Mutex<Option<ChildStdin>>, origin: String }

#[derive(serde::Deserialize)]
struct Ready { r#type: String, #[serde(rename = "protocolVersion")] protocol_version: u32, origin: String, #[serde(rename = "profileId")] profile_id: String }

const PROTOCOL_VERSION: u32 = 1;

fn sidecar_path() -> std::path::PathBuf {
    if let Ok(p) = std::env::var("YINGLIU_SIDECAR") { return p.into(); }
    let exe = std::env::current_exe().expect("current_exe");
    exe.parent().unwrap().join("sidecar").join(if cfg!(windows) { "yingliu-sidecar.exe" } else { "yingliu-sidecar" })
}

fn spawn_sidecar(data: &std::path::Path) -> Result<(Child, ChildStdin, Ready), String> {
    let bin = sidecar_path();
    let resources = bin.parent().unwrap().join("resources");
    let t0 = Instant::now();
    let mut child = Command::new(&bin)
        .arg("--data-root").arg(data.join("data"))
        .arg("--projects-root").arg(data.join("projects"))
        .arg("--resource-root").arg(&resources)
        .args(if std::env::var("YINGLIU_P0_MOCK").is_ok() { vec!["--mock"] } else { vec![] })
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit())
        .spawn().map_err(|e| format!("无法启动 sidecar {}: {e}", bin.display()))?;
    let stdin = child.stdin.take().unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    // The first stdout line is the handshake; it carries the per-launch token, so it is never logged.
    let line = lines.next().ok_or("sidecar 未输出 ready 握手")?.map_err(|e| e.to_string())?;
    let ready: Ready = serde_json::from_str(&line).map_err(|_| "sidecar 握手不是 ready JSON".to_string())?;
    if ready.r#type != "ready" { let _ = child.kill(); return Err("sidecar 启动失败（见 stderr / 握手 error 行）".into()); }
    if ready.protocol_version != PROTOCOL_VERSION { let _ = child.kill(); return Err(format!("sidecar 协议版本 {} 与壳 {} 不兼容", ready.protocol_version, PROTOCOL_VERSION)); }
    let origin = url::Url::parse(&ready.origin).map_err(|e| e.to_string())?;
    if origin.scheme() != "http" || origin.host_str() != Some("127.0.0.1") { let _ = child.kill(); return Err("sidecar origin 必须是 http://127.0.0.1".into()); }
    eprintln!("[p0-shell] sidecar ready in {} ms profile={} origin={}", t0.elapsed().as_millis(), ready.profile_id, ready.origin);
    std::thread::spawn(move || { for _ in lines {} }); // drain later lines (shutdown ack)
    Ok((child, stdin, ready))
}

fn shutdown(state: &Sidecar) {
    if let Some(mut stdin) = state.stdin.lock().unwrap().take() { let _ = stdin.write_all(b"{\"type\":\"shutdown\"}\n"); }
    if let Some(mut child) = state.child.lock().unwrap().take() {
        let until = Instant::now() + Duration::from_secs(15);
        while Instant::now() < until { if let Ok(Some(_)) = child.try_wait() { return; } std::thread::sleep(Duration::from_millis(50)); }
        let _ = child.kill(); let _ = child.wait(); // only our own child
    }
}

#[tauri::command]
async fn pick_project(app: tauri::AppHandle) -> Option<String> {
    app.dialog().file().set_title("打开影片工程目录").blocking_pick_folder().map(|p| p.to_string())
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) { app.exit(0); }

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![pick_project, quit_app])
        .setup(|app| {
            let data = std::env::var("YINGLIU_DATA_DIR").map(std::path::PathBuf::from).unwrap_or(app.path().app_data_dir()?);
            let (child, stdin, ready) = spawn_sidecar(&data).map_err(|e| { eprintln!("[p0-shell] {e}"); e })?;
            let origin = ready.origin.trim_end_matches('/').to_string();
            // Exact-origin capability for the trusted editor only: our two app commands, nothing else.
            app.add_capability(CapabilityBuilder::new("editor-exact-origin").window("main").remote(format!("{origin}/*")).permission("allow-pick-project").permission("allow-quit-app"))?;
            let url: url::Url = format!("{origin}/").parse().unwrap();
            let allowed = origin.clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("映流智能体（P0 Tauri 验证壳）").inner_size(1600.0, 1000.0).min_inner_size(1100.0, 700.0)
                // Navigation escape guard: the main WebView may only show the editor origin.
                .on_navigation(move |u| u.origin().ascii_serialization() == allowed)
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .build()?;
            app.manage(Sidecar { child: Mutex::new(Some(child)), stdin: Mutex::new(Some(stdin)), origin });
            if std::env::var("YINGLIU_P0_EXIT_AFTER_READY").is_ok() {
                let handle = app.handle().clone();
                std::thread::spawn(move || { std::thread::sleep(Duration::from_secs(3)); handle.exit(0); });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("tauri build");
    app.run(|handle, event| {
        if let RunEvent::Exit = event { if let Some(state) = handle.try_state::<Sidecar>() { let _ = &state.origin; shutdown(&state); } }
    });
}
