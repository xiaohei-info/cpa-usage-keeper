import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, fetchTurnStateOverview } from '@/lib/api';
import type { TurnStateOverview } from '@/lib/turnState';
import { MODEL_SUBSTITUTION_CURRENT, MODEL_SUBSTITUTION_RANGE_SELECTIONS } from '@/lib/modelSubstitution';
import { Card } from '@/components/ui/Card';
import { ModelSubstitutionPanel, useModelSubstitution } from './ModelSubstitutionPanel';
import { TurnStateMergedTable } from './TurnStateMergedTable';
import { formatStateShape } from '@/utils/usage/stateCheck';
import styles from './TurnStatePanel.module.scss';
import pageStyles from '@/pages/UsagePage.module.scss';

const RANGE_LABEL_KEYS: Record<string, string> = {
  '1h': 'turn_state.model_sub_range_1h',
  '6h': 'turn_state.model_sub_range_6h',
  '24h': 'turn_state.model_sub_range_24h',
  '7d': 'turn_state.model_sub_range_7d',
  '30d': 'turn_state.model_sub_range_30d',
};

type Translate = (key: string, options?: Record<string, string | number>) => string;

export function TurnStatePanel({ refreshKey = 0, onAuthRequired }: { refreshKey?: number; onAuthRequired?: () => void }) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<TurnStateOverview | null>(null);
  const [failed, setFailed] = useState(false);
  const [fetched, setFetched] = useState<string | null>(null);
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
        if (!disposed && !document.hidden) {
          setSnapshot(data);
          setFetched(new Date().toISOString());
          setFailed(false);
        }
      } catch (error) {
        if (!disposed && !document.hidden) {
          setFailed(true);
          if (error instanceof ApiError && error.status === 401) auth.current?.();
        }
      } finally {
        window.clearTimeout(timeout);
        controller = null;
      }
    };
    refresh.current = () => { void load(); };
    const visibility = () => { if (document.hidden) controller?.abort(); else void load(); };
    const interval = window.setInterval(() => { void load(); }, 30_000);
    document.addEventListener('visibilitychange', visibility);
    void load();
    return () => {
      disposed = true;
      controller?.abort();
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', visibility);
      refresh.current = () => {};
    };
  }, []);
  useEffect(() => { refresh.current(); }, [refreshKey]);

  const substitution = useModelSubstitution({ refreshKey, onAuthRequired });
  const stale = snapshot && (failed || Date.now() - Date.parse(snapshot.server_time) > 90_000 || (fetched && Date.now() - Date.parse(fetched) > 90_000));
  const boolText = (value: boolean | null | undefined) => value == null ? t('turn_state.not_available') : value ? t('turn_state.value_on') : t('turn_state.value_off');
  const secondsText = (value: number | null | undefined) => value == null ? t('turn_state.not_available') : t('turn_state.config_seconds', { value });
  const countText = (value: number | null | undefined) => value == null ? t('turn_state.not_available') : t('turn_state.config_count', { value });
  const statusText = !snapshot ? t(failed ? 'turn_state.unavailable' : 'common.loading') : stale ? t('turn_state.stale') : t('turn_state.current');
  const fetchedText = fetched ? new Date(fetched).toLocaleString() : t('turn_state.unknown');

  return <section className={styles.panel} aria-label={t('turn_state.title')}>
    <Card title={t('turn_state.title')} subtitle={t('turn_state.merged_help')}
      extra={<div className={pageStyles.tabBarConnected} role="group" aria-label={t('turn_state.model_sub_range_label')}>
        {MODEL_SUBSTITUTION_RANGE_SELECTIONS.map((value) => (
          <button
            key={value}
            type="button"
            className={`${pageStyles.tabPill} ${value === substitution.selection ? pageStyles.tabPillActive : ''}`.trim()}
            aria-pressed={value === substitution.selection}
            onClick={() => substitution.selectRange(value)}
          >
            {value === MODEL_SUBSTITUTION_CURRENT ? t('turn_state.merged_range_current') : t(RANGE_LABEL_KEYS[value])}
          </button>
        ))}
      </div>}
    >
      <p role="status" className={stale ? styles.warning : styles.snapshotStatus} data-turn-state-status>
        {statusText} · {t('turn_state.updated_at', { time: fetchedText })}
      </p>
      {substitution.failed && !substitution.data && <p role="status" className={styles.warning}>{t('turn_state.model_sub_unavailable')}</p>}
      {substitution.failed && substitution.data && <p role="status" className={styles.warning} data-model-subscription-stale>{t('turn_state.stale')}</p>}
      <TurnStateMergedTable
        rows={substitution.data?.current ?? []}
        sessions={snapshot?.sessions ?? []}
        selection={substitution.selection}
      />
      <p className={styles.cardMeta}>{t('turn_state.merged_polling')}</p>
    </Card>

    {/* 历史趋势与矩阵保留：总表回答账号×模型当前状态，这里回答窗口内的变化趋势。 */}
    <ModelSubstitutionPanel controller={substitution} />

    {snapshot && <Card title={t('turn_state.config')} subtitle={t('turn_state.config_help')}>
      <table className={styles.configTable} data-turn-state-config>
        <thead><tr>
          <th scope="col">{t('turn_state.config_column')}</th>
          <th scope="col">{t('turn_state.config_state_column')}</th>
          <th scope="col">{t('turn_state.config_meaning_column')}</th>
        </tr></thead>
        <tbody>
          <tr><th scope="row">{t('turn_state.config_experiment')}</th><td data-config-value={snapshot.config.enabled ? 'on' : 'off'}>{boolText(snapshot.config.enabled)}</td><td>{t('turn_state.config_experiment_help')}</td></tr>
          <tr><th scope="row">{t('turn_state.config_passive')}</th><td data-config-value={snapshot.config.passive_enabled ? 'on' : 'off'}>{boolText(snapshot.config.passive_enabled)}</td><td>{t('turn_state.config_passive_help')}</td></tr>
          <tr><th scope="row">{t('turn_state.config_active')}</th><td data-config-value={snapshot.config.active_enabled ? 'on' : 'off'}>{boolText(snapshot.config.active_enabled)}</td><td>{t('turn_state.config_active_help')}</td></tr>
          <tr><th scope="row">{t('turn_state.config_mode')}</th><td data-config-value={snapshot.config.mode}>{t(`turn_state.mode_${snapshot.config.mode}`)}</td><td>{t('turn_state.config_mode_help')}</td></tr>
          <tr><th scope="row">{t('turn_state.config_fallback')}</th><td data-config-value={snapshot.config.fallback}>{snapshot.config.fallback === 'strict' ? t('turn_state.config_fallback_strict') : t('turn_state.config_fallback_pass')}</td><td>{t('turn_state.config_fallback_help')}</td></tr>
          <tr><th scope="row">{t('turn_state.config_harvest_proxy')}</th><td data-config-value={snapshot.config.harvest_proxy_url ? 'custom' : 'default'}>{snapshot.config.harvest_proxy_url ? t('turn_state.config_custom_route') : t('turn_state.config_default_route')}</td><td>{t('turn_state.config_harvest_proxy_help')}</td></tr>
          <tr><th scope="row">{t('turn_state.config_revalidate')}</th><td data-config-value={snapshot.config.revalidate == null ? 'unknown' : snapshot.config.revalidate ? 'on' : 'off'}>{boolText(snapshot.config.revalidate)}</td><td>{t('turn_state.config_revalidate_help')}</td></tr>
          <tr><th scope="row">{t('turn_state.config_mismatch')}</th><td data-config-value={snapshot.config.mismatch_is_success == null ? 'unknown' : snapshot.config.mismatch_is_success ? 'on' : 'off'}>{snapshot.config.mismatch_is_success == null ? t('turn_state.not_available') : snapshot.config.mismatch_is_success ? t('turn_state.config_mismatch_success') : t('turn_state.config_mismatch_failure')}</td><td>{t('turn_state.config_mismatch_help')}</td></tr>
          <tr><th scope="row">{t('turn_state.config_rule')}</th><td data-config-value={snapshot.config.account_mode}>{t('turn_state.rule_value', { plan: snapshot.config.account_mode === 'team' ? t('turn_state.plan_team') : t('turn_state.plan_personal'), shape: formatStateShape(snapshot.config.account_mode === 'team' ? 12 : 10, t) })}{snapshot.config.account_mode === 'auto' ? `（${t('turn_state.rule_auto')}）` : ''}</td><td>{t('turn_state.config_rule_help')}</td></tr>
          <tr><th scope="row">{t('turn_state.config_ttl')}</th><td>{secondsText(snapshot.config.ttl_seconds)}</td><td>{t('turn_state.config_ttl_help')}</td></tr>
          <tr><th scope="row">{t('turn_state.config_refresh')}</th><td>{secondsText(snapshot.config.refresh_before_seconds)}</td><td>{t('turn_state.config_refresh_help')}</td></tr>
          <tr><th scope="row">{t('turn_state.config_timeout')}</th><td>{secondsText(snapshot.config.probe_timeout_seconds)}</td><td>{t('turn_state.config_timeout_help')}</td></tr>
          <tr><th scope="row">{t('turn_state.config_cooldown')}</th><td>{secondsText(snapshot.config.cooldown_seconds)}</td><td>{t('turn_state.config_cooldown_help')}</td></tr>
          <tr><th scope="row">{t('turn_state.config_attempts')}</th><td>{countText(snapshot.config.max_attempts_per_round)}</td><td>{t('turn_state.config_attempts_help')}</td></tr>
          <tr><th scope="row">{t('turn_state.config_revoke')}</th><td>{countText(snapshot.config.revoke_after_signals)}</td><td>{t('turn_state.config_revoke_help')}</td></tr>
        </tbody>
      </table>
    </Card>}
  </section>;
}
