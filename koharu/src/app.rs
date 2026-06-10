//! Binary entry point. Wires `koharu-app::App` to the axum router plus
//! (optionally) Tauri.

use std::sync::Arc;

use anyhow::{Context, Result};
use clap::Parser;
use koharu_app::{App, AppConfig, config as app_config};
use koharu_rpc::{BootstrapManager, server};
use koharu_runtime::{ComputePolicy, RuntimeHttpConfig, RuntimeManager};
use tokio::net::TcpListener;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

use crate::cli::Cli;

async fn bootstrap_app(
    state: Arc<BootstrapManager>,
    config: AppConfig,
    cpu_only: bool,
) -> Result<()> {
    let runtime = state.runtime();
    runtime
        .prepare()
        .await
        .context("failed to prepare runtime")?;

    let app = Arc::new(App::new_with_shared_state(
        config,
        runtime,
        cpu_only,
        state.shared_state(),
        crate::version::current(),
    )?);
    koharu_llm::suppress_native_logs();
    app.spawn_llm_forwarder();
    state
        .set_app(app)
        .map_err(|_| anyhow::anyhow!("app already initialized"))?;
    Ok(())
}

pub async fn run() -> Result<()> {
    let cli = Cli::parse();

    #[cfg(target_os = "windows")]
    {
        let attached = crate::windows::attach_parent_console();
        if !attached && (cli.headless || cli.debug) {
            crate::windows::create_console_window();
        }
        crate::windows::enable_ansi_support().ok();
    }

    tracing_subscriber::registry()
        .with(
            tracing_subscriber::filter::EnvFilter::builder()
                .with_default_directive(tracing::Level::INFO.into())
                .from_env_lossy(),
        )
        .with(crate::sentry::tracing_layer())
        .with(crate::tracing::TimingLayer::new())
        .init();

    let config: AppConfig = app_config::load()?;
    let http = RuntimeHttpConfig {
        connect_timeout_secs: config.http.connect_timeout.max(1),
        read_timeout_secs: config.http.read_timeout.max(1),
        max_retries: config.http.max_retries,
    };
    let compute = if cli.cpu {
        ComputePolicy::CpuOnly
    } else {
        ComputePolicy::PreferGpu
    };

    if cli.download {
        return RuntimeManager::new_with_http(config.data.path.as_std_path(), compute, http)?
            .prepare()
            .await
            .context("failed to download runtime packages");
    }

    let state = BootstrapManager::new(Arc::new(RuntimeManager::new_with_http(
        config.data.path.as_std_path(),
        compute,
        http,
    )?));
    state.spawn_download_forwarder();

    #[cfg(target_os = "windows")]
    crate::windows::register_khr().ok();

    let bind_host = cli.host.as_deref().unwrap_or("127.0.0.1");
    let bind_port = cli.port.unwrap_or(4000);
    let listener: TcpListener = if cfg!(debug_assertions) || cli.port.is_some() {
        TcpListener::bind((bind_host, bind_port)).await?
    } else {
        let mut port = bind_port;
        loop {
            match TcpListener::bind((bind_host, port)).await {
                Ok(listener) => break listener,
                Err(err) if err.kind() == std::io::ErrorKind::AddrInUse && port < u16::MAX => {
                    port += 1;
                }
                Err(err) => return Err(err.into()),
            }
        }
    };
    let port = listener.local_addr()?.port();
    tracing::info!(port, "starting server");

    let mut context = tauri::generate_context!();
    let assets = crate::assets::from_context(&mut context);
    let server_state = state.clone();
    tauri::async_runtime::spawn(async move {
        server::serve_with_listener_and_assets(listener, server_state, assets)
            .await
            .expect("failed to start server");
    });

    if cli.headless {
        tracing::info!(port, "headless: open http://127.0.0.1:{port}/ in a browser");
        // Run a minimal Tauri app with NO window but a system-tray (notification
        // area) icon, so the operator can see koharu is running in the background
        // and quit it from the tray. The HTTP server was already spawned above.
        tauri::Builder::default()
            .setup(move |handle| {
                tauri::async_runtime::spawn(async move {
                    bootstrap_app(state, config, cli.cpu)
                        .await
                        .expect("failed to bootstrap app");
                });

                use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
                use tauri::tray::TrayIconBuilder;

                let status = MenuItem::with_id(
                    handle,
                    "status",
                    format!("koharu running — http://127.0.0.1:{port}"),
                    false,
                    None::<&str>,
                )?;
                let sep = PredefinedMenuItem::separator(handle)?;
                let quit = MenuItem::with_id(handle, "quit", "Quit koharu", true, None::<&str>)?;
                let menu = Menu::with_items(handle, &[&status, &sep, &quit])?;

                let mut tray = TrayIconBuilder::with_id("koharu-headless")
                    .tooltip(format!("koharu — translation agent running (port {port})"))
                    .menu(&menu)
                    .on_menu_event(|app, event| {
                        if event.id.as_ref() == "quit" {
                            app.exit(0);
                        }
                    });
                if let Some(icon) = handle.default_window_icon().cloned() {
                    tray = tray.icon(icon);
                }
                tray.build(handle)?;
                Ok(())
            })
            .run(context)?;
        return Ok(());
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .on_window_event(|window, event| {
            // Clicking X HIDES the window to the system tray instead of quitting,
            // so the built-in Translation Agent keeps running in the background.
            // Quit for real from the tray menu.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .setup(move |handle| {
            tauri::async_runtime::spawn(async move {
                bootstrap_app(state, config, cli.cpu)
                    .await
                    .expect("failed to bootstrap app");
            });

            let cfg = handle.config();
            let url: tauri::Url = if cfg!(debug_assertions) {
                cfg.build
                    .dev_url
                    .as_ref()
                    .expect("dev_url must be set in dev mode")
                    .as_str()
                    .parse()?
            } else {
                // ?agent=1 tells the UI (AuthGate) to auto-start the translation
                // agent — only the GUI "server" instance opens this window, so
                // headless editor instances never auto-run the agent.
                format!("http://127.0.0.1:{port}/?agent=1").parse()?
            };
            let wc = cfg
                .app
                .windows
                .iter()
                .find(|w| w.label == "main")
                .expect("main window config not found");
            let main_window = tauri::webview::WebviewWindowBuilder::from_config(handle, wc)?
                .build()?;
            main_window.navigate(url)?;
            // Start hidden in the tray when launched as a background startup app
            // (KOHARU_TRAY_START=1). The webview still loads, so the auto-started
            // agent keeps running; the operator restores the window from the tray.
            if std::env::var("KOHARU_TRAY_START").map(|v| v == "1").unwrap_or(false) {
                let _ = main_window.hide();
            }

            // Tray icon: restore a hidden (closed-to-tray) window, or quit for real.
            {
                use tauri::Manager;
                use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
                use tauri::tray::{TrayIconBuilder, TrayIconEvent};
                let show = MenuItem::with_id(handle, "show", "Show koharu", true, None::<&str>)?;
                let sep = PredefinedMenuItem::separator(handle)?;
                let quit = MenuItem::with_id(handle, "quit", "Quit koharu", true, None::<&str>)?;
                let menu = Menu::with_items(handle, &[&show, &sep, &quit])?;
                let mut tray = TrayIconBuilder::with_id("koharu-main")
                    .tooltip("koharu — running (close window = hide to tray)")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "show" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                        "quit" => app.exit(0),
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: tauri::tray::MouseButton::Left,
                            button_state: tauri::tray::MouseButtonState::Up,
                            ..
                        } = event
                        {
                            if let Some(w) = tray.app_handle().get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                    });
                if let Some(icon) = handle.default_window_icon().cloned() {
                    tray = tray.icon(icon);
                }
                tray.build(handle)?;
            }

            Ok(())
        })
        .run(context)?;

    Ok(())
}
