import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, fetchTurnStateOverview } from '@/lib/api';
import type { TurnStateFailure, TurnStateOverview, TurnStateSession, TurnStateSummary } from '@/lib/turnState';
import { Card } from '@/components/ui/Card';
import { ModelSubstitutionPanel, useModelSubstitution } from './ModelSubstitutionPanel';
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
};

/** 成功类结果不是失败，会话卡的“失败原因”行不得使用它们。 */
const SUCCESS_RESULTS = new Set(['accepted', 'accepted_model_mismatch']);

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

const countdown = (iso: string | null, now: number, t: Translate): string | null => {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return null;
  const seconds = Math.ceil((parsed - now) / 1000);
  if (seconds <= 0) return t('turn_state.countdown_now');
  if (seconds < 60) return t('turn_state.countdown_seconds', { count: seconds });
  return t('turn_state.countdown_minutes', { count: Math.ceil(seconds / 60) });
};

/** 形状推导值只在没有实测长度时使用，且始终与块数一起出现。 */
const shapeWithFallbackLength = (length: number | null, blocks: number | null, t: Translate): string =>
  formatStateShape(blocks, t, length ?? stateShapeCharacters(blocks));

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
  // 模型替换数据只拉一次；结论卡（§2）与替换历史（§7）共用这一份，避免同一屏两组数字打架。
  const substitution = useModelSubstitution({ refreshKey, onAuthRequired });
  const topSubstitution = substitution.data?.summary.top_substitution ?? null;
  const formatCount = (value: number) => value.toLocaleString();
  const remainingMinutes = (state: TurnStateSummary | null) => state ? Math.max(0, Math.floor((Date.parse(state.expires_at) - now) / 60_000)) : 0;

  // 徽标只用契约允许的状态词；未知 phase 归到“未就绪”，不显示原始码。
  const statusText = (session: TurnStateSession) => {
    if (session.excluded) return t('turn_state.status_not_applicable');
    const key = PHASE_STATUS_KEYS[session.phase] ?? 'turn_state.status_not_ready';
    return t(key);
  };
  const statusTone = (session: TurnStateSession) => {
    if (session.excluded) return styles.muted;
    if (session.active?.usable) return styles.good;
    if (session.phase === 'blocked' || session.phase === 'paused') return styles.warn;
    return styles.muted;
  };

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
  const sessionFailure = (session: TurnStateSession): string | null => {
    const failure: TurnStateFailure | null | undefined = session.last_failure;
    // 成功类结果不是失败，不得渲染“失败原因”行（否则成功也会显示一条未知原因）。
    if (!failure) {
      const result = session.last_result ?? null;
      if (!result || SUCCESS_RESULTS.has(result) || result === 'model_unknown') return null;
      return failureLabel(result, null);
    }
    const label = failureLabel(failure.code ?? null, failure.reason ?? null) ?? t('turn_state.event_rule_unknown', { code: failure.code });
    // 形状先整体格式化，再一次性拼到标签后面。
    const comparison = formatStateComparison(
      failure.observed_blocks,
      failure.expected_blocks,
      t,
      stateShapeCharacters(failure.observed_blocks),
      stateShapeCharacters(failure.expected_blocks),
    );
    return comparison ? `${label}：${comparison}` : label;
  };

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
      if (event.source !== source) continue;
      // 成功不是失败；discard 表示被更新的观测取代，不是质量信号。
      if (event.action === 'accept' || SUCCESS_RESULTS.has(event.result) || event.result === 'model_unknown') continue;
      if (event.action === 'discard') continue;
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
  /** 某个来源最近一次事件的时间：主动探测用它而非 last_injected_at（仅观察模式从不注入，后者永远是空）。 */
  const latestEventAt = (source: 'passive' | 'active'): string | null => {
    for (let index = events.length - 1; index >= 0; index--) {
      if (events[index].source === source) return events[index].at;
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

  return <section className={styles.panel} aria-label={t('turn_state.title')}>
    {/* 模型替换观测是页面的第一结论：谁被换成了谁，优先于 proxy 运行时缓存细节。
        它读 Keeper 自己的库，proxy 概览不可用时也必须继续渲染。 */}
    <ModelSubstitutionPanel controller={substitution} />
    <Card title={t('turn_state.title')} subtitle={t('turn_state.updated_at', { time: dateTime(fetched, unknown) })}>
      <p role="status" className={stale ? styles.warning : styles.snapshotStatus} data-turn-state-status>
        {!snapshot ? t(failed ? 'turn_state.unavailable' : 'common.loading') : stale ? t('turn_state.stale') : t('turn_state.current')}
      </p>
    </Card>
    {snapshot && <>
      <div className={styles.overviewGrid}>
        <Card title={t('turn_state.overview_ready')}>
          <strong className={styles.metric}>{formatCount(snapshot.summary.usable)}</strong>
          <p>{snapshot.summary.usable === 0 ? t('turn_state.overview_ready_none') : t('turn_state.overview_ready_help')}</p>
        </Card>
        <Card title={t('turn_state.overview_probes')}>
          <strong className={styles.metric}>{formatCount(snapshot.summary.active_probes)}</strong>
          <p>{snapshot.summary.active_probes === 0
            ? t('turn_state.overview_capture_none')
            : t('turn_state.overview_capture_split', { accepted: snapshot.summary.accepted_probes, rejected: snapshot.summary.rejected_probes })}</p>
          <p className={styles.cardMeta}>{t('turn_state.last_updated', { time: relativeTime(lastActiveAt, now, t) ?? t('turn_state.not_available') })}</p>
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
              <td data-config-value={snapshot.config.enabled && snapshot.config.mode !== 'off' ? 'on' : 'off'}>
                {snapshot.config.enabled && snapshot.config.mode !== 'off' ? t('turn_state.value_on') : t('turn_state.value_off')}
              </td>
              <td>{t('turn_state.config_experiment_help')}</td>
            </tr>
            <tr>
              <th scope="row">{t('turn_state.config_passive')}</th>
              <td data-config-value={snapshot.config.passive_enabled ? 'on' : 'off'}>
                {snapshot.config.passive_enabled ? t('turn_state.value_on') : t('turn_state.value_off')}
              </td>
              <td>{t('turn_state.config_passive_help')}</td>
            </tr>
            <tr>
              <th scope="row">{t('turn_state.config_active')}</th>
              <td data-config-value={snapshot.config.active_enabled ? 'on' : 'off'}>
                {snapshot.config.active_enabled ? t('turn_state.value_on') : t('turn_state.value_off')}
              </td>
              <td>{t('turn_state.config_active_help')}</td>
            </tr>
            <tr>
              <th scope="row">{t('turn_state.config_mode')}</th>
              <td data-config-value={snapshot.config.mode}>{t(`turn_state.mode_${snapshot.config.mode}`)}</td>
              <td>{t('turn_state.config_mode_help')}</td>
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
          </tbody>
        </table>
      </Card>

      <Card title={t('turn_state.sessions')} subtitle={t('turn_state.session_help')}>
        {!sessions.length && <p>{t('turn_state.empty')}</p>}
        {sessions.map((session, index) => <article key={`${session.entry_id}:${session.model}:${index}`} className={styles.entry}>
          <div className={styles.sessionHeader}>
            <div>
              <h4>{session.account_label ?? session.entry_id.slice(0, 12)} · {session.model}</h4>
            </div>
            <span className={`${styles.badge} ${statusTone(session)}`}>{statusText(session)}</span>
          </div>
          {session.excluded
            ? <p className={styles.subtle}>{t('turn_state.excluded_reason')}</p>
            : <dl className={styles.fields}>
              <div>
                <dt>{t('turn_state.current_state')}</dt>
                <dd>{session.active?.usable
                  ? `${t('turn_state.state_ready')}（${shapeWithFallbackLength(session.active.length, session.active.blocks, t)}，${t('turn_state.remaining')} ${remainingMinutes(session.active)} ${t('turn_state.minutes')}）`
                  : t('turn_state.state_unavailable')}</dd>
              </div>
              <div>
                <dt>{t('turn_state.last_probe')}</dt>
                <dd>{relativeTime(session.last_observed_at, now, t) ?? t('turn_state.not_available')}
                  {session.last_result ? ` · ${EVENT_RESULT_KEYS[session.last_result] ? t(EVENT_RESULT_KEYS[session.last_result]) : session.last_result}` : ''}</dd>
              </div>
              {sessionFailure(session) && <div className={styles.failureField}><dt>{t('turn_state.failure_reason')}</dt><dd data-turn-state-failure>{sessionFailure(session)}</dd></div>}
              <div><dt>{t('turn_state.requested_model')}</dt><dd>{session.model}</dd></div>
              <div>
                <dt>{t('turn_state.actual_model')}</dt>
                <dd>{session.last_upstream_model
                  ? `${session.last_upstream_model}（${session.model_mismatch ? t('turn_state.model_replaced') : t('turn_state.model_matched')}）`
                  : t('turn_state.model_unobserved')}</dd>
              </div>
              {session.next_probe_at && <div><dt>{t('turn_state.next_probe')}</dt><dd>{countdown(session.next_probe_at, now, t)}</dd></div>}
              <div>
                <dt>{t('turn_state.business_injection')}</dt>
                <dd>{session.injection_count === 0
                  ? t('turn_state.injection_none')
                  : t('turn_state.injection_count', { count: session.injection_count, time: dateTime(session.last_injected_at, unknown) })}</dd>
              </div>
              <div>
                <dt>{t('turn_state.backup_state')}</dt>
                <dd>{session.ready?.usable
                  ? `${t('turn_state.available')}（${shapeWithFallbackLength(session.ready.length, session.ready.blocks, t)}）`
                  : t('turn_state.none')}</dd>
              </div>
              {!!session.ws_connection_reused && <div><dt>{t('turn_state.reused_connections')}</dt><dd>{formatCount(session.ws_connection_reused)}</dd></div>}
            </dl>}
          {/* 只渲染存在值的诊断项；缺值的项不出现，不用“未知”占位。 */}
          <details>
            <summary>{t('turn_state.technical_details')}</summary>
            <dl className={styles.fields}>
              <div><dt>{t('turn_state.entry_id')}</dt><dd>{session.entry_id}</dd></div>
              {session.active?.route_id && <div><dt>{t('turn_state.route_id')}</dt><dd>{session.active.route_id}</dd></div>}
              {session.active?.fingerprint && <div><dt>{t('turn_state.fingerprint')}</dt><dd>{session.active.fingerprint}</dd></div>}
              {session.diagnostic && <div><dt>{t('turn_state.diagnostic')}</dt><dd>{session.diagnostic}</dd></div>}
              {snapshot.epoch && <div><dt>{t('turn_state.epoch')}</dt><dd>{snapshot.epoch}</dd></div>}
            </dl>
          </details>
        </article>)}
      </Card>
    </>}
  </section>;
}
