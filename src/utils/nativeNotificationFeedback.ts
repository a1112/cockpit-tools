export type NotificationSource = 'quota_alert' | 'floating_card_hidden';
export type NotificationOutcome = 'submitted' | 'identity_failed' | 'submission_failed';

export interface NotificationResult {
  revision: number;
  source: NotificationSource;
  outcome: NotificationOutcome;
}

export interface NotificationSnapshot {
  revision: number;
  authorization: 'unknown';
  delivery: 'unconfirmed';
  results: NotificationResult[];
}

export interface NotificationFeedbackView {
  snapshot: NotificationSnapshot | null;
  visible: boolean;
  reading: boolean;
  readFailed: boolean;
}

export const initialNotificationFeedback: NotificationFeedbackView = {
  snapshot: null,
  visible: false,
  reading: false,
  readFailed: false,
};

export function parseNotificationSnapshot(value: unknown): NotificationSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (!Number.isSafeInteger(raw.revision) || Number(raw.revision) < 0
    || raw.authorization !== 'unknown' || raw.delivery !== 'unconfirmed'
    || !Array.isArray(raw.results)) return null;
  const sources = new Set<NotificationSource>();
  const results: NotificationResult[] = [];
  for (const item of raw.results) {
    if (!item || typeof item !== 'object') return null;
    const result = item as Record<string, unknown>;
    if ((result.source !== 'quota_alert' && result.source !== 'floating_card_hidden')
      || (result.outcome !== 'submitted' && result.outcome !== 'identity_failed' && result.outcome !== 'submission_failed')
      || !Number.isSafeInteger(result.revision) || Number(result.revision) <= 0
      || Number(result.revision) > Number(raw.revision) || sources.has(result.source)) return null;
    sources.add(result.source);
    results.push({ revision: Number(result.revision), source: result.source, outcome: result.outcome });
  }
  return { revision: Number(raw.revision), authorization: 'unknown', delivery: 'unconfirmed', results };
}

interface FeedbackPort {
  // Both operations are read-only. There is deliberately no send/request API.
  listen: (receive: (value: unknown) => void) => Promise<() => void>;
  read: () => Promise<unknown>;
}

export function createNotificationFeedbackController(
  port: FeedbackPort,
  publish: (view: NotificationFeedbackView) => void,
) {
  let view: NotificationFeedbackView = { ...initialNotificationFeedback };
  let disposed = false;
  let started = false;
  let unlisten: (() => void) | undefined;
  let pendingRead: Promise<void> | null = null;
  const dismissed: Partial<Record<NotificationSource, number>> = {};

  const update = (patch: Partial<NotificationFeedbackView>) => {
    if (disposed) return;
    view = { ...view, ...patch };
    publish(view);
  };

  const receive = (value: unknown) => {
    if (disposed) return;
    const snapshot = parseNotificationSnapshot(value);
    if (!snapshot) { update({ readFailed: true }); return; }
    if (view.snapshot && snapshot.revision <= view.snapshot.revision) return;
    const freshFailure = snapshot.results.some((result) => {
      const previous = view.snapshot?.results.find((item) => item.source === result.source);
      return result.outcome !== 'submitted'
        && result.revision > (previous?.revision ?? 0)
        && result.revision > (dismissed[result.source] ?? 0);
    });
    update({ snapshot, visible: view.visible || freshFailure, readFailed: false });
  };

  const refresh = (explicit = false): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (explicit) update({ visible: true });
    if (pendingRead) return pendingRead;
    update({ reading: true });
    const revisionAtStart = view.snapshot?.revision ?? -1;
    pendingRead = Promise.resolve().then(() => port.read()).then((snapshot) => {
      if (disposed) return;
      update({ readFailed: false });
      receive(snapshot);
    }).catch(() => {
      // A late failed read must not mask a newer valid event.
      if ((view.snapshot?.revision ?? -1) <= revisionAtStart) update({ readFailed: true });
    }).finally(() => {
      pendingRead = null;
      update({ reading: false });
    });
    return pendingRead;
  };

  return {
    async start() {
      if (started || disposed) return;
      started = true;
      try {
        const stop = await port.listen(receive);
        if (disposed) { stop(); return; }
        unlisten = stop;
      } catch {
        // A read still recovers retained results if event registration failed.
      }
      if (!disposed) await refresh();
    },
    refresh,
    dismiss() {
      for (const result of view.snapshot?.results ?? []) dismissed[result.source] = result.revision;
      update({ visible: false });
    },
    dispose() {
      disposed = true;
      unlisten?.();
      unlisten = undefined;
    },
  };
}
