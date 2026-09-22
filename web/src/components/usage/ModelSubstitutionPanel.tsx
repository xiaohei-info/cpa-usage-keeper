import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChartData, ChartOptions } from 'chart.js';
import { Chart } from 'react-chartjs-2';
import '@/lib/chartjs';
import { ApiError, fetchModelSubstitution } from '@/lib/api';
import {
  MODEL_SUBSTITUTION_CURRENT,
  MODEL_SUBSTITUTION_CURRENT_RANGE,
  MODEL_SUBSTITUTION_RANGES,
  MODEL_SUBSTITUTION_LOW_BUCKET_SAMPLE,
  buildModelSubstitutionChartSeries,
  buildModelSubstitutionMatrix,
  toRelativeTimeAmount,
  type ModelSubstitutionChartSeries,
  type ModelSubstitutionCurrentRow,
  type ModelSubstitutionRange,
  type ModelSubstitutionRangeSelection,
  type ModelSubstitutionResponse,
} from '@/lib/modelSubstitution';
import { Card } from '@/components/ui/Card';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { useThemeStore } from '@/stores';
import { upstreamModelMatchTone, type UpstreamMatchTone } from '@/utils/usage/health';
import { formatStateCheckDetail, resolveStateCheckPresentation } from '@/utils/usage/stateCheck';
import { buildUsageChartTooltipStyle, getUsageChartTheme } from '@/utils/usage/chartConfig';
import styles from './ModelSubstitutionPanel.module.scss';

/** 最近观测的自动刷新间隔；仅在页面可见时轮询，隐藏和卸载都会中止。 */
const MODEL_SUBSTITUTION_POLL_MS = 30_000;

// 图表两条曲线固定用可区分的色相，不与健康分段的绿/橙/红复用。
const MATCH_SERIES_COLOR = '#2563eb';
const STATE_CHECK_SERIES_COLOR = '#b45309';
const VOLUME_BAR_COLOR = 'rgba(148, 163, 184, 0.38)';
const RANGE_LABEL_KEYS: Record<ModelSubstitutionRange, string> = {
  '1h': 'turn_state.model_sub_range_1h',
  '6h': 'turn_state.model_sub_range_6h',
  '24h': 'turn_state.model_sub_range_24h',
  '7d': 'turn_state.model_sub_range_7d',
  '30d': 'turn_state.model_sub_range_30d',
};

const toneClassNames: Record<UpstreamMatchTone, string> = {
  success: styles.toneSuccess,
  warning: styles.toneWarning,
  danger: styles.toneDanger,
  neutral: styles.toneNeutral,
};

const percentText = (value: number | null): string => (value === null ? '' : `${value.toFixed(1)}%`);

// 结果色调：一致绿、被替换红、未观测中性；未观测绝不能被渲染成一致。
const currentResultTone = (row: ModelSubstitutionCurrentRow): UpstreamMatchTone => {
  if (!row.requested_model || !row.upstream_model) return 'neutral';
  return row.matched ? 'success' : 'danger';
};

const currentResultLabelKey = (row: ModelSubstitutionCurrentRow): string => {
  if (!row.requested_model || !row.upstream_model) return 'turn_state.model_sub_current_unobserved';
  return row.matched ? 'turn_state.model_sub_current_match' : 'turn_state.model_sub_current_replaced';
};

const BUCKET_START_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;

/**
 * 桶标签按桶宽切换精度，避免 1h 视图里出现 24 个重复的小时。
 * 直接读 ISO 文本里的墙钟时间：分桶发生在 Keeper 存储时区，用浏览器本地时区渲染
 * 会让标签相对 x 轴偏移一段时差。
 */
export function formatModelSubstitutionBucket(bucketStart: string, bucketSeconds: number): string {
  const matched = BUCKET_START_PATTERN.exec(bucketStart);
  if (!matched) {
    const date = new Date(bucketStart);
    return Number.isNaN(date.getTime()) ? bucketStart : bucketStart.slice(0, 16);
  }
  const [, , month, day, hours, minutes] = matched;
  if (bucketSeconds >= 24 * 3600) return `${month}-${day}`;
  // 小时桶直接用文本里的分钟，半时区（如 +05:30）下桶边界不会落在 :00。
  if (bucketSeconds >= 3600) return `${month}-${day} ${hours}:${minutes}`;
  return `${hours}:${minutes}`;
}

type ModelSubstitutionChartData = ChartData<'bar' | 'line', Array<number | null>, string>;

export function buildModelSubstitutionChartData(
  series: ModelSubstitutionChartSeries[],
  bucketSeconds: number,
  t: (key: string) => string,
): ModelSubstitutionChartData {
  return {
    labels: series.map((point) => formatModelSubstitutionBucket(point.bucketStart, bucketSeconds)),
    datasets: [
      {
        type: 'bar',
        label: t('turn_state.model_sub_series_volume'),
        data: series.map((point) => point.requestsWithModel),
        backgroundColor: VOLUME_BAR_COLOR,
        borderWidth: 0,
        borderRadius: 2,
        yAxisID: 'volume',
        order: 3,
      },
      {
        type: 'line',
        label: t('turn_state.model_sub_series_match'),
        data: series.map((point) => point.matchRate),
        borderColor: MATCH_SERIES_COLOR,
        backgroundColor: MATCH_SERIES_COLOR,
        yAxisID: 'rate',
        borderWidth: 2,
        tension: 0.3,
        // 低样本桶单独标注成实心点，提示这个百分比不可信。
        pointRadius: series.map((point) => (point.lowSample ? 4 : 0)),
        pointHoverRadius: 4,
        order: 1,
      },
      {
        type: 'line',
        label: t('turn_state.model_sub_series_state_check'),
        data: series.map((point) => point.stateCheckFailureRate),
        borderColor: STATE_CHECK_SERIES_COLOR,
        backgroundColor: STATE_CHECK_SERIES_COLOR,
        yAxisID: 'rate',
        borderWidth: 2,
        borderDash: [6, 4],
        tension: 0.3,
        pointRadius: series.map((point) => (point.stateCheckLowSample ? 4 : 0)),
        pointHoverRadius: 4,
        spanGaps: false,
        order: 2,
      },
    ],
  };
}

export function buildModelSubstitutionChartOptions(
  series: ModelSubstitutionChartSeries[],
  t: (key: string, options?: Record<string, string | number>) => string,
  isDark: boolean,
  isMobile: boolean,
): ChartOptions<'bar' | 'line'> {
  const theme = getUsageChartTheme(isDark);
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: {
        position: 'bottom',
        labels: { color: theme.textSecondary, usePointStyle: true, boxWidth: 8, boxHeight: 8, padding: 12, font: { size: isMobile ? 10 : 11 } },
      },
      tooltip: {
        ...buildUsageChartTooltipStyle(theme),
        callbacks: {
          label: context => `${context.dataset.label}: ${context.dataset.yAxisID === 'rate' ? (percentText(context.parsed.y) || t('turn_state.not_available')) : context.parsed.y}`,
          // 两条曲线共用桶但各有自己的分母；hover 时必须同时给出各自样本量。
          footer: items => {
            const point = series[items[0]?.dataIndex ?? -1];
            if (!point) return '';
            const lines = [
              t('turn_state.model_sub_tooltip_match_sample', { count: point.requestsWithModel }),
              t('turn_state.model_sub_tooltip_state_sample', { count: point.stateCheckObserved }),
            ];
            if (point.lowSample) lines.push(t('turn_state.model_sub_tooltip_low_sample', { threshold: MODEL_SUBSTITUTION_LOW_BUCKET_SAMPLE }));
            if (point.stateCheckLowSample) lines.push(t('turn_state.model_sub_tooltip_state_low_sample', { threshold: MODEL_SUBSTITUTION_LOW_BUCKET_SAMPLE }));
            return lines;
          },
        },
      },
    },
    scales: {
      x: { grid: { color: theme.grid, drawTicks: false }, border: { color: theme.axis }, ticks: { color: theme.textSecondary, maxTicksLimit: isMobile ? 5 : 12, maxRotation: 0, font: { size: 10 } } },
      // 两条曲线共享 0-100% 轴，保证“降智率”和“一致率”可以直接比较。
      rate: { position: 'left', beginAtZero: true, max: 100, grid: { color: theme.grid }, border: { color: theme.axis }, ticks: { color: theme.textSecondary, maxTicksLimit: 5, callback: value => `${value}%`, font: { size: 10 } } },
      // 请求量柱只在同桶内做视觉提示，不额外占用一条可见数值轴。
      volume: { position: 'right', beginAtZero: true, display: false, grid: { drawOnChartArea: false } },
    },
  };
}

interface ModelSubstitutionPanelProps {
  refreshKey?: number;
  onAuthRequired?: () => void;
  /** 外部共享的拉取控制器；提供时面板不再自己发起请求（同一屏只轮询一次）。 */
  controller?: ModelSubstitutionController;
}

/** 一次拉取、两处展示（合并总表 + 历史趋势），保证同一屏上的数字不会自相矛盾。 */
export interface ModelSubstitutionController {
  /** 用户选择的档位：“当前”或某个历史窗口。 */
  selection: ModelSubstitutionRangeSelection;
  /** 实际生效的历史窗口；选择“当前”时它是后端的最小窗口。 */
  range: ModelSubstitutionRange;
  data: ModelSubstitutionResponse | null;
  loading: boolean;
  failed: boolean;
  selectRange: (selection: ModelSubstitutionRangeSelection) => void;
}

/**
 * 模型替换数据的唯一拉取点：可见时每 30 秒重拉，隐藏即停，卸载时 abort。
 * enabled=false 时不发起任何请求（由调用方复用同一份结果）。
 */
export function useModelSubstitution({ refreshKey = 0, onAuthRequired, enabled = true }: {
  refreshKey?: number;
  onAuthRequired?: () => void;
  enabled?: boolean;
} = {}): ModelSubstitutionController {
  const [selection, setSelection] = useState<ModelSubstitutionRangeSelection>(MODEL_SUBSTITUTION_CURRENT);
  const [data, setData] = useState<ModelSubstitutionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const auth = useRef(onAuthRequired);
  auth.current = onAuthRequired;
  // “当前”档向服务端要最小窗口（实时表不看历史趋势）；历史档直接用用户选的窗口。
  const rangeFor = (next: ModelSubstitutionRangeSelection): ModelSubstitutionRange =>
    next === MODEL_SUBSTITUTION_CURRENT ? MODEL_SUBSTITUTION_CURRENT_RANGE : next;
  const rangeRef = useRef<ModelSubstitutionRange>(rangeFor(selection));
  rangeRef.current = rangeFor(selection);

  const load = useCallback(async (requestedRange: ModelSubstitutionRange) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    try {
      const response = await fetchModelSubstitution(requestedRange, controller.signal);
      if (controllerRef.current !== controller) return;
      setData(response);
      setFailed(false);
    } catch (error) {
      if (controller.signal.aborted || controllerRef.current !== controller) return;
      setFailed(true);
      if (error instanceof ApiError && error.status === 401) auth.current?.();
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void load(rangeRef.current);
    return () => { controllerRef.current?.abort(); controllerRef.current = null; };
  }, [enabled, load, refreshKey]);

  // 最近观测需要比历史桶更新得快：可见时每 30 秒重拉同一接口，隐藏就停，
  // 卸载时清理定时器。复用 load 的单飞与 abort，不会开第二条请求。
  useEffect(() => {
    if (!enabled) return;
    let timer: number | undefined;
    const stop = () => { if (timer !== undefined) { window.clearInterval(timer); timer = undefined; } };
    const start = () => {
      if (timer !== undefined || document.hidden) return;
      timer = window.setInterval(() => {
        if (document.hidden) { stop(); return; }
        void load(rangeRef.current);
      }, MODEL_SUBSTITUTION_POLL_MS);
    };
    const onVisibility = () => {
      if (document.hidden) {
        stop();
        controllerRef.current?.abort();
      } else {
        void load(rangeRef.current);
        start();
      }
    };
    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [enabled, load]);

  const selectRange = useCallback((next: ModelSubstitutionRangeSelection) => {
    setSelection(next);
    void load(rangeFor(next));
  }, [load]);

  return { selection, range: rangeFor(selection), data, loading, failed, selectRange };
}

/**
 * 历史趋势与矩阵：合并总表给出的“现在怎么样”，这里给出“随时间怎么变”。
 *
 * 时间维度选择器由父级（合并总表卡片）统一持有，两处共享同一个 selection，
 * 因此不在本组件里再渲染一份控制器——重复的控制件会让两处显示不一致。
 */
export function ModelSubstitutionPanel({ refreshKey = 0, onAuthRequired, controller }: ModelSubstitutionPanelProps) {
  const { t } = useTranslation();
  const isDark = useThemeStore((state) => state.resolvedTheme === 'dark');
  const isMobile = useMediaQuery('(max-width: 768px)');
  // 外部传入控制器时内部拉取必须关闭，否则两个 hook 会同时轮询同一接口。
  const internal = useModelSubstitution({ refreshKey, onAuthRequired, enabled: !controller });
  const { data, loading, failed } = controller ?? internal;

  const series = useMemo(() => (data ? buildModelSubstitutionChartSeries(data) : []), [data]);
  const matrix = useMemo(() => (data ? buildModelSubstitutionMatrix(data) : { columns: [], rows: [] }), [data]);
  const chartData = useMemo(() => buildModelSubstitutionChartData(series, data?.bucket_seconds ?? 3600, t), [series, data?.bucket_seconds, t]);
  const chartOptions = useMemo(() => buildModelSubstitutionChartOptions(series, t, isDark, isMobile), [series, t, isDark, isMobile]);
  const lowSampleBuckets = series.filter((point) => point.lowSample).length;
  const stateCheckLowSampleBuckets = series.filter((point) => point.stateCheckLowSample).length;
  const summary = data?.summary;
  const topShare = useMemo(() => {
    const top = summary?.top_substitution;
    if (!top || !data) return null;
    const total = data.substitutions.find((row) => row.requested_model === top.from)?.requests_with_model ?? 0;
    return total > 0 ? (top.count / total) * 100 : null;
  }, [data, summary?.top_substitution]);

  return (
    <section className={styles.panel} aria-label={t('turn_state.model_sub_trend_title')}>
      <Card
        title={t('turn_state.model_sub_trend_title')}
        subtitle={t('turn_state.model_sub_help')}
      >
        <p className={styles.coverage} data-model-subscription-coverage>
          {summary
            ? t('turn_state.model_sub_coverage', { count: summary.requests_with_model })
            : t('common.loading')}
        </p>
        {failed && !data && <p role="status" className={styles.warning}>{t('turn_state.model_sub_unavailable')}</p>}
        {/* 刷新失败时保留上一份数据，但必须说明当前显示的不是所选范围。 */}
        {failed && data && <p role="status" className={styles.warning} data-model-subscription-stale>{t('turn_state.stale')}</p>}
        {/* 最近观测已由合并总表承载，这里不再重复渲染一张“最近观测”表。 */}
        {data && summary && <>
          <div className={styles.summaryGrid}>
            <div className={styles.summaryCard}>
              <span className={styles.summaryLabel}>{t('turn_state.model_sub_summary_requests')}</span>
              <strong>{summary.requests_with_model.toLocaleString()}</strong>
            </div>
            <div className={styles.summaryCard}>
              <span className={styles.summaryLabel}>{t('turn_state.model_sub_summary_mismatched')}</span>
              <strong>{summary.mismatched.toLocaleString()}</strong>
            </div>
            <div className={styles.summaryCard} data-model-subscription-match-rate>
              <span className={styles.summaryLabel}>{t('turn_state.model_sub_summary_match_rate')}</span>
              <strong className={toneClassNames[upstreamModelMatchTone(summary.match_rate)]} data-tone={upstreamModelMatchTone(summary.match_rate)}>
                {summary.match_rate === null ? t('turn_state.not_available') : percentText(summary.match_rate)}
              </strong>
            </div>
            <div className={styles.summaryCard} data-model-subscription-top>
              <span className={styles.summaryLabel}>{t('turn_state.model_sub_summary_top')}</span>
              <strong className={styles.topValue}>
                {summary.top_substitution
                  ? `${summary.top_substitution.from} → ${summary.top_substitution.to}${topShare === null ? '' : ` ${topShare.toFixed(0)}%`}`
                  : t('turn_state.none')}
              </strong>
            </div>
          </div>
          {summary.empty
            ? <p className={styles.empty} data-model-subscription-empty>{t('turn_state.model_sub_empty')}</p>
            : <>
              <div className={styles.chartSurface} data-model-subscription-chart>
                <Chart type="bar" data={chartData} options={chartOptions} role="img" aria-label={t('turn_state.model_sub_chart_aria')} />
                <p className={styles.chartNote}>{t('turn_state.model_sub_chart_note')}</p>
                {lowSampleBuckets > 0 && <p className={styles.chartWarning} data-model-subscription-low-sample>
                  {t('turn_state.model_sub_low_sample', { count: lowSampleBuckets, threshold: MODEL_SUBSTITUTION_LOW_BUCKET_SAMPLE })}
                </p>}
                {stateCheckLowSampleBuckets > 0 && <p className={styles.chartWarning} data-model-subscription-state-low-sample>
                  {t('turn_state.model_sub_state_low_sample', { count: stateCheckLowSampleBuckets, threshold: MODEL_SUBSTITUTION_LOW_BUCKET_SAMPLE })}
                </p>}
              </div>
              {matrix.rows.length > 0 && <div className={styles.matrixSurface} data-model-subscription-matrix>
                <table className={styles.matrix}>
                  <thead>
                    <tr>
                      <th scope="col">{t('turn_state.model_sub_matrix_requested')}</th>
                      {matrix.columns.map((column, index) => <th key={`${column.label || 'aggregated'}-${index}`} scope="col">{column.label || t('turn_state.model_sub_matrix_other')}</th>)}
                      <th scope="col">{t('turn_state.model_sub_matrix_match_rate')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {matrix.rows.map((row) => <tr key={row.requestedModel}>
                      <th scope="row">{row.requestedModel}</th>
                      {row.cells.map((cell) => {
                        const diagonal = cell.matched;
                        const cellClassNames = [
                          styles.matrixCell,
                          cell.count === null ? styles.matrixCellEmpty : '',
                          cell.count !== null && diagonal ? styles.matrixCellDiagonal : '',
                          cell.count !== null && !diagonal ? styles.matrixCellWarning : '',
                        ].filter(Boolean).join(' ');
                        return <td
                          key={`${row.requestedModel}-${cell.columnIndex}`}
                          className={cellClassNames}
                          data-cell-diagonal={diagonal ? 'true' : 'false'}
                          title={cell.count === null ? '' : `${cell.count} · ${(cell.share ?? 0) * 100}%`}
                          // 色深由占样本比例决定，直接算出百分比供 color-mix 使用。
                          style={{
                            '--cell-diagonal': `${Math.min(45, (cell.share ?? 0) * 45)}%`,
                            '--cell-warning': `${Math.min(85, (cell.share ?? 0) * 85)}%`,
                          } as CSSProperties}
                        >
                          {cell.count === null ? '—' : cell.count.toLocaleString()}
                        </td>;
                      })}
                      <td className={`${styles.matrixRate} ${toneClassNames[upstreamModelMatchTone(row.matchRate)]}`} data-tone={upstreamModelMatchTone(row.matchRate)}>
                        {row.matchRate === null ? t('turn_state.not_available') : percentText(row.matchRate)}
                      </td>
                    </tr>)}
                  </tbody>
                </table>
                <p className={styles.chartNote}>{t('turn_state.model_sub_matrix_note')}</p>
                {data.truncated && <p className={styles.chartWarning}>{t('turn_state.model_sub_truncated')}</p>}
              </div>}
            </>}
        </>}
        {loading && !data && <p role="status">{t('common.loading')}</p>}
      </Card>
    </section>
  );
}
