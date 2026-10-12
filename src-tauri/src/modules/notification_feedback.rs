//! Pure notification submission policy. Reading feedback never initializes or
//! calls the native notification API. No account/body/error text is retained.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    QuotaAlert,
    FloatingCardHidden,
}

impl Source {
    pub fn label(self) -> &'static str {
        match self {
            Self::QuotaAlert => "quota_alert",
            Self::FloatingCardHidden => "floating_card_hidden",
        }
    }

    fn index(self) -> usize {
        match self {
            Self::QuotaAlert => 0,
            Self::FloatingCardHidden => 1,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Submitted,
    IdentityFailed,
    SubmissionFailed,
}

impl Outcome {
    pub fn label(self) -> &'static str {
        match self {
            Self::Submitted => "submitted",
            Self::IdentityFailed => "identity_failed",
            Self::SubmissionFailed => "submission_failed",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Feedback {
    pub revision: u64,
    pub source: Source,
    pub outcome: Outcome,
}

pub struct NotificationState {
    // mac-notification-sys has a global Once: repeated set_application calls
    // return AlreadySet even for the same identifier. Retain our own first
    // result, including failure. The native wrapper serializes this state.
    identity_ready: Option<bool>,
    revision: u64,
    feedback: [Option<Feedback>; 2],
}

impl NotificationState {
    pub const fn new() -> Self {
        Self {
            identity_ready: None,
            revision: 0,
            feedback: [None, None],
        }
    }

    pub fn snapshot(&self) -> (u64, Vec<Feedback>) {
        (
            self.revision,
            self.feedback.iter().flatten().copied().collect(),
        )
    }

    pub fn submit(
        &mut self,
        source: Source,
        initialize_identity: impl FnOnce() -> bool,
        submit_notification: impl FnOnce() -> bool,
    ) -> Option<Feedback> {
        let ready = *self.identity_ready.get_or_insert_with(initialize_identity);
        let outcome = if !ready {
            Outcome::IdentityFailed
        } else if submit_notification() {
            // Accepted by the library, not proof of native permission/delivery.
            Outcome::Submitted
        } else {
            Outcome::SubmissionFailed
        };
        let slot = &mut self.feedback[source.index()];
        if slot.is_some_and(|previous| previous.outcome == outcome) {
            return None;
        }
        self.revision += 1;
        let feedback = Feedback {
            revision: self.revision,
            source,
            outcome,
        };
        *slot = Some(feedback);
        Some(feedback)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn reading_initial_state_does_not_initialize_or_submit() {
        let state = NotificationState::new();
        assert_eq!(state.snapshot(), (0, Vec::new()));
        assert_eq!(state.identity_ready, None);
    }

    #[test]
    fn identity_success_is_initialized_once_across_sources() {
        let mut state = NotificationState::new();
        let initializations = Cell::new(0);
        for source in [
            Source::QuotaAlert,
            Source::FloatingCardHidden,
            Source::QuotaAlert,
        ] {
            state.submit(
                source,
                || {
                    initializations.set(initializations.get() + 1);
                    true
                },
                || true,
            );
        }
        assert_eq!(initializations.get(), 1);
        assert_eq!(state.snapshot().0, 2);
    }

    #[test]
    fn failed_identity_blocks_submission_and_is_not_retried_in_process() {
        let mut state = NotificationState::new();
        let initializations = Cell::new(0);
        let sends = Cell::new(0);
        for source in [
            Source::QuotaAlert,
            Source::FloatingCardHidden,
            Source::QuotaAlert,
        ] {
            state.submit(
                source,
                || {
                    initializations.set(initializations.get() + 1);
                    false
                },
                || {
                    sends.set(sends.get() + 1);
                    true
                },
            );
        }
        assert_eq!(initializations.get(), 1);
        assert_eq!(sends.get(), 0);
        assert!(state
            .snapshot()
            .1
            .iter()
            .all(|item| item.outcome == Outcome::IdentityFailed));
    }

    #[test]
    fn repeated_outcomes_are_deduplicated_but_normal_notifications_still_submit() {
        let mut state = NotificationState::new();
        let sends = Cell::new(0);
        assert!(state
            .submit(
                Source::QuotaAlert,
                || true,
                || {
                    sends.set(sends.get() + 1);
                    false
                }
            )
            .is_some());
        assert!(state
            .submit(
                Source::QuotaAlert,
                || panic!("already initialized"),
                || {
                    sends.set(sends.get() + 1);
                    false
                }
            )
            .is_none());
        assert_eq!(sends.get(), 2);
        assert_eq!(state.snapshot().0, 1);
    }

    #[test]
    fn a_meaningful_transition_advances_revision_without_erasing_other_source() {
        let mut state = NotificationState::new();
        state.submit(Source::QuotaAlert, || true, || false);
        state.submit(Source::FloatingCardHidden, || true, || false);
        let success = state.submit(Source::QuotaAlert, || true, || true).unwrap();
        assert_eq!(success.revision, 3);
        assert_eq!(success.outcome.label(), "submitted");
        assert_eq!(state.snapshot().1[1].outcome, Outcome::SubmissionFailed);
        let failure = state.submit(Source::QuotaAlert, || true, || false).unwrap();
        assert_eq!(failure.revision, 4);
    }

    #[test]
    fn snapshots_do_not_repeat_submissions() {
        let mut state = NotificationState::new();
        state.submit(Source::QuotaAlert, || true, || true);
        let snapshot = state.snapshot();
        assert_eq!(state.snapshot(), snapshot);
        assert_eq!(snapshot.1[0].source.label(), "quota_alert");
    }

    #[test]
    fn serialized_calls_share_one_identity_and_keep_both_sources() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc, Mutex,
        };
        let state = Arc::new(Mutex::new(NotificationState::new()));
        let calls = Arc::new(AtomicUsize::new(0));
        let threads: Vec<_> = (0..8)
            .map(|index| {
                let state = Arc::clone(&state);
                let calls = Arc::clone(&calls);
                std::thread::spawn(move || {
                    let source = if index % 2 == 0 {
                        Source::QuotaAlert
                    } else {
                        Source::FloatingCardHidden
                    };
                    state.lock().unwrap().submit(
                        source,
                        || {
                            calls.fetch_add(1, Ordering::SeqCst);
                            true
                        },
                        || true,
                    );
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(state.lock().unwrap().snapshot().1.len(), 2);
    }
}
