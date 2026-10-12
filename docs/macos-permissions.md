# macOS app-control permissions

Cockpit Tools uses AppleScript for these existing actions:

| Action | Apple-event target | Additional access |
| --- | --- | --- |
| Focus supported IDE instances | System Events | Accessibility may be needed for UI control |
| Gracefully close Antigravity, VS Code, or Windsurf | System Events | Accessibility for UI scripting / Command-Q |
| Run a Codex or Gemini CLI command in a terminal | Terminal or iTerm | Automation for the selected terminal |
| Quit or activate a Zed session | Zed | Evaluate the actual operation result; activation alone is not treated as proof of a permission requirement |

The app does not request all permissions at launch, open permission settings automatically, change TCC, or cache permission decisions. A retry evaluates the current result, including permission changes made outside the app. This change is limited to the GUI implementation in `src-tauri`; it does not add OS permission handling to the separate CLI/core copies.

Restart-required **automatic Antigravity account switching is deferred on macOS**, even if a previous manual operation succeeded. There is no verified nonprompting check here for the spawned helper's current permission. The quota-refresh path therefore emits an in-app notice before executing AppleScript or changing account selection. Users can switch manually from Antigravity accounts or use the existing no-restart mode. The notice can be dismissed and is shown at most once per frontend session. No-restart automatic switching and manual switching remain available.

## Failure handling

- AppleScript error `-1743` is reported as Automation not authorized. This may reflect user denial **or** an installed-build configuration/signing problem; the message does not assume the cause.
- System Events error `-25211` identifies disabled Accessibility access. Generic errors `-1719`, `-10004`, and `1002` are classified as Accessibility denial only when the returned message explicitly says assistive access or keystroke sending is not allowed. Unrecognized/localized wording with a generic code stays an ordinary operation failure, not a guessed permission diagnosis.
- `-600` / `-10814` identify unavailable targets. Missing processes, invalid indices, syntax errors, cancellation, and failures to start `osascript` are not mislabeled as missing permissions.
- Recognized permission failures return localized recovery instructions through the existing string-error UI. They include the exact target, the appropriate settings category, macOS 12 navigation, and a manual alternative.
- A recognized permission failure during graceful close propagates before any existing process-close fallback. Nonpermission failures retain the previous best-effort fallback. The helper does not log AppleScript source, terminal commands, or raw stderr.
- Antigravity switch operations close before changing current-account selection, default binding, or device fingerprint; token preparation remains before close. On macOS, Zed validates the selected account and closes before changing or clearing credentials, then starts without sending a second quit request after those writes. Permission-denied close therefore leaves those selections/credentials unchanged. This is not a general transaction rollback for unrelated injection or launch failures.
- Checking `AXIsProcessTrusted()` for the parent alone would not prove a spawned helper's effective TCC responsibility, so it is not used as a substitute for the actual operation result.

## Bundle configuration

`Info.plist` supplies `NSAppleEventsUsageDescription`. `Entitlements.plist` contains only `com.apple.security.automation.apple-events`, the hardened-runtime resource entitlement for the real third-party automation above. Both paths are explicit in Tauri's macOS configuration. Hardened runtime, sandbox settings, signing identity, and other OS permission categories are unchanged.

These source declarations do not prove that a distributed binary is signed correctly or that a user has granted permission. Development launches from Terminal and installed-app launches can have different responsible identities. Recovery text therefore refers to the requesting app shown by macOS, rather than assuming a specific settings entry.

## Regression checks

Run `npm run test:macos-permissions` after installing frontend dependencies, with a Rust compiler available (`RUSTC` can select one). The test compiles the complete production helper with only config, translation, and logging boundaries stubbed. Synthetic process outputs cover Automation and Accessibility denial, unavailable targets, unrelated errors, spawn errors, retry after a changed outcome, stopping before force-close/state changes, and background deferral. The real frontend notice reducer is tested for repeated events, dismissal, late events, and a fresh session. Additional source-contract checks cover all locale keys, bundle declarations, caller propagation, account-write ordering, the rendered navigation destination, and listener disposal. They are not runtime tests of the full account workflow or rendered UI. No test executes AppleScript or touches running applications or OS settings.

Also run `npm run release:preflight`. The narrower `--skip-cargo --skip-cargo-test` flags verify the frontend only; they do not constitute a native Rust/Tauri build.

## Required real-Mac acceptance

Before shipping, on a supported Mac:

1. Build the full app and inspect the resulting app's `Contents/Info.plist` and code-signing entitlements. Verify the usage string, Apple Events entitlement, bundle identifier, and intended signing identity in the **built app**.
2. Use disposable IDE/terminal sessions with no unsaved work. Check focus and graceful close, terminal command execution, and Zed stop/restart from the installed app.
3. Test undecided, granted, denied, and subsequently revoked access separately for Automation and Accessibility. Confirm the macOS responsible-app entry, target-specific instructions, manual alternatives, and successful explicit retry after granting access.
4. Confirm a recognized denial never causes force-close or changes current-account selection/binding/fingerprint/credentials, and ordinary missing-target errors do not ask for Accessibility. Confirm startup and automatic quota refresh produce no new permission prompt. Exercise background restart deferral, the notice's Accounts button/dismissal/repeated events, manual switching, and unchanged no-restart automatic switching.
5. Repeat under a development launch and document any different responsible identity. Unknown localized generic Accessibility errors require real-platform evidence before adding classifier patterns.

Linux fixtures and frontend checks do not complete these acceptance gates. Do not reset TCC or enable permissions automatically to make a test pass.

## Primary references

- [Apple: NSAppleEventsUsageDescription](https://developer.apple.com/documentation/bundleresources/information-property-list/nsappleeventsusagedescription)
- [Apple: Apple Events entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.automation.apple-events)
- [Apple: macOS Mojave release notes (`-1743`)](https://developer.apple.com/documentation/macos-release-notes/macos-mojave-10_14-release-notes)
- [Apple: UI scripting and Accessibility](https://developer.apple.com/library/archive/documentation/LanguagesUtilities/Conceptual/MacAutomationScriptingGuide/AutomatetheUserInterface.html)
- [Tauri: macOS configuration](https://v2.tauri.app/reference/config/#macconfig)
- [Tauri: macOS application bundles and entitlements](https://v2.tauri.app/distribute/macos-application-bundle/)
- [Tauri: macOS code signing](https://v2.tauri.app/distribute/sign/macos/)
