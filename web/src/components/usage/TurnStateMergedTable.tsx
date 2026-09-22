import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  accountDisplayName,
  DEFAULT_MODEL_SUBSTITUTION_SORT,
  isHistoricalRange,
  sortModelSubstitutionRows,
  toRelativeTimeAmount,
  type ModelSubstitutionCurrentRow,
  type ModelSubstitutionRangeSelection,
  type ModelSubstitutionSort,
  type ModelSubstitutionSortKey,
} from '@/lib/modelSubstitution';
import type { TurnStateSession } from '@/lib/turnState';
import {
  formatStateComparison,
  formatStateShape,
  resolveStateCheckPresentation,
  stateShapeCharacters,
} from '@/utils/usage/stateCheck';
import styles from './TurnStateMergedTable.module.scss';

/**
 * 合并总表：行 = 账号 x 模型，把「模型替换观测」与「模型质量」两块大盘合成一张表，
 * 因为它们回答的是同一个问题（这次请求到底降智了没有，只是分别看模型侧与 state 侧）。
 *
 * 分两块视觉区：
 *   块 1 观测     —— 回答“降智了吗”（上游实际模型、一致率、State 形状、替换率、降智率）。
 *   块 2 State 与采集 —— 回答“采到了吗、用上了吗”（State、有效期、下次采集、注入、被动、主动）。
 *
 * 历史档只显示窗口聚合；有效期与下次采集是瞬时值，历史档必须隐藏，
 * 否则会把“现在还剩多少分钟”当成“那个窗口里的状态”。
 */

interface MergedTableProps {
  /** 模型替换接口返回的账号 x 模型行。 */
  rows: ModelSubstitutionCurrentRow[];
  /** proxy 概览的会话列表（账号 x 模型），用于 State 与采集两列。 */
  sessions: TurnStateSession[];
  /** 当前选择的时间维度；决定哪些列有意义。 */
  selection: ModelSubstitutionRangeSelection;
}

/** 会话按「账号 x 模型」索引，与观测行的键保持同一套拼法。 */
const sessionKey = (entryId: string, model: string): string => `${entryId}\u0000${model}`;

/** 计数容错：旧后端或归一化不完整的行缺字段时当作 0，而不是让整张表抛错。 */
const safeCount = (value: number | undefined): string => (typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : '0');

const percentText = (value: number | null | undefined): string | null =>
  typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)}%` : null;

export function TurnStateMergedTable({ rows, sessions, selection }: MergedTableProps) {
  const { t } = useTranslation();
  const [sort, setSort] = useState<ModelSubstitutionSort>(DEFAULT_MODEL_SUBSTITUTION_SORT);
  const historical = isHistoricalRange(selection);

  const sessionsByKey = useMemo(() => {
    const map = new Map<string, TurnStateSession>();
    for (const session of sessions) map.set(sessionKey(session.entry_id, session.model), session);
    return map;
  }, [sessions]);

  const sorted = useMemo(() => sortModelSubstitutionRows(rows, sort), [rows, sort]);

  /** 点击列头切换排序；再次点击同一列翻转方向。 */
  const toggleSort = (key: ModelSubstitutionSortKey) => {
    setSort((current) => current.key === key
      ? { key, direction: current.direction === 'desc' ? 'asc' : 'desc' }
      : { key, direction: 'desc' });
  };
  const sortIndicator = (key: ModelSubstitutionSortKey) => (sort.key === key ? (sort.direction === 'desc' ? '▾' : '▴') : '');

  const relativeTime = (iso: string, ageSeconds: number) => {
    const amount = toRelativeTimeAmount(ageSeconds);
    if (!amount) {
      const parsed = Date.parse(iso);
      return Number.isNaN(parsed) ? t('turn_state.not_available') : new Date(parsed).toLocaleString();
    }
    if (amount.unit === 'second' && amount.value < 5) return t('turn_state.relative_just_now');
    const key = {
      second: 'turn_state.relative_seconds_ago',
      minute: 'turn_state.relative_minutes_ago',
      hour: 'turn_state.relative_hours_ago',
      day: 'turn_state.relative_days_ago',
    }[amount.unit];
    return t(key, { count: amount.value });
  };

  /** State 形状：已上报 state_check 才给出判定；未上报时中性呈现，绝不显示成正常。 */
  const stateCell = (row: ModelSubstitutionCurrentRow) => {
    const presentation = resolveStateCheckPresentation(row.state_check ?? '', row.state_check_reason ?? '');
    if (!presentation) return { tone: 'none' as const, label: t('turn_state.merged_state_unobserved') };
    const detail = formatStateComparison(
      row.state_check_observed_blocks,
      row.state_check_expected_blocks,
      t,
      stateShapeCharacters(row.state_check_observed_blocks),
      stateShapeCharacters(row.state_check_expected_blocks),
    );
    const label = presentation.labelKey ? t(presentation.labelKey) : presentation.verdictCode;
    return { tone: presentation.tone, label, detail };
  };

  const remainingMinutes = (session: TurnStateSession | undefined): number | null => {
    const expiresAt = session?.active?.expires_at;
    if (!expiresAt) return null;
    const parsed = Date.parse(expiresAt);
    return Number.isNaN(parsed) ? null : Math.max(0, Math.floor((parsed - Date.now()) / 60_000));
  };

  const nextProbeCountdown = (session: TurnStateSession | undefined): string | null => {
    if (!session?.next_probe_at) return null;
    const parsed = Date.parse(session.next_probe_at);
    if (Number.isNaN(parsed)) return null;
    const seconds = Math.ceil((parsed - Date.now()) / 1000);
    if (seconds <= 0) return t('turn_state.countdown_now');
    if (seconds < 60) return t('turn_state.countdown_seconds', { count: seconds });
    return t('turn_state.countdown_minutes', { count: Math.ceil(seconds / 60) });
  };

  if (sorted.length === 0) {
    return <div className={styles.surface} data-turn-state-merged-table>
      <p className={styles.empty} data-turn-state-merged-empty>{t('turn_state.merged_empty')}</p>
    </div>;
  }

  return <div className={styles.surface} data-turn-state-merged-table>
    <table className={styles.table}>
      <thead>
        <tr className={styles.groupRow}>
          <th scope="col" colSpan={5}>{t('turn_state.merged_group_observation')}</th>
          <th scope="col" colSpan={historical ? 3 : 1}>{t('turn_state.merged_group_state')}</th>
          <th scope="col" colSpan={historical ? 4 : 3}>{t('turn_state.merged_group_collection')}</th>
        </tr>
        <tr>
          <th scope="col">{t('turn_state.merged_account')}</th>
          <th scope="col">{t('turn_state.merged_model')}</th>
          <th scope="col">{t('turn_state.merged_upstream')}</th>
          <th scope="col">{t('turn_state.merged_last_observed')}</th>
          <th scope="col">{t('turn_state.merged_state_shape')}</th>
          <th scope="col">
            <button type="button" className={styles.sortButton} onClick={() => toggleSort('requests')} aria-pressed={sort.key === 'requests'}>
              {t('turn_state.merged_requests')} {sortIndicator('requests')}
            </button>
          </th>
          {historical && <th scope="col">
            <button type="button" className={styles.sortButton} onClick={() => toggleSort('mismatch_rate')} aria-pressed={sort.key === 'mismatch_rate'}>
              {t('turn_state.merged_mismatch_rate')} {sortIndicator('mismatch_rate')}
            </button>
          </th>}
          {historical && <th scope="col">
            <button type="button" className={styles.sortButton} onClick={() => toggleSort('state_check_failure_rate')} aria-pressed={sort.key === 'state_check_failure_rate'}>
              {t('turn_state.merged_degraded_rate')} {sortIndicator('state_check_failure_rate')}
            </button>
          </th>}
          <th scope="col">{t('turn_state.merged_current_state')}</th>
          {/* 有效期与下次采集是瞬时值：历史档隐藏，避免读成“那个窗口里的状态”。 */}
          {!historical && <th scope="col">{t('turn_state.merged_expires')}</th>}
          {!historical && <th scope="col">{t('turn_state.merged_next_probe')}</th>}
          <th scope="col">{t('turn_state.merged_injected')}</th>
          <th scope="col">{t('turn_state.merged_passive')}</th>
          <th scope="col">
            <button type="button" className={styles.sortButton} onClick={() => toggleSort('probe_attempts')} aria-pressed={sort.key === 'probe_attempts'}>
              {t('turn_state.merged_active')} {sortIndicator('probe_attempts')}
            </button>
          </th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((row) => {
          const session = sessionsByKey.get(sessionKey(row.account_entry_id ?? '', row.requested_model));
          const state = stateCell(row);
          const mismatchRate = percentText(row.mismatch_rate);
          const degradedRate = percentText(row.state_check_failure_rate);
          const remaining = remainingMinutes(session);
          const countdown = nextProbeCountdown(session);
          return <tr key={`${row.account_entry_id ?? ''}:${row.requested_model}`}>
            <th scope="row" className={styles.account}>{accountDisplayName(row) || t('turn_state.merged_unnamed_account')}</th>
            <td className={styles.model}>{row.requested_model}</td>
            {/* 从未观测到上游模型时必须说“未观测”，不能显示一个空单元格让人误以为一致。 */}
            <td className={styles.model}>{row.observed ? row.upstream_model : t('turn_state.model_unobserved')}</td>
            <td className={styles.observed}>
              {row.observed ? relativeTime(row.observed_at, row.age_seconds) : t('turn_state.not_available')}
            </td>
            <td data-merged-state={state.tone}>
              {state.label}
              {state.detail ? <small className={styles.detail}>{state.detail}</small> : null}
            </td>
            <td className={styles.count}>{safeCount(row.request_count)}</td>
            {historical && <td className={styles.count}>{mismatchRate ?? t('turn_state.not_available')}</td>}
            {historical && <td className={styles.count}>{degradedRate ?? t('turn_state.not_available')}</td>}
            <td>{session?.active?.usable
              ? t('turn_state.merged_state_ready', { shape: formatStateShape(session.active.blocks, t, session.active.length) })
              : t('turn_state.state_unavailable')}</td>
            {!historical && <td className={styles.count}>
              {remaining === null ? t('turn_state.not_available') : t('turn_state.merged_minutes_left', { count: remaining })}
            </td>}
            {!historical && <td className={styles.count}>{countdown ?? t('turn_state.not_available')}</td>}
            <td className={styles.count}>
              {session ? safeCount(session.injection_count) : '—'}
              <small className={styles.detail}>{t('turn_state.merged_cumulative')}</small>
            </td>
            <td className={styles.count}>
              {session ? safeCount(session.observation_count) : '—'}
              {historical && (row.state_check_observed ?? 0) > 0
                ? <small className={styles.detail}>{t('turn_state.merged_state_check_split', { observed: row.state_check_observed, failed: row.state_check_failed })}</small>
                : null}
            </td>
            <td className={styles.count}>
              {safeCount(row.probe_attempts)}
              {(row.probe_timeouts ?? 0) > 0
                ? <small className={styles.detail}>{t('turn_state.merged_timeouts', { count: row.probe_timeouts })}</small>
                : null}
            </td>
          </tr>;
        })}
      </tbody>
    </table>
  </div>;
}
