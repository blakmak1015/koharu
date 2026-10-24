use std::time::Duration;

pub fn install() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        previous(info);

        let payload = info.payload();
        let msg = payload
            .downcast_ref::<&str>()
            .copied()
            .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
            .unwrap_or("unknown panic");
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_default();

        tracing::error!(%msg, %location, "Koharu panicked");

        if let Some(client) = sentry::Hub::current().client() {
            client.flush(Some(Duration::from_secs(2)));
        }

        // Fork: the unattended farm (same flag as koharu-app's background_mode)
        // has nobody to click OK. The dialog held a crashed process open for
        // hours on 2026-10-23/24; exiting lets the keepalive relaunch it.
        if std::env::var("KOHARU_TRAY_START").is_ok_and(|value| value.trim() == "1") {
            std::process::exit(1);
        }

        rfd::MessageDialog::new()
            .set_level(rfd::MessageLevel::Error)
            .set_title("Koharu has stopped")
            .set_description(format!(
                "Something went wrong and Koharu needs to close.\n\n{msg}\n\nat {location}"
            ))
            .set_buttons(rfd::MessageButtons::Ok)
            .show();

        std::process::exit(1);
    }));
}
