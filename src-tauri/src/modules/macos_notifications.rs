//! One serialized mac-notification-sys entry point. The crate cannot report
//! authorization or delivery, so feedback deliberately leaves both unverified.

use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Runtime};

use super::notification_feedback::{NotificationState, Source};

static STATE: Mutex<NotificationState> = Mutex::new(NotificationState::new());

fn snapshot_value(state: &NotificationState) -> serde_json::Value {
    let (revision, feedback) = state.snapshot();
    let results: Vec<_> = feedback
        .into_iter()
        .map(|item| {
            serde_json::json!({
                "revision": item.revision,
                "source": item.source.label(),
                "outcome": item.outcome.label(),
            })
        })
        .collect();
    serde_json::json!({
        "revision": revision,
        "authorization": "unknown",
        "delivery": "unconfirmed",
        "results": results,
    })
}

pub fn snapshot() -> serde_json::Value {
    let state = STATE.lock().unwrap_or_else(|error| error.into_inner());
    snapshot_value(&state)
}

pub fn submit<R: Runtime>(app: &AppHandle<R>, source: Source, title: String, body: String) {
    let app = app.clone();
    let bundle_identifier = app.config().identifier.to_string();
    std::thread::spawn(move || {
        // The legacy implementation replaces a shared notification-center
        // delegate. Serialize identity setup, submission, and feedback updates.
        let mut state = STATE.lock().unwrap_or_else(|error| error.into_inner());
        let changed = state.submit(
            source,
            || mac_notification_sys::set_application(&bundle_identifier).is_ok(),
            || {
                let mut notification = mac_notification_sys::Notification::new();
                notification
                    .title(title.as_str())
                    .message(body.as_str())
                    .wait_for_click(false)
                    .asynchronous(true);
                notification.send().is_ok()
            },
        );
        let snapshot = changed.map(|_| snapshot_value(&state));
        drop(state);
        if let Some(snapshot) = snapshot {
            // Store before emitting: a missing/remounted webview can read the
            // result later. No body, email, account ID, or raw native error leaks.
            let _ = app.emit("macos:notification-feedback", snapshot);
        }
    });
}
