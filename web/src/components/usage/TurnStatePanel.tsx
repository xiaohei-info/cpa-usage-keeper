import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, fetchTurnStateOverview } from '@/lib/api';
import type { TurnStateOverview, TurnStateSummary } from '@/lib/turnState';
import { Card } from '@/components/ui/Card';
import styles from './TurnStatePanel.module.scss';

export function TurnStatePanel({ refreshKey = 0, onAuthRequired }: { refreshKey?: number; onAuthRequired?: () => void }) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<TurnStateOverview | null>(null);
  const [failed, setFailed] = useState(false);
  const [fetched, setFetched] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const refresh = useRef<() => void>(() => {});
  const auth = useRef(onAuthRequired);
  auth.current = onAuthRequired;
  useEffect(() => {
    let disposed = false;
    let controller: AbortController | null = null;
    const load = async () => {
      if (disposed || document.hidden || controller) return;
      const current = new AbortController();
      controller = current;
      const timeout = window.setTimeout(() => current.abort(), 12_000);
      try {
        const data = await fetchTurnStateOverview(current.signal);
        if (!disposed && !document.hidden) { setSnapshot(data); setFetched(new Date().toISOString()); setFailed(false); setNow(Date.now()); }
      } catch (error) {
        if (!disposed && !document.hidden) {
          setFailed(true);
          if (error instanceof ApiError && error.status === 401) auth.current?.();
        }
      } finally { window.clearTimeout(timeout); controller = null; }
    };
    refresh.current = () => { void load(); };
    const visibility = () => { setNow(Date.now()); if (document.hidden) controller?.abort(); else void load(); };
    const interval = window.setInterval(() => { setNow(Date.now()); void load(); }, 30_000);
    document.addEventListener('visibilitychange', visibility);
    void load();
    return () => { disposed = true; controller?.abort(); window.clearInterval(interval); document.removeEventListener('visibilitychange', visibility); refresh.current = () => {}; };
  }, []);
  useEffect(() => { refresh.current(); }, [refreshKey]);
  const unknown = t('turn_state.unknown');
  const value = (v: unknown): string => v == null ? unknown : typeof v === 'boolean' ? t(v ? 'turn_state.yes' : 'turn_state.no') : String(v);
  const fields = (data: object) => <dl className={styles.fields}>{Object.entries(data).map(([key, v]) => <div key={key}><dt>{t(`turn_state.${key}`)}</dt><dd>{value(v)}</dd></div>)}</dl>;
  const state = (data: TurnStateSummary | null) => data ? <>{fields(data)}<p>{t('turn_state.remaining')}: {Math.max(0, Math.floor((Date.parse(data.expires_at) - now) / 1000))} {t('turn_state.seconds')}</p></> : <p>{unknown}</p>;
  const stale = snapshot && (failed || now - Date.parse(snapshot.server_time) > 90_000 || (fetched && now - Date.parse(fetched) > 90_000));
  return <section className={styles.panel} aria-label={t('turn_state.title')}>
    <Card title={t('turn_state.title')}>
      <p>{t('turn_state.read_only')}</p><p>{t('turn_state.settings_guidance')}</p><p>{t('turn_state.billing')}</p>
      <p role="status">{!snapshot ? t(failed ? 'turn_state.unavailable' : 'common.loading') : stale ? t('turn_state.stale') : t('turn_state.current')}</p>
      {snapshot && fields({ fetched_at: fetched, server_time: snapshot.server_time, epoch: snapshot.epoch })}
    </Card>
    {snapshot && <>
      <Card title={t('turn_state.config')}>{fields(snapshot.config)}</Card>
      <Card title={t('turn_state.counters')} subtitle={t('turn_state.since_restart')}>{fields(snapshot.summary)}</Card>
      <Card title={t('turn_state.sessions')} subtitle={t('turn_state.bounded')}>
        {!snapshot.sessions.length && <p>{t('turn_state.empty')}</p>}
        {snapshot.sessions.map((session, index) => <article key={`${session.entry_id}:${session.model}:${index}`} className={styles.entry}>
          <h4>{session.account_label ?? session.entry_id} · {session.model}</h4>
          {fields(Object.fromEntries(Object.entries(session).filter(([key]) => key !== 'active' && key !== 'ready')))}
          <h5>{t('turn_state.active')}</h5>{state(session.active)}<h5>{t('turn_state.ready')}</h5>{state(session.ready)}
        </article>)}
      </Card>
      <Card title={t('turn_state.events')} subtitle={t('turn_state.bounded')}>
        {!snapshot.events.length && <p>{t('turn_state.empty')}</p>}
        {snapshot.events.map((event, index) => <article key={`${event.id}:${index}`} className={styles.entry}>
          {fields(Object.fromEntries(Object.entries(event).filter(([key]) => key !== 'usage')))}
          <h5>{t('turn_state.usage')}</h5>{event.usage ? fields(event.usage) : <p>{unknown}</p>}
        </article>)}
      </Card>
    </>}
  </section>;
}
