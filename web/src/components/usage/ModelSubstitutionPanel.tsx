import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChartData, ChartOptions } from 'chart.js';
import { Chart } from 'react-chartjs-2';
import '@/lib/chartjs';
import { ApiError, fetchModelSubstitution } from '@/lib/api';
import {
  DEFAULT_MODEL_SUBSTITUTION_RANGE,
  MODEL_SUBSTITUTION_RANGES,
  MODEL_SUBSTITUTION_LOW_BUCKET_SAMPLE,
  buildModelSubstitutionChartSeries,
  buildModelSubstitutionMatrix,
  type ModelSubstitutionChartSeries,
  type ModelSubstitutionRange,
  type ModelSubstitutionResponse,
} from '@/lib/modelSubstitution';
import { Card } from '@/components/ui/Card';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { useThemeStore } from '@/stores';
import { upstreamModelMatchTone, type UpstreamMatchTone } from '@/utils/usage/health';
import { buildUsageChartTooltipStyle, getUsageChartTheme } from '@/utils/usage/chartConfig';
import styles from './ModelSubstitutionPanel.module.scss';

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
}

/**
 * 模型替换观测：请求模型 vs 上游模型的时间趋势与矩阵。
 * 数据来自 usage_events 历史（upstream_model 为新字段，历史行为空），因此始终显示覆盖样本量。
 */
export function ModelSubstitutionPanel({ refreshKey = 0, onAuthRequired }: ModelSubstitutionPanelProps) {
  const { t } = useTranslation();
  const isDark = useThemeStore((state) => state.resolvedTheme === 'dark');
  const isMobile = useMediaQuery('(max-width: 768px)');
  const [range, setRange] = useState<ModelSubstitutionRange>(DEFAULT_MODEL_SUBSTITUTION_RANGE);
  const [data, setData] = useState<ModelSubstitutionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const auth = useRef(onAuthRequired);
  auth.current = onAuthRequired;
  const rangeRef = useRef(range);
  rangeRef.current = range;

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
    void load(rangeRef.current);
    return () => { controllerRef.current?.abort(); controllerRef.current = null; };
  }, [load, refreshKey]);

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
    <section className={styles.panel} aria-label={t('turn_state.model_sub_title')}>
      <Card
        title={t('turn_state.model_sub_title')}
        subtitle={t('turn_state.model_sub_help')}
        extra={<div className={styles.rangeGroup} role="group" aria-label={t('turn_state.model_sub_range_label')}>
          {MODEL_SUBSTITUTION_RANGES.map((value) => (
            <button
              key={value}
              type="button"
              className={`${styles.rangeButton} ${value === (data?.range ?? range) ? styles.rangeButtonActive : ''}`.trim()}
              aria-pressed={value === (data?.range ?? range)}
              onClick={() => { setRange(value); void load(value); }}
            >
              {t(RANGE_LABEL_KEYS[value])}
            </button>
          ))}
        </div>}
      >
        <p className={styles.coverage} data-model-subscription-coverage>
          {summary
            ? t('turn_state.model_sub_coverage', { count: summary.requests_with_model })
            : t('common.loading')}
        </p>
        {failed && !data && <p role="status" className={styles.warning}>{t('turn_state.model_sub_unavailable')}</p>}
        {/* 刷新失败时保留上一份数据，但必须说明当前显示的不是所选范围。 */}
        {failed && data && <p role="status" className={styles.warning} data-model-subscription-stale>{t('turn_state.stale')}</p>}
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
