export type MacosAutomationNoticeState = 'unseen' | 'visible' | 'dismissed';
export type MacosAutomationNoticeEvent = 'deferred' | 'dismiss';

// The state belongs to one frontend session. Dismissal or navigation must not
// be undone by a queued event or the next automatic quota refresh.
export function reduceMacosAutomationNotice(
  state: MacosAutomationNoticeState,
  event: MacosAutomationNoticeEvent,
): MacosAutomationNoticeState {
  if (event === 'dismiss') return 'dismissed';
  return state === 'unseen' ? 'visible' : state;
}
