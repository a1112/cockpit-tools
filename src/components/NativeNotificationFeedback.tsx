import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useTranslation } from 'react-i18next';
import { usePlatformRuntimeSupport } from '../hooks/usePlatformRuntimeSupport';
import { showFloatingCardWindow } from '../services/floatingCardService';
import {
  createNotificationFeedbackController,
  initialNotificationFeedback,
  type NotificationOutcome,
} from '../utils/nativeNotificationFeedback';

const outcomeKeys: Record<NotificationOutcome, string> = {
  submitted: 'macosNotifications.submitted',
  identity_failed: 'macosNotifications.identityFailed',
  submission_failed: 'macosNotifications.submissionFailed',
};

export function NativeNotificationFeedback({ onViewQuotas }: { onViewQuotas: () => void }) {
  const { t } = useTranslation();
  const isMac = usePlatformRuntimeSupport('macos-only');
  const desktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  const [view, setView] = useState(initialNotificationFeedback);
  const [floatingFailed, setFloatingFailed] = useState(false);
  const [openingFloating, setOpeningFloating] = useState(false);
  const controller = useRef<ReturnType<typeof createNotificationFeedbackController> | null>(null);
  const mounted = useRef(true);
  const floatingInFlight = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!desktop || !isMac) return;
    const current = createNotificationFeedbackController({
      listen: (receive) => listen('macos:notification-feedback', (event) => receive(event.payload)),
      read: () => invoke('get_macos_notification_feedback'),
    }, setView);
    controller.current = current;
    void current.start();
    const refresh = () => { void current.refresh(); };
    window.addEventListener('focus', refresh);
    return () => {
      current.dispose();
      controller.current = null;
      window.removeEventListener('focus', refresh);
    };
  }, [desktop, isMac]);

  if (!desktop || !isMac) return null;
  return (
    <section className="native-notification-feedback" aria-label={t('macosNotifications.title')}>
      <button className="btn btn-secondary" disabled={view.reading} onClick={() => { void controller.current?.refresh(true); }}>
        {t(view.visible ? 'macosNotifications.refresh' : 'macosNotifications.title')}
      </button>
      {view.visible && (
        <div className="native-notification-feedback-body">
          <div role="status" aria-live="polite">
            {view.readFailed && <p>{t('macosNotifications.readFailed')}</p>}
            {view.snapshot?.results.map((result) => (
              <p key={result.source}>
                <strong>{t(result.source === 'quota_alert' ? 'macosNotifications.quotaSource' : 'macosNotifications.floatingSource')}</strong>
                {': '}{t(outcomeKeys[result.outcome])}
              </p>
            ))}
            {!view.readFailed && !view.snapshot?.results.length && <p>{t('macosNotifications.noAttempts')}</p>}
          </div>
          <p>{t('macosNotifications.unverified')}</p>
          <p>{t('macosNotifications.guidance')}</p>
          <p>{t('macosNotifications.sessionOnly')}</p>
          {floatingFailed && <p role="alert">{t('macosNotifications.floatingFailed')}</p>}
          <div className="native-notification-feedback-actions">
            <button className="btn btn-secondary" onClick={onViewQuotas}>{t('macosNotifications.viewQuotas')}</button>
            <button
              className="btn btn-secondary"
              disabled={openingFloating}
              onClick={() => {
                if (floatingInFlight.current) return;
                floatingInFlight.current = true;
                setOpeningFloating(true);
                setFloatingFailed(false);
                void showFloatingCardWindow().catch(() => {
                  if (mounted.current) setFloatingFailed(true);
                }).finally(() => {
                  floatingInFlight.current = false;
                  if (mounted.current) setOpeningFloating(false);
                });
              }}
            >
              {t('macosNotifications.showFloatingCard')}
            </button>
            <button className="btn btn-secondary" onClick={() => controller.current?.dismiss()}>{t('common.close')}</button>
          </div>
        </div>
      )}
    </section>
  );
}
