//! Fork-only commands for the unattended translation farm.
//!
//! Upstream's `import` and `export` both open a native file dialog, and
//! `PageImportSource` offers only `Files` and `Folder`, so there is no way to
//! feed pages in or take rendered pages out over IPC. An agent running without
//! a human at the keyboard cannot drive the application at all. These commands
//! are the headless equivalents, and they reuse upstream's own code paths
//! rather than reimplementing them.
//!
//! The `farm_` prefix is deliberate: upstream already owns `run_agent`,
//! `cancel_agent`, `login_agent` and `get_agent_status`, which belong to its
//! Codex integration and have nothing to do with the translation agent here.

use anyhow::Context as _;
use koharu_desktop::Desktop;
use koharu_secrets::{ExposeSecret as _, SecretString};
use std::path::PathBuf;
use tauri::State;

use super::{
    Error,
    canvas::CanvasChannel,
    lifecycle::add_pages,
    output::{ExportFormat, write_export},
    processing::Processing,
    project::CurrentProject,
};

/// Distinguishes the credentials of two instances sharing one machine account.
///
/// The farm runs the website agent under its own login while a person may be
/// signed in to the same site in an interactive instance; one token must not
/// overwrite the other.
const INSTANCE_VARIABLE: &str = "KOHARU_INSTANCE_ID";

fn website_token_key() -> String {
    match std::env::var(INSTANCE_VARIABLE) {
        Ok(instance) if !instance.trim().is_empty() => {
            format!("website-token.{}", instance.trim())
        }
        _ => "website-token".to_owned(),
    }
}

/// Append pages to the open project from paths the caller already has.
///
/// The agent downloads raw pages to a scratch directory and passes the paths
/// here. Missing paths are rejected up front: a silently short import would
/// produce a chapter with pages missing, which is worse than a failed job.
#[tracing::instrument(
    target = "koharu_metrics",
    name = "import",
    skip_all,
    fields(origin = "farm", method = "paths"),
)]
#[tauri::command]
#[specta::specta]
pub(crate) async fn farm_import_pages(
    paths: Vec<PathBuf>,
    desktop: State<'_, Desktop>,
    project: State<'_, CurrentProject>,
    processing: State<'_, Processing>,
    canvas_channel: State<'_, CanvasChannel>,
) -> std::result::Result<(), Error> {
    if paths.is_empty() {
        return Err(anyhow::anyhow!("no pages were given to import").into());
    }
    if let Some(missing) = paths.iter().find(|path| !path.is_file()) {
        return Err(anyhow::anyhow!("{} is not a readable file", missing.display()).into());
    }
    add_pages(paths, &desktop, &project, &processing, &canvas_channel).await
}

/// Render every page of the open project into `destination`.
///
/// `destination` is a directory for `png` and `psd`, and the archive path
/// itself for `cbz`, matching what upstream's dialog would have returned.
#[tracing::instrument(
    target = "koharu_metrics",
    name = "export",
    skip_all,
    fields(origin = "farm", format = ?format),
)]
#[tauri::command]
#[specta::specta]
pub(crate) async fn farm_export_pages(
    destination: PathBuf,
    format: ExportFormat,
    project: State<'_, CurrentProject>,
    desktop: State<'_, Desktop>,
) -> std::result::Result<(), Error> {
    let snapshot = {
        let project = project.project.lock().await;
        project
            .as_ref()
            .context("no project is open")?
            .snapshot()
    };
    let pages = snapshot.pages().map(|page| page.id()).collect::<Vec<_>>();
    if pages.is_empty() {
        return Err(anyhow::anyhow!("there are no pages to export").into());
    }
    // Upstream's dialog guarantees the parent exists; here nothing does.
    match format {
        ExportFormat::Png | ExportFormat::Psd => std::fs::create_dir_all(&destination)
            .with_context(|| format!("failed to create {}", destination.display()))?,
        ExportFormat::Cbz => {
            let parent = destination
                .parent()
                .context("the archive path has no parent directory")?;
            std::fs::create_dir_all(parent)
                .with_context(|| format!("failed to create {}", parent.display()))?;
        }
    }
    write_export(format, destination, &desktop, snapshot, pages).await
}

/// Store the website session token for this instance.
#[tauri::command]
#[specta::specta]
pub(crate) async fn farm_set_website_token(token: String) -> std::result::Result<(), Error> {
    let token = token.trim().to_owned();
    if token.is_empty() {
        koharu_secrets::delete(&website_token_key())?;
        return Ok(());
    }
    koharu_secrets::set(&website_token_key(), &SecretString::from(token))?;
    Ok(())
}

/// Read back the website session token, or `None` when the instance has none.
#[tauri::command]
#[specta::specta]
pub(crate) async fn farm_get_website_token() -> std::result::Result<Option<String>, Error> {
    Ok(koharu_secrets::get(&website_token_key())?
        .map(|secret| secret.expose_secret().to_owned()))
}

/// Forget the website session token for this instance.
#[tauri::command]
#[specta::specta]
pub(crate) async fn farm_clear_website_token() -> std::result::Result<(), Error> {
    koharu_secrets::delete(&website_token_key())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two instances on one machine must not share a credential.
    #[test]
    fn the_token_key_is_namespaced_per_instance() {
        // SAFETY: single-threaded test, and the variable is read, never held.
        unsafe { std::env::set_var(INSTANCE_VARIABLE, "server") };
        assert_eq!(website_token_key(), "website-token.server");

        unsafe { std::env::set_var(INSTANCE_VARIABLE, "  ") };
        assert_eq!(website_token_key(), "website-token");

        unsafe { std::env::remove_var(INSTANCE_VARIABLE) };
        assert_eq!(website_token_key(), "website-token");
    }
}
