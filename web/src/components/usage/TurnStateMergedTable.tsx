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
import pageStyles from '@/pages/UsagePage.module.scss';
import styles from './TurnStateMergedTable.module.scss';

interface MergedTableProps {
  rows: ModelSubstitutionCurrentRow[];
  sessions: TurnStateSession[];
  selection: ModelSubstitutionRangeSelection;
}

const sessionKey = (entryId: string, model: string): string => `${entryId}\u0000${model}`;
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

  const stateCell = (row: ModelSubstitutionCurrentRow) => {
    const presentation = resolveStateCheckPresentation(row.state_check ?? '', row.state_check_reason ?? '');
    if (!presentation) return { tone: 'neutral' as const, label: t('turn_state.merged_state_unobserved') };
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
    return <div className={pageStyles.tableWrapper} data-turn-state-merged-table>
      <p className={styles.empty} data-turn-state-merged-empty>{t('turn_state.merged_empty')}</p>
    </div>;
  }

  const observationSpan = historical ? 8 : 6;
  const stateSpan = historical ? 1 : 3;

  return <div className={pageStyles.tableWrapper} data-turn-state-merged-table>
    <table className={pageStyles.table}>
      <thead>
        <tr className={styles.groupRow}>
          <th scope="col" colSpan={observationSpan}>{t('turn_state.merged_group_observation')}</th>
          <th scope="col" colSpan={stateSpan}>{t('turn_state.merged_group_state')}</th>
          <th scope="col" colSpan={3}>{t('turn_state.merged_group_collection')}</th>
        </tr>
        <tr>
          <th scope="col" className={pageStyles.sortableHeader}>
            <button type="button" className={pageStyles.sortHeaderButton} onClick={() => toggleSort('account')} aria-pressed={sort.key === 'account'}>
              {t('turn_state.merged_account')} {sortIndicator('account')}
            </button>
          </th>
          <th scope="col" className={pageStyles.sortableHeader}>
            <button type="button" className={pageStyles.sortHeaderButton} onClick={() => toggleSort('model')} aria-pressed={sort.key === 'model'}>
              {t('turn_state.merged_model')} {sortIndicator('model')}
            </button>
          </th>
          <th scope="col">{t('turn_state.merged_upstream')}</th>
          <th scope="col">{t('turn_state.merged_last_observed')}</th>
          <th scope="col">{t('turn_state.merged_state_shape')}</th>
          <th scope="col" className={pageStyles.sortableHeader}>
            <button type="button" className={pageStyles.sortHeaderButton} onClick={() => toggleSort('requests')} aria-pressed={sort.key === 'requests'}>
              {t('turn_state.merged_requests')} {sortIndicator('requests')}
            </button>
          </th>
          {historical && <th scope="col" className={pageStyles.sortableHeader}>
            <button type="button" className={pageStyles.sortHeaderButton} onClick={() => toggleSort('mismatch_rate')} aria-pressed={sort.key === 'mismatch_rate'}>
              {t('turn_state.merged_mismatch_rate')} {sortIndicator('mismatch_rate')}
            </button>
          </th>}
          {historical && <th scope="col" className={pageStyles.sortableHeader}>
            <button type="button" className={pageStyles.sortHeaderButton} onClick={() => toggleSort('state_check_failure_rate')} aria-pressed={sort.key === 'state_check_failure_rate'}>
              {t('turn_state.merged_degraded_rate')} {sortIndicator('state_check_failure_rate')}
            </button>
          </th>}
          <th scope="col">{t('turn_state.merged_current_state')}</th>
          {!historical && <th scope="col">{t('turn_state.merged_expires')}</th>}
          {!historical && <th scope="col">{t('turn_state.merged_next_probe')}</th>}
          <th scope="col">{t('turn_state.merged_injected')}</th>
          <th scope="col">{t('turn_state.merged_passive')}</th>
          <th scope="col" className={pageStyles.sortableHeader}>
            <button type="button" className={pageStyles.sortHeaderButton} onClick={() => toggleSort('probe_attempts')} aria-pressed={sort.key === 'probe_attempts'}>
              {t('turn_state.merged_active')} {sortIndicator('probe_attempts')}
            </button>
          </th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((row) => {
          const session = sessionsByKey.get(sessionKey(row.account_entry_id ?? '', row.requested_model));
          const state = stateCell(row);
          const upstreamTone = !row.observed ? 'neutral' : row.matched ? 'success' : 'danger';
          const mismatchRate = percentText(row.mismatch_rate);
          const degradedRate = percentText(row.state_check_failure_rate);
          // 当前档只读 proxy 的同一份数据：observation_count 与 accepted/rejected 同源同生命周期。
          // 绝不能用 session 的累计值去减 keeper 的窗口聚合 —— 两个数据源、两个时间窗，
          // 相减会凭空造出"成功次数"（实测出现过假 14 次）。
          const passiveObserved = historical ? row.state_check_observed : (session?.observation_count ?? row.state_check_observed);
          const sessionAccepted = session?.passive_accepted ?? null;
          const sessionRejected = session?.passive_rejected ?? null;
          // 当前档：只在 proxy 同时给出两端时拆分，否则只报总数。
          // 绝不能拿总数减 0 冒充“全部成功”，也不能拿它去减 keeper 的窗口聚合
          // （不同数据源、不同时间窗，会凭空造出“成功次数”）。
          const passiveFailed: number | null = historical ? row.state_check_failed : sessionRejected;
          const passiveAccepted: number | null = historical && passiveFailed !== null
            ? Math.max(0, passiveObserved - passiveFailed)
            : sessionAccepted;
          const activeAttempts = historical ? row.probe_attempts : ((session?.ticket_round_count ?? 0) + (session?.probe_count ?? 0));
          const activeAccepted = historical ? row.probe_accepted : 0;
          const activeRejected = historical ? row.probe_rejected : 0;
          const currentStateTone = session?.active?.usable ? 'success' : session?.last_failure ? 'danger' : 'neutral';
          const injectedCount = session?.injection_count ?? 0;
          return <tr key={`${row.account_entry_id ?? ''}:${row.requested_model}`}>
            <th scope="row" className={styles.account}>{accountDisplayName(row) || t('turn_state.merged_unnamed_account')}</th>
            <td className={styles.model}>{row.requested_model}</td>
            <td className={styles.model}>
              <span className={styles[upstreamTone]}>{row.observed ? row.upstream_model : t('turn_state.model_unobserved')}</span>
            </td>
            <td className={styles.observed}>{row.observed ? relativeTime(row.observed_at, row.age_seconds) : t('turn_state.not_available')}</td>
            <td data-merged-state={state.tone}>
              <span className={styles[state.tone]}>{state.label}</span>
              {state.detail ? <small className={styles.detail}>{state.detail}</small> : null}
            </td>
            <td className={styles.count}>{safeCount(row.request_count)}</td>
            {historical && <td className={styles.count}>{mismatchRate ?? t('turn_state.not_available')}</td>}
            {historical && <td className={styles.count}>{degradedRate ?? t('turn_state.not_available')}</td>}
            <td><span className={styles[currentStateTone]}>{session?.active?.usable
              ? t('turn_state.merged_state_ready', { shape: formatStateShape(session.active.blocks, t, session.active.length) })
              : t('turn_state.state_unavailable')}</span></td>
            {!historical && <td className={styles.count}>{remainingMinutes(session) === null ? t('turn_state.not_available') : t('turn_state.merged_minutes_left', { count: remainingMinutes(session) })}</td>}
            {!historical && <td className={styles.count}>{nextProbeCountdown(session) ?? t('turn_state.not_available')}</td>}
            <td className={styles.count}>
              {session
                ? <span className={injectedCount > 0 ? styles.success : styles.neutral}>{safeCount(injectedCount)}</span>
                : '—'}
              <small className={styles.detail}>{t('turn_state.merged_cumulative')}</small>
            </td>
            <td className={styles.collectionCell}>
              <strong>{passiveObserved ? safeCount(passiveObserved) : '—'}</strong>
              {/* 拆分缺失（旧 proxy）时只给总数，绝不编造成功/未通过。 */}
              {passiveObserved > 0 && passiveAccepted !== null && passiveFailed !== null
                && <small className={styles.detail}>{t('turn_state.overview_capture_split', { accepted: passiveAccepted, rejected: passiveFailed })}</small>}
            </td>
            <td className={styles.collectionCell}>
              <strong>{activeAttempts ? safeCount(activeAttempts) : '—'}</strong>
              {activeAttempts > 0 && <small className={styles.detail}>{historical ? t('turn_state.overview_capture_split', { accepted: activeAccepted, rejected: activeRejected }) : t('turn_state.merged_cumulative')}</small>}
              {historical && (row.probe_timeouts ?? 0) > 0 && <small className={styles.detail}>{t('turn_state.merged_timeouts', { count: row.probe_timeouts })}</small>}
            </td>
          </tr>;
        })}
      </tbody>
    </table>
  </div>;
}
