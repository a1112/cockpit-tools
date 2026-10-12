# macOS native notification feedback

This addresses `DESK-COCKPIT-002` for the desktop app's quota alerts and floating-card hidden reminders. Their macOS implementations now share `macos_notifications::submit`; the non-macOS plugin paths are unchanged. Existing in-app quota alerts and notification preferences are preserved.

## What the native library can establish

The workspace lock pins `mac-notification-sys` 0.6.12. Cargo uses the workspace-root lock, rather than the older nested `src-tauri/Cargo.lock`. The pinned crate uses legacy `NSUserNotificationCenter`. With `asynchronous(true)`, it returns without waiting for presentation. A successful call establishes only that the wrapper returned without a synchronous error; it does **not** establish native permission, scheduling completion, a displayed banner, or delivery.

The crate exposes no native authorization-status API. The app therefore reports authorization as `unknown` and delivery as `unconfirmed`, including after a successful submission. A submission error is not classified as permission denial. An authoritative status bridge using `UNUserNotificationCenter.getNotificationSettings` would be separate work requiring native implementation and packaged-Mac validation.

## Identity setup and submission

The crate's `set_application` uses a global `Once`. Later calls return `AlreadySet`, even if they request the same identifier. That response is not proof of which identity was initialized. The shared wrapper lazily retains its own first setup result, including failure, under a mutex. It initializes only on an existing intended notification, never during feedback reads or application startup.

- Successful initialization is reused across both notification sources.
- Failed or unexpected initialization blocks submission. The result instructs the user to quit and reopen the installed app before the next intended notification; repeated initialization cannot recover inside the same process.
- The mutex serializes identity setup, calls into the submission API, and feedback updates because the legacy implementation replaces a shared notification-center delegate. This does not establish serialization of asynchronous OS delivery or the lifetime/safety of that delegate after the call returns; those remain native validation gates.
- `wait_for_click(false).asynchronous(true)` is retained. No click-waiting loop or automatic resend is added.

## Visible feedback and recovery

The latest meaningful outcome for each source is retained in native process memory, independently of webview event delivery. Only source, outcome, and revision are stored. Notification content, account identifiers, email addresses, and raw native errors are not included in feedback.

Outcomes are `submitted`, `identity_failed`, and `submission_failed`. Identical source/outcome updates do not advance the revision or emit a new UI event. A failure after an intervening successful submission is a new outcome. Normal intended notifications remain independent of this UI deduplication.

The main window offers a macOS notification-status panel. A meaningful setup/submission failure opens it; successful submissions do not create repeated notices. Dismissal survives repeated events and focus refreshes in the current main-window session. Explicit review can reopen it. Monotonic revisions prevent old reads or events from replacing newer results, and listeners/read completions are guarded after unmount.

“Refresh in-app result” and returning focus only retrieve retained feedback. They never submit a notification, request authorization, change preferences, or claim to recheck macOS permission. The panel gives manual Notifications/Focus guidance, access to in-app quotas, and an explicit action to reopen the floating card. No notification test-send button or automatic permission request is introduced.

The desktop binary does not depend on `cockpit-core`; its duplicated native sender is not part of this repair. Its current library app-handle accessor also returns `None`.

## Verification

After installing frontend dependencies, run:

- `npm run test:macos-notifications` with `rustc` available (or `RUSTC` pointing to it)
- `npm run test:macos-permissions` for the existing Automation/Accessibility regression suite
- `npm run release:preflight`

The notification suite runs mocked frontend lifecycle/read-ordering/dismissal cases, checks both actual macOS call sites and translations, and compiles the exact dependency-free Rust policy with synthetic setup/send callbacks. It does not compile the full Tauri app, execute the native notification wrapper, or verify rendered native UI. `--skip-cargo --skip-cargo-test` on release preflight is frontend-only validation.

Required Mac acceptance remains: build the full app, verify installed bundle identity/signing, exercise both sources with undecided/allowed/denied/revoked notification settings and Focus, inspect hidden/remounted-main-window feedback, verify setup failure blocks submission, and confirm submitted results never claim delivery. Check macOS 12 and current supported releases, including development versus installed-app identity. No live notifications, permission grants, TCC resets, or signing changes are required by the synthetic tests.

## Primary evidence

- [Pinned crate identity setup](https://github.com/h4llow3En/mac-notification-sys/blob/v0.6.12/src/lib.rs)
- [Pinned Rust submission wrapper](https://github.com/h4llow3En/mac-notification-sys/blob/v0.6.12/src/notification.rs)
- [Pinned native submission implementation](https://github.com/h4llow3En/mac-notification-sys/blob/v0.6.12/objc/notify.m)
- [Cargo workspace lockfile rules](https://doc.rust-lang.org/cargo/reference/workspaces.html)
- [Apple notification-settings API](https://developer.apple.com/documentation/usernotifications/unusernotificationcenter/getnotificationsettings(completionhandler:))
