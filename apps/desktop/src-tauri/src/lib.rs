// PROPRIX 데스크톱 셸: daemon(sidecar)을 띄우고 수명을 관리한다. 창 닫기는 트레이로 숨김, 트레이 메뉴로 열기·종료,
// 두 번째 실행은 기존 창을 보인다. 시작 시 자동 실행이면 --hidden 으로 창 없이 시작한다.
// daemon 은 127.0.0.1 의 빈 포트에서 이 셸이 만든 토큰으로만 열린다. SPA 는 endpoint 명령으로 주소·토큰을 받는다.
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

// 앱 창의 origin (Windows WebView2 기본 http, https 설정 시 https)
const APP_ORIGINS: &str = "http://tauri.localhost,https://tauri.localhost";
const READY_TIMEOUT: Duration = Duration::from_secs(20);
const STOP_GRACE: Duration = Duration::from_secs(3);
const SHOW_AFTER_RESTART: &str = "PROPRIX_SHOW_AFTER_RESTART";

#[derive(Clone, Serialize)]
struct Endpoint {
    url: String,
    token: String,
}

struct Daemon {
    port: u16,
    endpoint: Endpoint,
    child: Mutex<Option<CommandChild>>,
}

fn free_port() -> std::io::Result<u16> {
    Ok(TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
}

fn new_token() -> String {
    let mut buf = [0u8; 32];
    getrandom::fill(&mut buf).expect("난수 생성 실패");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

// GET /api/health 가 200 이면 준비됨 (HTTP 클라이언트 의존성 없이)
fn healthy(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_millis(300)) else {
        return false;
    };
    let _ = s.set_read_timeout(Some(Duration::from_millis(1000)));
    let req = format!("GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if s.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut head = [0u8; 16];
    matches!(s.read(&mut head), Ok(n) if n >= 12 && head[..n].starts_with(b"HTTP/1.1 200"))
}

// SPA 가 처음 부른다: daemon 이 준비될 때까지 기다렸다가 주소·토큰을 준다
#[tauri::command]
async fn endpoint(state: tauri::State<'_, Daemon>) -> Result<Endpoint, String> {
    let port = state.port;
    let ready = tauri::async_runtime::spawn_blocking(move || {
        let start = Instant::now();
        while start.elapsed() < READY_TIMEOUT {
            if healthy(port) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        false
    })
    .await
    .unwrap_or(false);
    if ready {
        Ok(state.endpoint.clone())
    } else {
        Err("daemon 이 시작되지 않음".into())
    }
}

// 백업 복구 적용: Exit 처리에서 daemon 을 닫은 뒤 다시 띄운다. 자동 실행(--hidden)으로 켠 앱이어도 창을 다시 보인다
#[tauri::command]
fn restart_app(app: AppHandle) {
    std::env::set_var(SHOW_AFTER_RESTART, "1");
    app.request_restart();
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn spawn_daemon(app: &tauri::App) -> Result<Daemon, Box<dyn std::error::Error>> {
    let port = free_port()?;
    let token = new_token();
    #[allow(unused_mut)]
    let mut cmd = app
        .shell()
        .sidecar("proprix-daemon")?
        .env("PROPRIX_PORT", port.to_string())
        .env("PROPRIX_API_TOKEN", &token)
        .env("PROPRIX_ALLOWED_ORIGINS", APP_ORIGINS)
        .env("PROPRIX_EXIT_WITH_STDIN", "1");
    // 개발 빌드: 앱 데이터가 비어 있으면 저장소의 개발용 데이터(.data)를 한 번 가져온다 (로그인 제외)
    #[cfg(debug_assertions)]
    {
        let dev_data = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../.data");
        if dev_data.exists() {
            cmd = cmd.env("PROPRIX_IMPORT_DIR", dev_data);
        }
    }
    let (mut rx, child) = cmd.spawn()?;
    tauri::async_runtime::spawn(async move {
        while let Some(ev) = rx.recv().await {
            match ev {
                CommandEvent::Stdout(line) => print!("[daemon] {}", String::from_utf8_lossy(&line)),
                CommandEvent::Stderr(line) => eprint!("[daemon] {}", String::from_utf8_lossy(&line)),
                CommandEvent::Terminated(p) => eprintln!("[daemon] 종료됨 code={:?}", p.code),
                _ => {}
            }
        }
    });
    Ok(Daemon {
        port,
        endpoint: Endpoint { url: format!("http://127.0.0.1:{port}"), token },
        child: Mutex::new(Some(child)),
    })
}

// 종료: stdin 을 닫아(child 를 놓아) daemon 이 스트림·DB 를 정리하고 끝내게 기다렸다가, 남아 있으면 강제 종료
fn stop_daemon(app: &AppHandle) {
    let Some(state) = app.try_state::<Daemon>() else { return };
    let Some(child) = state.child.lock().ok().and_then(|mut c| c.take()) else { return };
    let pid = child.pid();
    drop(child);
    let start = Instant::now();
    while start.elapsed() < STOP_GRACE && healthy(state.port) {
        std::thread::sleep(Duration::from_millis(100));
    }
    if healthy(state.port) {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .creation_flags(CREATE_NO_WINDOW)
                .status();
        }
        #[cfg(not(windows))]
        let _ = std::process::Command::new("kill").args(["-9", &pid.to_string()]).status();
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        // 두 번째 실행은 기존 창을 보인다 (가장 먼저 등록해야 한다)
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        // 로그인·외부 링크는 앱 창이 아니라 시스템 브라우저로
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .setup(|app| {
            let daemon = spawn_daemon(app)?;
            app.manage(daemon);

            let open = MenuItem::with_id(app, "open", "열기", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            let mut tray = TrayIconBuilder::with_id("main")
                .tooltip("PROPRIX")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "open" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = e
                    {
                        show_main(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            // 시작 시 자동 실행(--hidden)이면 트레이에만
            let restarted = std::env::var_os(SHOW_AFTER_RESTART).is_some();
            if restarted || !std::env::args().any(|a| a == "--hidden") {
                show_main(app.handle());
            }
            Ok(())
        })
        // 닫기는 종료가 아니라 트레이로 숨김 — 알림·리마인더는 계속 동작
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![endpoint, restart_app])
        .build(tauri::generate_context!())
        .expect("PROPRIX 셸을 시작하지 못함");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            stop_daemon(app);
        }
    });
}
