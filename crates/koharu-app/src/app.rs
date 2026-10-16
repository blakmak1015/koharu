use anyhow::{Context as _, Result};
use tauri::{AppHandle, Manager as _, WindowEvent};
use tauri_runtime_cef::{Cef, CefRuntime};
use tokio::sync::Mutex;

use crate::commands::{
    agent::AgentState,
    canvas::CanvasChannel,
    lifecycle::{
        Download, DownloadChannel, DownloadState, Initialization, ModelResources, ProjectChannel,
        ResourceChannel,
    },
    processing::{JobChannel, Processing},
    project::{CurrentProject, ProjectLibrary},
};

#[tracing::instrument(
    target = "koharu_metrics",
    name = "app_started",
    skip_all,
    fields(phase = "initialization")
)]
pub(crate) async fn initialize(handle: AppHandle<CefRuntime>) -> Result<()> {
    koharu_ml::init()
        .await
        .context("failed to initialize the ML runtime")?;
    let device = koharu_ml::device(false);
    koharu_metrics::context(serde_json::json!({
        "compute_backend": device.backend.to_string().to_ascii_lowercase(),
        "device_type": format!("{:?}", device.device_type).to_ascii_lowercase(),
        "gpu_model": device.description.clone(),
        "vram_bytes": device.memory_total,
    }));
    let pipeline = koharu_pipeline::Pipeline::load(device)?;
    handle.manage(pipeline.clone());

    let mut resources = pipeline.subscribe_resources();
    let resource_handle = handle.clone();
    drop(tauri::async_runtime::spawn(async move {
        while resources.changed().await.is_ok() {
            let snapshot = resources.borrow_and_update().clone();
            let resources = resource_handle.state::<ResourceChannel>();
            let mut channel = resources.channel.lock();
            if let Some(current) = channel.as_ref()
                && current.send(ModelResources::from(snapshot)).is_err()
            {
                channel.take();
            }
        }
    }));

    let project = handle
        .state::<CurrentProject>()
        .project
        .lock()
        .await
        .as_ref()
        .map(|project| (project.snapshot(), project.active_page()));
    let desktop = handle.state::<koharu_desktop::Desktop>();
    if let Some((snapshot, page)) = project {
        desktop.show_page(&snapshot, page).await?;
    } else {
        desktop.clear().await;
    }
    Ok(())
}

pub fn run(context: tauri::Context<CefRuntime>) -> Result<()> {
    let cef = Cef::default();
    #[cfg(debug_assertions)]
    let cef = cef.remote_debugging(tauri_runtime_cef::RemoteDebugging::Port {
        port: 4000,
        allowed_origins: Vec::new(),
    });
    #[cfg(target_os = "linux")]
    let cef = cef
        .enable_features(["Vulkan", "VulkanFromANGLE"])
        .command_line_args([
            ("--enable-unsafe-webgpu", None),
            ("use-angle", Some("vulkan")),
            ("--ozone-platform", Some("x11")),
        ]);
    tauri::Builder::<CefRuntime>::new()
        .runtime(cef)
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(tauri_plugin_log::log::LevelFilter::Info)
                .max_file_size(1_000_000)
                .clear_targets()
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::LogDir { file_name: None },
                ))
                .build(),
        )
        .plugin(tauri_plugin_single_instance::init(|handle, _, _| {
            if let Some(window) = handle.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED
                        | tauri_plugin_window_state::StateFlags::FULLSCREEN,
                )
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(crate::commands::bindings().invoke_handler())
        .setup(move |application| {
            #[cfg(all(target_os = "windows", not(debug_assertions)))]
            koharu_runtime::Store::configure(
                application
                    .path()
                    .resource_dir()
                    .context("failed to locate Koharu's installation directory")?
                    .join("store"),
            )?;

            application.manage(CurrentProject {
                project: Mutex::new(None),
            });
            application.manage(ProjectLibrary::new()?);
            application.manage(Processing::default());
            application.manage(CanvasChannel::default());
            application.manage(JobChannel::default());
            application.manage(DownloadChannel::default());
            application.manage(ResourceChannel::default());
            application.manage(ProjectChannel::default());
            application.manage(Initialization::default());

            let handle = application.handle().clone();
            application.manage(koharu_desktop::Desktop::new()?);
            application.manage(AgentState::new(handle.clone())?);

            // Fork: a loopback control surface for the unattended translation
            // farm. Upstream speaks only Tauri IPC, which the supervising
            // scripts cannot reach, and they must be able to pin the
            // translation model after every restart.
            let readiness = koharu_control::Readiness::new();
            match koharu_control::configured_port() {
                Ok(Some(port)) => {
                    let readiness = readiness.clone();
                    drop(tauri::async_runtime::spawn(async move {
                        if let Err(error) = koharu_control::serve(port, readiness).await {
                            tracing::error!(%error, "the control surface stopped");
                        }
                    }));
                }
                Ok(None) => {}
                Err(error) => {
                    tracing::error!(%error, "the control surface is disabled");
                }
            }

            let window_config = application
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .context("the main Tauri window configuration is unavailable")?;
            let window = tauri::WebviewWindowBuilder::from_config(application, window_config)?
                .build()
                .context("failed to create the main window")?;
            // Fork: the farm instance starts hidden. The webview still loads, so
            // the auto-started translation agent runs; re-launching the
            // executable brings the window back.
            if background_mode() {
                tracing::info!("background mode: starting with the window hidden");
            } else {
                window.show().context("failed to show the main window")?;
                window
                    .set_focus()
                    .context("failed to focus the main window")?;
            }

            let initialization_handle = handle.clone();
            let initialization_readiness = readiness.clone();
            drop(tauri::async_runtime::spawn(async move {
                initialize(initialization_handle.clone())
                    .await
                    .expect("failed to initialize the desktop runtime");
                initialization_handle.state::<Initialization>().ready();
                initialization_readiness.mark_ready();
            }));

            let mut downloads = koharu_runtime::download::subscribe();
            let download_handle = handle.clone();
            drop(tauri::async_runtime::spawn(async move {
                loop {
                    match downloads.recv().await {
                        Ok(event) => {
                            let download = match event {
                                koharu_runtime::download::Event::Started { id, name } => {
                                    tracing::info!(
                                        target: "koharu_metrics",
                                        metric = "download_start",
                                        resource = "runtime",
                                    );
                                    Download {
                                        id,
                                        state: DownloadState::Running,
                                        name: Some(name),
                                        completed: 0,
                                        total: 0,
                                        error: None,
                                    }
                                }
                                koharu_runtime::download::Event::Progress {
                                    id,
                                    name,
                                    completed,
                                    total,
                                } => {
                                    tracing::info!(
                                        target: "koharu_metrics",
                                        metric = "download_progress",
                                        resource = "runtime",
                                        used_bytes = completed,
                                        total_bytes = total,
                                    );
                                    Download {
                                        id,
                                        state: DownloadState::Running,
                                        name: Some(name),
                                        completed,
                                        total,
                                        error: None,
                                    }
                                }
                                koharu_runtime::download::Event::Finished { id } => {
                                    tracing::info!(
                                        target: "koharu_metrics",
                                        metric = "download_result",
                                        resource = "runtime",
                                        outcome = "completed",
                                    );
                                    Download {
                                        id,
                                        state: DownloadState::Finished,
                                        name: None,
                                        completed: 0,
                                        total: 0,
                                        error: None,
                                    }
                                }
                                koharu_runtime::download::Event::Failed { id, name, error } => {
                                    tracing::info!(
                                        target: "koharu_metrics",
                                        metric = "download_result",
                                        resource = "runtime",
                                        outcome = "failed",
                                    );
                                    Download {
                                        id,
                                        state: DownloadState::Failed,
                                        name: Some(name),
                                        completed: 0,
                                        total: 0,
                                        error: Some(error),
                                    }
                                }
                            };
                            let downloads = download_handle.state::<DownloadChannel>();
                            let mut channel = downloads.channel.lock();
                            if let Some(current) = channel.as_ref()
                                && current.send(download).is_err()
                            {
                                channel.take();
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                            tracing::warn!(skipped, "download channel fell behind");
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            }));

            Ok(())
        })
        .on_window_event(|window, event| {
            // Fork: in background mode closing only hides the window, so a stray
            // click cannot end a running batch. Interactive use keeps upstream's
            // behaviour, where closing the window shuts the application down.
            if let WindowEvent::CloseRequested { api, .. } = event
                && background_mode()
            {
                let _ = window.hide();
                api.prevent_close();
                return;
            }
            if matches!(
                event,
                WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed
            ) {
                stop_work(window);
            }
            if matches!(event, WindowEvent::Destroyed) {
                tracing::info!(
                    target: "koharu_metrics",
                    metric = "app_closed",
                    phase = "shutdown",
                );
                koharu_metrics::shutdown();
            }
        })
        .run(context)?;
    Ok(())
}

/// Background mode: the unattended translation-farm instance.
///
/// Set by `ops/restart-server.ps1`. In this mode the window starts hidden and
/// closing it only hides it again, so a stray click cannot end a running batch.
/// Re-launching the executable brings the window back through
/// `tauri_plugin_single_instance`; the supervisor script stops the process.
///
/// Tauri 3.0.0-alpha.1's `tray-icon` feature requires `tray-icon ^0.25`, which
/// is not published, so the 0.59.2 fork's tray menu has no equivalent here yet.
/// Revisit when that dependency lands.
fn background_mode() -> bool {
    std::env::var("KOHARU_TRAY_START").is_ok_and(|value| value.trim() == "1")
}

/// Stop everything the window owns. Hiding to the background deliberately does
/// not call this: the point of background mode is that the work continues.
fn stop_work(window: &tauri::Window<CefRuntime>) {
    let processing = window.state::<Processing>();
    for stop in processing.stops.lock().values() {
        stop.stop();
    }
    processing.stops.lock().clear();
    processing.jobs.lock().clear();
    window.state::<AgentState>().cancel_all();
}
