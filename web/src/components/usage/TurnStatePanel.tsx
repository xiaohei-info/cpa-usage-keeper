import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, fetchTurnStateOverview } from '@/lib/api';
import type { TurnStateEvent, TurnStateOverview, TurnStateSession, TurnStateSummary } from '@/lib/turnState';
import { Card } from '@/components/ui/Card';
import { ModelSubstitutionPanel } from './ModelSubstitutionPanel';
import styles from './TurnStatePanel.module.scss';

const dateTime = (value: string | null, unknown: string): string => {
  if (!value) return unknown;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? unknown : date.toLocaleString();
};

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
        if (!disposed && !document.hidden) { setFailed(true); if (error instanceof ApiError && error.status === 401) auth.current?.(); }
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
  const formatCount = (value: number) => value.toLocaleString();
  const formatDate = (value: string | null) => dateTime(value, t('turn_state.not_available'));
  const remaining = (state: TurnStateSummary | null) => state ? Math.max(0, Math.floor((Date.parse(state.expires_at) - now) / 1000)) : 0;
  const statusText = (session: TurnStateSession) => {
    if (session.phase === 'paused') return t('turn_state.status_paused');
    if (session.active?.usable) return t('turn_state.status_ready');
    if (session.phase === 'collecting') return t('turn_state.status_collecting');
    if (session.phase === 'expired') return t('turn_state.status_expired');
    return t('turn_state.status_not_ready');
  };
  const statusClass = (session: TurnStateSession) => session.active?.usable ? styles.good : styles.muted;
  const sessionLabel = (session: TurnStateSession) => session.account_label || session.entry_id.slice(0, 12);
  const eventSentence = (event: TurnStateEvent) => {
    if (event.result === 'ws_connection_reused') return t('turn_state.event_ws_skipped', { model: event.model ?? unknown });
    if (event.result === 'accepted') return event.source === 'active' ? t('turn_state.event_probe_success') : t('turn_state.event_passive_success');
    if (event.result === 'dispatched') return t('turn_state.event_probe_started');
    if (event.result === 'shape_mismatch') return t('turn_state.event_shape_mismatch');
    if (event.result === 'budget_exhausted') return t('turn_state.event_budget_exhausted');
    return t('turn_state.event_generic', { result: event.result });
  };
  const stale = snapshot && (failed || now - Date.parse(snapshot.server_time) > 90_000 || (fetched && now - Date.parse(fetched) > 90_000));

  return <section className={styles.panel} aria-label={t('turn_state.title')}>
    <Card title={t('turn_state.title')}>
      <p className={styles.intro}>{t('turn_state.read_only')}</p>
      <p className={styles.intro}>{t('turn_state.settings_guidance')}</p>
      <p className={styles.intro}>{t('turn_state.billing')}</p>
      <p role="status" className={stale ? styles.warning : styles.snapshotStatus}>{!snapshot ? t(failed ? 'turn_state.unavailable' : 'common.loading') : stale ? t('turn_state.stale') : t('turn_state.current')}</p>
      {snapshot && <p className={styles.updated}>{t('turn_state.fetched_at')}: {dateTime(fetched, unknown)}</p>}
    </Card>
    {snapshot && <>
      <div className={styles.overviewGrid}>
        <Card title={t('turn_state.overview_ready')}><strong className={styles.metric}>{formatCount(snapshot.summary.usable)}</strong><p>{t('turn_state.overview_ready_help')}</p></Card>
        <Card title={t('turn_state.overview_injected')}><strong className={styles.metric}>{formatCount(snapshot.summary.injection_count)}</strong><p>{snapshot.summary.injection_count ? t('turn_state.overview_injected_help') : t('turn_state.overview_not_yet')}</p></Card>
        <Card title={t('turn_state.overview_observed')}><strong className={styles.metric}>{formatCount(snapshot.summary.passive_observations)}</strong><p>{t('turn_state.overview_observed_help')}</p></Card>
        <Card title={t('turn_state.overview_probes')}><strong className={styles.metric}>{formatCount(snapshot.summary.active_probes)}</strong><p>{t('turn_state.overview_probe_help', { accepted: snapshot.summary.accepted_probes, rejected: snapshot.summary.rejected_probes })}</p></Card>
      </div>
      <Card title={t('turn_state.config')} subtitle={t('turn_state.config_help')}>
        <dl className={styles.fields}>
          <div><dt>{t('turn_state.experiment_status')}</dt><dd>{snapshot.config.enabled && snapshot.config.mode !== 'off' ? t('turn_state.enabled') : t('turn_state.disabled')}</dd></div>
          <div><dt>{t('turn_state.capture_status')}</dt><dd>{snapshot.config.passive_enabled ? t('turn_state.enabled') : t('turn_state.disabled')}</dd></div>
          <div><dt>{t('turn_state.probe_status')}</dt><dd>{snapshot.config.active_enabled ? t('turn_state.enabled') : t('turn_state.disabled')}</dd></div>
          <div><dt>{t('turn_state.injection_mode')}</dt><dd>{t(`turn_state.mode_${snapshot.config.mode}`)}</dd></div>
          <div><dt>{t('turn_state.ttl')}</dt><dd>{Math.floor(snapshot.config.ttl_seconds / 60)} {t('turn_state.minutes')}</dd></div>
        </dl>
      </Card>
      <Card title={t('turn_state.sessions')} subtitle={t('turn_state.session_help')}>
        {!snapshot.sessions.length && <p>{t('turn_state.empty')}</p>}
        {snapshot.sessions.map((session, index) => <article key={`${session.entry_id}:${session.model}:${index}`} className={styles.entry}>
          <div className={styles.sessionHeader}><div><h4>{sessionLabel(session)} · {session.model}</h4><p className={styles.subtle}>{t('turn_state.account_rule')}: {session.account_mode}</p></div><span className={`${styles.badge} ${statusClass(session)}`}>{statusText(session)}</span></div>
          <dl className={styles.fields}>
            <div><dt>{t('turn_state.current_state')}</dt><dd>{session.active?.usable ? t('turn_state.state_ready') : t('turn_state.state_unavailable')}</dd></div>
            {session.active && <><div><dt>{t('turn_state.shape')}</dt><dd>{session.active.length} {t('turn_state.characters')} / {session.active.blocks} {t('turn_state.blocks_short')}</dd></div><div><dt>{t('turn_state.remaining_ttl')}</dt><dd>{Math.floor(remaining(session.active) / 60)} {t('turn_state.minutes')}</dd></div></>}
            <div><dt>{t('turn_state.last_observation')}</dt><dd>{formatDate(session.last_observed_at)}</dd></div>
            <div><dt>{t('turn_state.last_injection')}</dt><dd>{formatDate(session.last_injected_at)}</dd></div>
            <div><dt>{t('turn_state.backup_state')}</dt><dd>{session.ready?.usable ? t('turn_state.available') : t('turn_state.none')}</dd></div>
          </dl>
          <details><summary>{t('turn_state.technical_details')}</summary><dl className={styles.fields}><div><dt>{t('turn_state.entry_id')}</dt><dd>{session.entry_id}</dd></div><div><dt>{t('turn_state.fingerprint')}</dt><dd>{session.active?.fingerprint ?? unknown}</dd></div><div><dt>{t('turn_state.diagnostic')}</dt><dd>{session.diagnostic ?? t('turn_state.none')}</dd></div></dl></details>
        </article>)}
      </Card>
      <Card title={t('turn_state.events')} subtitle={t('turn_state.event_help')}>
        {!snapshot.events.length && <p>{t('turn_state.empty')}</p>}
        {snapshot.events.map((event, index) => <article key={`${event.id}:${index}`} className={styles.event}><div className={styles.eventMain}><time>{dateTime(event.at, unknown)}</time><span>{eventSentence(event)}</span></div><details><summary>{t('turn_state.technical_details')}</summary><dl className={styles.fields}><div><dt>{t('turn_state.model')}</dt><dd>{event.model ?? unknown}</dd></div>{event.length != null && <div><dt>{t('turn_state.shape')}</dt><dd>{event.length} {t('turn_state.characters')} / {event.blocks} {t('turn_state.blocks_short')}</dd></div>}{event.usage && <div><dt>{t('turn_state.probe_usage')}</dt><dd>{event.usage.input_tokens ?? unknown} / {event.usage.output_tokens ?? unknown} {t('turn_state.tokens')}</dd></div>}</dl></details></article>)}
      </Card>
    </>}
    {/* 模型替换观测只读 usage_events 历史，与上面的 proxy 运行时快照是否可用无关，因此始终渲染。 */}
    <ModelSubstitutionPanel refreshKey={refreshKey} onAuthRequired={onAuthRequired} />
  </section>;
}
