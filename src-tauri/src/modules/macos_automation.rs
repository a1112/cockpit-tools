//! AppleScript failure handling for macOS app control.
//!
//! A rejected Apple event is not proof that Accessibility is missing. Keep the
//! actual target and error code, and never prompt, change TCC, or retry here.

use std::process::{Command, Output};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Target {
    SystemEvents,
    Terminal,
    ITerm,
    Zed,
}

impl Target {
    fn name(self) -> &'static str {
        match self {
            Self::SystemEvents => "System Events",
            Self::Terminal => "Terminal",
            Self::ITerm => "iTerm",
            Self::Zed => "Zed",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FailureKind {
    AutomationDenied,
    AccessibilityDenied,
    TargetUnavailable,
    Other,
}

#[derive(Debug)]
struct ScriptFailure {
    target: Target,
    kind: FailureKind,
    code: Option<i32>,
    detail: String,
}

// osascript appends the AppleScript error number in parentheses. Do not match
// arbitrary numbers in paths, quoted commands, or the process exit status.
fn error_number(stderr: &str) -> Option<i32> {
    let without_suffix = stderr.trim().strip_suffix(')')?;
    let (_, number) = without_suffix.rsplit_once('(')?;
    number.parse().ok()
}

impl ScriptFailure {
    fn from_stderr(target: Target, stderr: &str) -> Self {
        let code = error_number(stderr);
        let lower = stderr.to_ascii_lowercase();
        let kind = match code {
            Some(-1743) => FailureKind::AutomationDenied,
            Some(-25211) if target == Target::SystemEvents => FailureKind::AccessibilityDenied,
            // -1719, -10004 and 1002 are NOT permission-specific. Only classify them
            // when System Events explicitly reports assistive-access denial.
            Some(-1719 | -10004 | 1002)
                if target == Target::SystemEvents
                    && (lower.contains("not allowed assistive access")
                        || lower.contains("not allowed to send keystrokes")) =>
            {
                FailureKind::AccessibilityDenied
            }
            Some(-600 | -10814) => FailureKind::TargetUnavailable,
            _ => FailureKind::Other,
        };
        Self {
            target,
            kind,
            code,
            detail: stderr.trim().to_string(),
        }
    }

    fn permission_denied(&self) -> bool {
        matches!(
            self.kind,
            FailureKind::AutomationDenied | FailureKind::AccessibilityDenied
        )
    }

    fn message(&self) -> String {
        let (tag, key) = match self.kind {
            FailureKind::AutomationDenied => (
                "MACOS_AUTOMATION_DENIED",
                "macosAutomation.automationDenied",
            ),
            FailureKind::AccessibilityDenied => (
                "MACOS_ACCESSIBILITY_DENIED",
                "macosAutomation.accessibilityDenied",
            ),
            FailureKind::TargetUnavailable => (
                "MACOS_AUTOMATION_TARGET_UNAVAILABLE",
                "macosAutomation.targetUnavailable",
            ),
            FailureKind::Other => ("MACOS_AUTOMATION_FAILED", "macosAutomation.failed"),
        };
        let locale = crate::modules::config::get_user_config().language;
        let message = crate::modules::i18n::translate(
            &locale,
            key,
            &[("target", self.target.name()), ("detail", &self.detail)],
        );
        format!("[{}] {}", tag, message)
    }
}

fn check_output(target: Target, output: std::io::Result<Output>) -> Result<(), ScriptFailure> {
    match output {
        Ok(output) if output.status.success() => Ok(()),
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let detail = if stderr.trim().is_empty() {
                format!("osascript exited with {}", output.status)
            } else {
                stderr.trim().to_string()
            };
            Err(ScriptFailure::from_stderr(target, &detail))
        }
        // A failure to start osascript is not an Apple-event/TCC denial.
        Err(error) => Err(ScriptFailure {
            target,
            kind: FailureKind::Other,
            code: None,
            detail: format!("Could not start osascript: {}", error),
        }),
    }
}

fn execute(script: &str, target: Target) -> Result<(), ScriptFailure> {
    check_output(
        target,
        Command::new("/usr/bin/osascript")
            .args(["-e", script])
            .output(),
    )
}

pub fn should_defer_background_restart(no_restart_enabled: bool) -> bool {
    !no_restart_enabled
}

pub fn run(script: &str, target: Target) -> Result<(), String> {
    execute(script, target).map_err(|failure| failure.message())
}

// Preserve existing best-effort close fallback for nonpermission failures, but
// never turn a confirmed permission denial into a force-close operation.
fn allow_close_fallback(result: Result<(), ScriptFailure>) -> Result<(), ScriptFailure> {
    match result {
        Err(failure) if failure.permission_denied() => Err(failure),
        Err(failure) => {
            // Do not log script text/stderr: terminal commands can contain user
            // paths or credentials. The target and numeric code are sufficient.
            crate::modules::logger::log_warn(&format!(
                "[macOS Automation] graceful close failed: target={}, code={:?}; continuing existing close fallback",
                failure.target.name(), failure.code
            ));
            Ok(())
        }
        Ok(()) => Ok(()),
    }
}

pub fn run_graceful_close(script: &str, target: Target) -> Result<(), String> {
    allow_close_fallback(execute(script, target)).map_err(|failure| failure.message())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn output(success: bool, stderr: &str) -> std::io::Result<Output> {
        #[cfg(unix)]
        use std::os::unix::process::ExitStatusExt;
        #[cfg(windows)]
        use std::os::windows::process::ExitStatusExt;
        Ok(Output {
            status: std::process::ExitStatus::from_raw(if success { 0 } else { 256 }),
            stdout: Vec::new(),
            stderr: stderr.as_bytes().to_vec(),
        })
    }

    #[test]
    fn recognizes_automation_denial_in_any_os_locale() {
        for target in [
            Target::SystemEvents,
            Target::Terminal,
            Target::ITerm,
            Target::Zed,
        ] {
            for stderr in [
                "execution error: Not authorized to send Apple events. (-1743)",
                "执行错误：未获授权向应用程序发送 Apple 事件。 (-1743)\n",
            ] {
                let failure = check_output(target, output(false, stderr)).unwrap_err();
                assert_eq!(failure.kind, FailureKind::AutomationDenied);
                assert!(failure.message().starts_with("[MACOS_AUTOMATION_DENIED]"));
            }
        }
    }

    #[test]
    fn recognizes_only_specific_system_events_accessibility_denial() {
        for stderr in [
            "System Events got an error: osascript is not allowed assistive access. (-1719)",
            "System Events got an error: osascript is not allowed to send keystrokes. (1002)",
            "System Events got an error: AX API disabled. (-25211)",
        ] {
            let failure = ScriptFailure::from_stderr(Target::SystemEvents, stderr);
            assert_eq!(failure.kind, FailureKind::AccessibilityDenied);
        }
        assert_eq!(
            ScriptFailure::from_stderr(Target::Terminal, "not allowed assistive access (-1719)")
                .kind,
            FailureKind::Other
        );
    }

    #[test]
    fn generic_errors_and_numbers_in_messages_are_not_permissions() {
        for stderr in [
            "Invalid index. (-1719)",
            "An error occurred. (1002)",
            "A privilege violation occurred. (-10004)",
            "Syntax error. (-2741)",
            "Can't get process. (-1728)",
            "User canceled. (-128)",
            "Command path /tmp/-1743 failed (-1)",
            "Quoted (-1743) but no error code",
            "Permission denied",
            "(-17430)",
            "",
        ] {
            let failure = check_output(Target::SystemEvents, output(false, stderr)).unwrap_err();
            assert_eq!(failure.kind, FailureKind::Other, "{}", stderr);
        }
    }

    #[test]
    fn missing_or_stopped_apps_have_distinct_nonpermission_errors() {
        for code in [-600, -10814] {
            let failure =
                ScriptFailure::from_stderr(Target::ITerm, &format!("App unavailable ({})", code));
            assert_eq!(failure.kind, FailureKind::TargetUnavailable);
            assert!(!failure.permission_denied());
        }
    }

    #[test]
    fn denied_graceful_close_never_reaches_force_close() {
        for stderr in [
            "not authorized (-1743)",
            "AX API disabled (-25211)",
            "not allowed assistive access (-1719)",
        ] {
            let mut force_close_called = false;
            let attempt = (|| {
                allow_close_fallback(check_output(Target::SystemEvents, output(false, stderr)))?;
                force_close_called = true;
                Ok::<(), ScriptFailure>(())
            })();
            assert!(attempt.is_err());
            assert!(!force_close_called);
        }
    }

    #[test]
    fn nonpermission_failures_keep_existing_close_fallback() {
        for stderr in [
            "Invalid index (-1719)",
            "App unavailable (-600)",
            "Script failed (-1)",
        ] {
            assert!(allow_close_fallback(check_output(Target::Zed, output(false, stderr))).is_ok());
        }
    }

    #[test]
    fn success_is_not_reclassified_from_stderr_and_retry_is_not_cached() {
        assert!(check_output(Target::Terminal, output(false, "denied (-1743)")).is_err());
        assert!(check_output(Target::Terminal, output(true, "old text (-1743)")).is_ok());
    }

    #[test]
    fn spawn_failure_is_not_a_permission_denial() {
        let error =
            std::io::Error::new(std::io::ErrorKind::PermissionDenied, "cannot spawn (-1743)");
        let failure = check_output(Target::Terminal, Err(error)).unwrap_err();
        assert_eq!(failure.kind, FailureKind::Other);
    }

    #[test]
    fn background_restart_does_not_execute_or_change_selection() {
        let mut script_called = false;
        let mut current_account = "original";
        if !should_defer_background_restart(false) {
            script_called = true;
            current_account = "replacement";
        }
        assert!(!script_called);
        assert_eq!(current_account, "original");
        assert!(!should_defer_background_restart(true));
    }

    #[test]
    fn denied_close_preserves_account_binding_and_fingerprint() {
        let mut current_account = "original";
        let mut binding = "original";
        let mut fingerprint = "original";
        let result = (|| {
            allow_close_fallback(check_output(
                Target::SystemEvents,
                output(false, "denied (-1743)"),
            ))?;
            current_account = "replacement";
            binding = "replacement";
            fingerprint = "replacement";
            Ok::<(), ScriptFailure>(())
        })();
        assert!(result.is_err());
        assert_eq!(
            (current_account, binding, fingerprint),
            ("original", "original", "original")
        );
    }
}
