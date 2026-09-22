import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, fetchTurnStateOverview } from '@/lib/api';
import type { TurnStateFailure, TurnStateOverview, TurnStateSession, TurnStateSummary } from '@/lib/turnState';
import {
  MODEL_SUBSTITUTION_CURRENT,
  MODEL_SUBSTITUTION_RANGE_SELECTIONS,
} from '@/lib/modelSubstitution';
import { Card } from '@/components/ui/Card';
import { ModelSubstitutionPanel, useModelSubstitution } from './ModelSubstitutionPanel';
import { TurnStateMergedTable } from './TurnStateMergedTable';
import {
  formatStateComparison,
  formatStateShape,
  stateShapeCharacters,
  STATE_CHECK_REASON_LABEL_KEYS,
} from '@/utils/usage/stateCheck';
import styles from './TurnStatePanel.module.scss';

const dateTime = (value: string | null, unknown: string): string => {
  if (!value) return unknown;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? unknown : date.toLocaleString();
};

/** 服务端返回的是原样码；未知 phase 归到“未就绪”，不把内部枚举直接展示给用户。 */
const PHASE_STATUS_KEYS: Record<string, string> = {
  usable: 'turn_state.status_ready',
  collecting: 'turn_state.status_collecting',
  expired: 'turn_state.status_expired',
  blocked: 'turn_state.status_paused',
  paused: 'turn_state.status_paused',
  unsupported: 'turn_state.status_not_applicable',
};

/** 时间维度按钮的文字 key；“当前”档单独处理，不在这里。 */
const RANGE_LABEL_KEYS: Record<string, string> = {
  '1h': 'turn_state.model_sub_range_1h',
  '6h': 'turn_state.model_sub_range_6h',
  '24h': 'turn_state.model_sub_range_24h',
  '7d': 'turn_state.model_sub_range_7d',
  '30d': 'turn_state.model_sub_range_30d',
};

/** 事件结论句映射（契约 §5）；未列出的码走通用兜底并保留原始码。 */
const EVENT_RESULT_KEYS: Record<string, string> = {
  accepted: 'turn_state.event_accepted',
  accepted_model_mismatch: 'turn_state.event_accepted_model_mismatch',
  block_mismatch: 'turn_state.event_block_mismatch',
  no_state: 'turn_state.event_no_state',
  incomplete: 'turn_state.event_incomplete',
  expired: 'turn_state.event_expired',
  timestamp_future: 'turn_state.event_timestamp_future',
  timestamp_range: 'turn_state.event_timestamp_future',
  encoding_length: 'turn_state.event_encoding',
  encoding_whitespace: 'turn_state.event_encoding',
  encoding_padding: 'turn_state.event_encoding',
  encoding_base64: 'turn_state.event_encoding',
  envelope_too_short: 'turn_state.event_encoding',
  envelope_version: 'turn_state.event_encoding',
  envelope_structure: 'turn_state.event_encoding',
  auth_blocked: 'turn_state.event_auth_blocked',
  quota_blocked: 'turn_state.event_quota_blocked',
  budget_exhausted: 'turn_state.event_budget_exhausted',
  model_unknown: 'turn_state.event_model_unknown',
  // Ticket-collection outcomes (proxy source:"ticket"); without these every ticket
  // event would fall through to "未知原因（code）" even though it is a normal outcome.
  ticket_verified: 'turn_state.event_ticket_verified',
  ticket_model_mismatch: 'turn_state.event_ticket_model_mismatch',
  ticket_unverified: 'turn_state.event_ticket_unverified',
  ticket_revoked: 'turn_state.event_ticket_revoked',
  ticket_revalidating: 'turn_state.event_ticket_revalidating',
  ticket_expired: 'turn_state.event_ticket_expired',
  ticket_no_candidate: 'turn_state.event_ticket_no_candidate',
  ticket_target_mismatch: 'turn_state.event_ticket_target_mismatch',
  ticket_model_unknown: 'turn_state.event_ticket_model_unknown',
  ticket_revalidation_failed: 'turn_state.event_ticket_revalidation_failed',
  ticket_revalidation_required: 'turn_state.event_ticket_revalidation_required',
  reused_ws_not_mutated: 'turn_state.event_reused_ws',
};

/** 成功类结果不是失败，会话卡的“失败原因”行不得使用它们。 */
const SUCCESS_RESULTS = new Set(['accepted', 'accepted_model_mismatch', 'ticket_verified']);
/** 主动采集卡同时归集 generic probe 与 ticket harvest 两个来源，失败原因必须两者都看。 */
const ACTIVE_SOURCES = new Set(['active', 'ticket']);

type Translate = (key: string, options?: Record<string, string | number>) => string;

/** 相对时间只用于“刚刚 / N 分钟前”，精确时间在 title 里给出。 */
const relativeTime = (iso: string | null, now: number, t: Translate): string | null => {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return null;
  const seconds = Math.max(0, Math.floor((now - parsed) / 1000));
  if (seconds < 60) return t('turn_state.relative_just_now');
  if (seconds < 3600) return t('turn_state.relative_minutes_ago', { count: Math.floor(seconds / 60) });
  if (seconds < 86_400) return t('turn_state.relative_hours_ago', { count: Math.floor(seconds / 3600) });
  return t('turn_state.relative_days_ago', { count: Math.floor(seconds / 86_400) });
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
  // 模型替换数据只拉一次；合并总表与趋势图共用这一份，避免同一屏两组数字打架。
  const substitution = useModelSubstitution({ refreshKey, onAuthRequired });
  const topSubstitution = substitution.data?.summary.top_substitution ?? null;
  const formatCount = (value: number) => value.toLocaleString();
  const remainingMinutes = (state: TurnStateSummary | null) => state ? Math.max(0, Math.floor((Date.parse(state.expires_at) - now) / 60_000)) : 0;

  // 徽标只用契约允许的状态词；未知 phase 归到“未就绪”，不显示原始码。

  /**
   * 失败原因的单一映射入口：先看结论句（no_state / incomplete / auth_blocked …），
   * 再看失败规则（block_mismatch / encoding_* …），最后回退到保留原始码的未知原因。
   */
  const failureLabel = (code: string | null, reason: string | null): string | null => {
    if (!code && !reason) return null;
    const resultKey = code ? EVENT_RESULT_KEYS[code] : undefined;
    if (resultKey && code && !SUCCESS_RESULTS.has(code)) return t(resultKey);
    const ruleCode = reason ?? code ?? '';
    const ruleKey = STATE_CHECK_REASON_LABEL_KEYS[ruleCode];
    if (ruleKey) return t(ruleKey);
    return EVENT_RESULT_KEYS[ruleCode] ? t(EVENT_RESULT_KEYS[ruleCode]) : t('turn_state.event_rule_unknown', { code: ruleCode });
  };

  /** 会话最近一次失败原因：优先用 proxy 的结构化 last_failure，缺失时按最后结果码说明。 */

  const stale = snapshot && (failed || now - Date.parse(snapshot.server_time) > 90_000 || (fetched && now - Date.parse(fetched) > 90_000));
  const sessions = snapshot?.sessions ?? [];
  const events = snapshot?.events ?? [];
  const readySessions = snapshot?.summary.ready ?? 0;

  /**
   * 按来源取最近一次失败原因。必须区分 passive / active：last_failure 是「两种来源共用的最后一个结果」，
   * 直接拿它给被动采集卡会让主动探测的失败被当成被动采集的问题，就是错误归因。
   * 形状先整体格式化，再一次性拼到标签后面（禁止嵌套模板）。
   */
  const latestFailureBySource = (source: 'passive' | 'active'): string | null => {
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index];
      // 主动采集现在有两来源（generic probe + ticket harvest），它们共用同一张卡。
      const matches = source === 'active' ? ACTIVE_SOURCES.has(event.source) : event.source === source;
      if (!matches) continue;
      // 成功不是失败；dispatched 是“请求已发出”的中间生命周期事件，不是终态；
      // discard 表示被更新的观测取代，也不是质量信号。
      if (event.action === 'accept' || SUCCESS_RESULTS.has(event.result) || event.result === 'model_unknown') continue;
      if (event.action === 'discard' || (event.action === 'probe' && event.result === 'dispatched')) continue;
      const label = failureLabel(event.result, event.reason);
      if (!label) continue;
      const comparison = formatStateComparison(
        event.observed_blocks,
        event.expected_blocks,
        t,
        stateShapeCharacters(event.observed_blocks),
        stateShapeCharacters(event.expected_blocks),
      );
      return comparison ? `${label}：${comparison}` : label;
    }
    return null;
  };
  const lastActiveFailure = latestFailureBySource('active');
  const lastPassiveFailure = latestFailureBySource('passive');
  /**
   * 主动采集卡读合并口径：generic probe + ticket harvest。
   * 旧 proxy 没有 active_attempts，必须回退到 active_probes，否则卡会显示成 0 而与实际采集不符。
   */
  const activeAttempts = snapshot?.summary.active_attempts ?? snapshot?.summary.active_probes ?? 0;
  const activeAccepted = snapshot?.summary.active_accepted ?? snapshot?.summary.accepted_probes ?? 0;
  const activeRejected = snapshot?.summary.active_rejected ?? snapshot?.summary.rejected_probes ?? 0;
  // 累计起点是可选字段；缺失时不渲染该行，不编造一个时间。
  const cumulativeSince = snapshot?.summary.since ?? null;
  /** 滚动 1 小时的真实 dispatch 速率。这是用户把控消耗的实时数字，与累计数互补。
   *  旧 proxy 不返回该字段，此时整行不渲染，绝不能退化成 0。 */
  const activeLastHour = snapshot?.summary.active_last_hour ?? null;
  /** 某个来源最近一次事件的时间：主动探测用它而非 last_injected_at（仅观察模式从不注入，后者永远是空）。 */
  const latestEventAt = (source: 'passive' | 'active'): string | null => {
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index];
      const matches = source === 'active' ? ACTIVE_SOURCES.has(event.source) : event.source === source;
      if (matches) return event.at;
    }
    return null;
  };
  const lastActiveAt = latestEventAt('active');
  // 最近一次观测/注入时间取所有账号模型的最近值；没有则显示“暂无”。
  const latestOf = (pick: (session: TurnStateSession) => string | null | undefined) => sessions
    .map(pick).filter((value): value is string => !!value)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
  // 被动采集优先用会话上的最近观测时间（它是权威值），回退到事件时间。
  const lastObserved = latestOf((session) => session.last_observed_at) ?? latestEventAt('passive');
  const boolText = (value: boolean | null | undefined) => value == null ? t('turn_state.not_available') : value ? t('turn_state.value_on') : t('turn_state.value_off');
  const secondsText = (value: number | null | undefined) => value == null ? t('turn_state.not_available') : t('turn_state.config_seconds', { value });
  const countText = (value: number | null | undefined) => value == null ? t('turn_state.not_available') : t('turn_state.config_count', { value });

  return <section className={styles.panel} aria-label={t('turn_state.title')}>
    {/* 合并总表是页面的第一结论：谁被换成了谁、state 怎么样、采到没有，
        三件事在同一个「账号 x 模型」行里回答，不再分成两块大盘各自汇总。 */}
    <Card title={t('turn_state.title')} subtitle={t('turn_state.merged_help')}
      extra={<div className={styles.rangeGroup} role="group" aria-label={t('turn_state.model_sub_range_label')}>
        {MODEL_SUBSTITUTION_RANGE_SELECTIONS.map((value) => (
          <button
            key={value}
            type="button"
            className={`${styles.rangeButton} ${value === substitution.selection ? styles.rangeButtonActive : ''}`.trim()}
            aria-pressed={value === substitution.selection}
            onClick={() => substitution.selectRange(value)}
          >
            {value === MODEL_SUBSTITUTION_CURRENT ? t('turn_state.merged_range_current') : t(RANGE_LABEL_KEYS[value])}
          </button>
        ))}
      </div>}
    >
      <p role="status" className={stale ? styles.warning : styles.snapshotStatus} data-turn-state-status>
        {!snapshot ? t(failed ? 'turn_state.unavailable' : 'common.loading') : stale ? t('turn_state.stale') : t('turn_state.current')}
      </p>
      {substitution.failed && !substitution.data && <p role="status" className={styles.warning}>{t('turn_state.model_sub_unavailable')}</p>}
      {/* 刷新失败时保留上一份数据，但必须说明当前显示的不是所选范围。 */}
      {substitution.failed && substitution.data && <p role="status" className={styles.warning} data-model-subscription-stale>{t('turn_state.stale')}</p>}
      <TurnStateMergedTable
        rows={substitution.data?.current ?? []}
        sessions={snapshot?.sessions ?? []}
        selection={substitution.selection}
      />
      <p className={styles.cardMeta}>{t('turn_state.merged_polling')}</p>
    </Card>
    {/* 历史趋势与矩阵从合并总表里拆出来：总表回答“现在”，趋势回答“随时间怎么变”。 */}
    <ModelSubstitutionPanel controller={substitution} />
    {snapshot && <>
      <div className={styles.overviewGrid}>
        <Card title={t('turn_state.overview_ready')}>
          <strong className={styles.metric}>{formatCount(snapshot.summary.usable)}</strong>
          <p>{snapshot.summary.usable === 0 ? t('turn_state.overview_ready_none') : t('turn_state.overview_ready_help')}</p>
        </Card>
        <Card title={t('turn_state.overview_probes')}>
          <strong className={styles.metric}>{formatCount(activeAttempts)}</strong>
          <p>{activeAttempts === 0
            ? t('turn_state.overview_capture_none')
            : t('turn_state.overview_capture_split', { accepted: activeAccepted, rejected: activeRejected })}</p>
          {activeLastHour !== null && <p className={styles.cardMeta} data-turn-state-active-last-hour>{t('turn_state.overview_last_hour', { count: activeLastHour })}</p>}
          <p className={styles.cardMeta}>{t('turn_state.last_updated', { time: relativeTime(lastActiveAt, now, t) ?? t('turn_state.not_available') })}</p>
          {cumulativeSince && <p className={styles.cardMeta} data-turn-state-active-since>{t('turn_state.overview_since', { time: dateTime(cumulativeSince, unknown) })}</p>}
          {lastActiveFailure && <p className={styles.failureNote} data-turn-state-active-failure>{lastActiveFailure}</p>}
        </Card>
        {/* 被动采集与主动探测对称展示：尝试次数 + 成功/未通过 + 最近更新时间 + 最近失败原因。
            它来自正常业务请求，是判断模型替换与状态的主要来源。 */}
        <Card title={t('turn_state.overview_observed')}>
          <strong className={styles.metric} data-turn-state-passive-observed>{formatCount(snapshot.summary.passive_observations)}</strong>
          <p>{snapshot.summary.passive_observations === 0
            ? t('turn_state.overview_capture_none')
            : t('turn_state.overview_capture_split', {
              accepted: snapshot.summary.passive_accepted ?? 0,
              rejected: snapshot.summary.passive_rejected ?? 0,
            })}</p>
          <p className={styles.cardMeta}>{t('turn_state.last_updated', { time: relativeTime(lastObserved, now, t) ?? t('turn_state.not_available') })}</p>
          {lastPassiveFailure && <p className={styles.failureNote} data-turn-state-passive-failure>{lastPassiveFailure}</p>}
        </Card>
        <Card title={t('turn_state.overview_substitution')}>
          <strong className={styles.metric} data-turn-state-top-substitution>
            {topSubstitution
              ? `${topSubstitution.from} → ${topSubstitution.to}`
              : t('turn_state.substitution_none')}
          </strong>
          <p>{topSubstitution
            ? t('turn_state.overview_substitution_count', { count: topSubstitution.count })
            : t('turn_state.substitution_none')}</p>
        </Card>
        <Card title={t('turn_state.overview_sessions')}>
          <strong className={styles.metric}>{formatCount(snapshot.summary.sessions)}</strong>
          <p>{readySessions === 0 ? t('turn_state.overview_sessions_none_ready') : t('turn_state.overview_sessions_ready', { count: readySessions })}</p>
        </Card>
      </div>

      <Card title={t('turn_state.config')} subtitle={t('turn_state.config_help')}>
        <table className={styles.configTable} data-turn-state-config>
          <thead>
            <tr>
              <th scope="col">{t('turn_state.config_column')}</th>
              <th scope="col">{t('turn_state.config_state_column')}</th>
              <th scope="col">{t('turn_state.config_meaning_column')}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">{t('turn_state.config_experiment')}</th>
              <td data-config-value={snapshot.config.enabled ? 'on' : 'off'}>{boolText(snapshot.config.enabled)}</td>
              <td>{t('turn_state.config_experiment_help')}</td>
            </tr>
            <tr>
              <th scope="row">{t('turn_state.config_passive')}</th>
              <td data-config-value={snapshot.config.passive_enabled ? 'on' : 'off'}>{boolText(snapshot.config.passive_enabled)}</td>
              <td>{t('turn_state.config_passive_help')}</td>
            </tr>
            <tr>
              <th scope="row">{t('turn_state.config_active')}</th>
              <td data-config-value={snapshot.config.active_enabled ? 'on' : 'off'}>{boolText(snapshot.config.active_enabled)}</td>
              <td>{t('turn_state.config_active_help')}</td>
            </tr>
            <tr>
              <th scope="row">{t('turn_state.config_mode')}</th>
              <td data-config-value={snapshot.config.mode}>{t(`turn_state.mode_${snapshot.config.mode}`)}</td>
              <td>{t('turn_state.config_mode_help')}</td>
            </tr>
            <tr>
              <th scope="row">{t('turn_state.config_fallback')}</th>
              <td data-config-value={snapshot.config.fallback}>{snapshot.config.fallback === 'strict' ? t('turn_state.config_fallback_strict') : t('turn_state.config_fallback_pass')}</td>
              <td>{t('turn_state.config_fallback_help')}</td>
            </tr>
            <tr>
              <th scope="row">{t('turn_state.config_harvest_proxy')}</th>
              <td data-config-value={snapshot.config.harvest_proxy_url ? 'custom' : 'default'}>{snapshot.config.harvest_proxy_url ? t('turn_state.config_custom_route') : t('turn_state.config_default_route')}</td>
              <td>{t('turn_state.config_harvest_proxy_help')}</td>
            </tr>
            <tr>
              <th scope="row">{t('turn_state.config_revalidate')}</th>
              <td data-config-value={snapshot.config.revalidate == null ? 'unknown' : snapshot.config.revalidate ? 'on' : 'off'}>{boolText(snapshot.config.revalidate)}</td>
              <td>{t('turn_state.config_revalidate_help')}</td>
            </tr>
            <tr>
              <th scope="row">{t('turn_state.config_mismatch')}</th>
              <td data-config-value={snapshot.config.mismatch_is_success == null ? 'unknown' : snapshot.config.mismatch_is_success ? 'on' : 'off'}>{snapshot.config.mismatch_is_success == null ? t('turn_state.not_available') : snapshot.config.mismatch_is_success ? t('turn_state.config_mismatch_success') : t('turn_state.config_mismatch_failure')}</td>
              <td>{t('turn_state.config_mismatch_help')}</td>
            </tr>
            <tr>
              <th scope="row">{t('turn_state.config_rule')}</th>
              <td data-config-value={snapshot.config.account_mode}>
                {t('turn_state.rule_value', {
                  plan: snapshot.config.account_mode === 'team' ? t('turn_state.plan_team') : t('turn_state.plan_personal'),
                  shape: formatStateShape(snapshot.config.account_mode === 'team' ? 12 : 10, t),
                })}
                {snapshot.config.account_mode === 'auto' ? `（${t('turn_state.rule_auto')}）` : ''}
              </td>
              <td>{t('turn_state.config_rule_help')}</td>
            </tr>
            <tr><th scope="row">{t('turn_state.config_ttl')}</th><td>{secondsText(snapshot.config.ttl_seconds)}</td><td>{t('turn_state.config_ttl_help')}</td></tr>
            <tr><th scope="row">{t('turn_state.config_refresh')}</th><td>{secondsText(snapshot.config.refresh_before_seconds)}</td><td>{t('turn_state.config_refresh_help')}</td></tr>
            <tr><th scope="row">{t('turn_state.config_timeout')}</th><td>{secondsText(snapshot.config.probe_timeout_seconds)}</td><td>{t('turn_state.config_timeout_help')}</td></tr>
            <tr><th scope="row">{t('turn_state.config_cooldown')}</th><td>{secondsText(snapshot.config.cooldown_seconds)}</td><td>{t('turn_state.config_cooldown_help')}</td></tr>
            <tr><th scope="row">{t('turn_state.config_attempts')}</th><td>{countText(snapshot.config.max_attempts_per_round)}</td><td>{t('turn_state.config_attempts_help')}</td></tr>
            <tr><th scope="row">{t('turn_state.config_revoke')}</th><td>{countText(snapshot.config.revoke_after_signals)}</td><td>{t('turn_state.config_revoke_help')}</td></tr>
          </tbody>
        </table>
      </Card>

    </>}
  </section>;
}
