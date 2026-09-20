// 模型替换观测（Turn-State 页）的响应契约与纯展示辅助函数。
// 后端契约：internal/api/turn_state_model_mismatch.go，schema cpa-usage-keeper.turn-state-model-mismatch.v1。

export const MODEL_SUBSTITUTION_SCHEMA = 'cpa-usage-keeper.turn-state-model-mismatch.v1';

export const MODEL_SUBSTITUTION_RANGES = ['1h', '6h', '24h', '7d', '30d'] as const;
export type ModelSubstitutionRange = (typeof MODEL_SUBSTITUTION_RANGES)[number];
export const DEFAULT_MODEL_SUBSTITUTION_RANGE: ModelSubstitutionRange = '24h';

/** 桶样本低于该值时百分比不可信，图表上单独标注而不是当成确定结论。 */
export const MODEL_SUBSTITUTION_LOW_BUCKET_SAMPLE = 5;
/** 矩阵上游模型列上限；超出的列合并为“其他”，保证表格宽度有界。 */
export const MODEL_SUBSTITUTION_MATRIX_COLUMN_LIMIT = 12;

export interface ModelSubstitutionTopPair {
  from: string;
  to: string;
  count: number;
}

export interface ModelSubstitutionSummary {
  requests_with_model: number;
  matched: number;
  mismatched: number;
  /** 0-100 百分比；没有可用样本时为 null，不是 0%。 */
  match_rate: number | null;
  /** 窗口内没有任何带上游模型信息的请求。 */
  empty: boolean;
  top_substitution: ModelSubstitutionTopPair | null;
}

export interface ModelSubstitutionPoint {
  bucket_start: string;
  requests_with_model: number;
  mismatched: number;
  match_rate: number | null;
  state_check_observed: number;
  state_check_failed: number;
  state_check_failure_rate: number | null;
}

export interface ModelSubstitutionMatrixRow {
  requested_model: string;
  upstream_model: string;
  count: number;
  share: number;
  matched: boolean;
}

export interface ModelSubstitutionRequestedRow {
  requested_model: string;
  requests_with_model: number;
  mismatched: number;
  match_rate: number | null;
}

export interface ModelSubstitutionResponse {
  schema: string;
  range: string;
  window_start: string;
  window_end: string;
  bucket_seconds: number;
  summary: ModelSubstitutionSummary;
  series: ModelSubstitutionPoint[];
  matrix: ModelSubstitutionMatrixRow[];
  substitutions: ModelSubstitutionRequestedRow[];
  truncated: boolean;
}

// 显式 null / undefined / 空串表示“没有样本”，必须保持 null；Number(null) 会变成 0，
// 把没有样本桶伪装成 0% 的失败率。
const finiteNumberOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const safeCount = (value: unknown): number => {
  const parsed = finiteNumberOrNull(value);
  return parsed === null || parsed < 0 ? 0 : Math.floor(parsed);
};

const safeText = (value: unknown): string => (typeof value === 'string' ? value : '');

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

/**
 * 容错归一化：下游只保证 schema 与顶层数组存在，缺字段的行降级为 0/null 而不是抛错，
 * 这样旧后端或字段缺失的行都不会让整页崩溃。
 */
export function normalizeModelSubstitution(value: unknown): ModelSubstitutionResponse | null {
  if (!isRecord(value) || value.schema !== MODEL_SUBSTITUTION_SCHEMA) return null;
  if (!Array.isArray(value.series) || !Array.isArray(value.matrix) || !Array.isArray(value.substitutions)) return null;
  const summary = isRecord(value.summary) ? value.summary : {};
  const top = isRecord(summary.top_substitution) ? summary.top_substitution : null;

  return {
    schema: MODEL_SUBSTITUTION_SCHEMA,
    range: safeText(value.range),
    window_start: safeText(value.window_start),
    window_end: safeText(value.window_end),
    bucket_seconds: safeCount(value.bucket_seconds),
    summary: {
      requests_with_model: safeCount(summary.requests_with_model),
      matched: safeCount(summary.matched),
      mismatched: safeCount(summary.mismatched),
      match_rate: finiteNumberOrNull(summary.match_rate),
      empty: summary.empty === true || safeCount(summary.requests_with_model) === 0,
      top_substitution: top
        ? { from: safeText(top.from), to: safeText(top.to), count: safeCount(top.count) }
        : null,
    },
    series: value.series.filter(isRecord).map((point) => ({
      bucket_start: safeText(point.bucket_start),
      requests_with_model: safeCount(point.requests_with_model),
      mismatched: safeCount(point.mismatched),
      match_rate: finiteNumberOrNull(point.match_rate),
      state_check_observed: safeCount(point.state_check_observed),
      state_check_failed: safeCount(point.state_check_failed),
      state_check_failure_rate: finiteNumberOrNull(point.state_check_failure_rate),
    })),
    matrix: value.matrix.filter(isRecord).map((row) => ({
      requested_model: safeText(row.requested_model),
      upstream_model: safeText(row.upstream_model),
      count: safeCount(row.count),
      share: finiteNumberOrNull(row.share) ?? 0,
      matched: row.matched === true,
    })),
    substitutions: value.substitutions.filter(isRecord).map((row) => ({
      requested_model: safeText(row.requested_model),
      requests_with_model: safeCount(row.requests_with_model),
      mismatched: safeCount(row.mismatched),
      match_rate: finiteNumberOrNull(row.match_rate),
    })),
    truncated: value.truncated === true,
  };
}

export interface ModelSubstitutionMatrixColumn {
  /** 本地化前的模型名；聚合列用 upstreamModels 表达而不是伪造模型名。 */
  label: string;
  /** 该列实际包含的上游模型；合并列始终为空数组。 */
  upstreamModels: string[];
  aggregated: boolean;
}

export interface ModelSubstitutionMatrixCell {
  /** count 为 null 表示该组合没有样本，用中划线而不是 0 掩盖缺失。 */
  count: number | null;
  share: number | null;
  /** 只有真实的单列单元格才可能为 true；合并列永不算一致。 */
  matched: boolean;
  columnIndex: number;
}

export interface ModelSubstitutionMatrixTableRow {
  requestedModel: string;
  cells: ModelSubstitutionMatrixCell[];
  matchRate: number | null;
  requestsWithModel: number;
  mismatched: number;
}

export interface ModelSubstitutionMatrix {
  columns: ModelSubstitutionMatrixColumn[];
  rows: ModelSubstitutionMatrixTableRow[];
}

/**
 * 构建热力表：行是请求模型（按样本量排序），列按上游模型样本量排序，超过列上限后
 * 把剩余上游模型合并到“其他”列，保证每行总和与一致率列仍与 summary 对得上。
 */
export function buildModelSubstitutionMatrix(
  response: ModelSubstitutionResponse,
  columnLimit = MODEL_SUBSTITUTION_MATRIX_COLUMN_LIMIT,
): ModelSubstitutionMatrix {
  const upstreamTotals = new Map<string, number>()
  for (const cell of response.matrix) {
    if (!cell.upstream_model) continue
    upstreamTotals.set(cell.upstream_model, (upstreamTotals.get(cell.upstream_model) ?? 0) + cell.count)
  }
  const rankedUpstreams = [...upstreamTotals.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .map(([model]) => model)
  const visibleUpstreams = rankedUpstreams.slice(0, Math.max(1, columnLimit))
  const visible = new Set(visibleUpstreams)
  const hiddenUpstreams = rankedUpstreams.slice(visibleUpstreams.length)

  const columns: ModelSubstitutionMatrixColumn[] = visibleUpstreams.map((model) => ({
    label: model,
    upstreamModels: [model],
    aggregated: false,
  }))
  if (hiddenUpstreams.length > 0) {
    columns.push({ label: '', upstreamModels: hiddenUpstreams, aggregated: true })
  }

  const columnIndexByUpstream = new Map<string, number>()
  visibleUpstreams.forEach((model, index) => columnIndexByUpstream.set(model, index))
  const hiddenColumnIndex = hiddenUpstreams.length > 0 ? columns.length - 1 : -1

  const totalsByRequested = new Map<string, { total: number; mismatched: number; matchRate: number | null }>()
  for (const row of response.substitutions) {
    totalsByRequested.set(row.requested_model, {
      total: row.requests_with_model,
      mismatched: row.mismatched,
      matchRate: row.match_rate,
    })
  }
  // substitutions 是后端按样本量排序的行清单；矩阵中出现的请求模型也必须在表里。
  const requestedModels = response.substitutions.map((row) => row.requested_model)
  for (const cell of response.matrix) {
    if (cell.requested_model && !totalsByRequested.has(cell.requested_model)) {
      totalsByRequested.set(cell.requested_model, { total: 0, mismatched: 0, matchRate: null })
      requestedModels.push(cell.requested_model)
    }
  }

  const rows: ModelSubstitutionMatrixTableRow[] = requestedModels.map((requestedModel) => {
    const cells: ModelSubstitutionMatrixCell[] = columns.map((_column, columnIndex) => ({
      columnIndex,
      count: null,
      share: null,
      matched: false,
    }))
    for (const cell of response.matrix) {
      if (cell.requested_model !== requestedModel) continue
      const columnIndex = visible.has(cell.upstream_model)
        ? columnIndexByUpstream.get(cell.upstream_model)!
        : hiddenColumnIndex
      if (columnIndex < 0) continue
      const target = cells[columnIndex]
      target.count = (target.count ?? 0) + cell.count
      target.share = (target.share ?? 0) + cell.share
      // 合并列汇总了多个上游模型，永远不能算成一致，避免把替换藏进对角列。
      if (columnIndex !== hiddenColumnIndex) {
        target.matched = cell.matched
      }
    }
    const totals = totalsByRequested.get(requestedModel) ?? { total: 0, mismatched: 0, matchRate: null }
    return { requestedModel, cells, matchRate: totals.matchRate, requestsWithModel: totals.total, mismatched: totals.mismatched }
  })

  return { columns, rows }
}

export interface ModelSubstitutionChartSeries {
  bucketStart: string;
  requestsWithModel: number;
  matchRate: number | null;
  stateCheckObserved: number;
  stateCheckFailureRate: number | null;
  /** 桶样本过低：图表上单独标注，提示该点不可信。 */
  lowSample: boolean;
  /** 状态检查曲线自己的低样本标记（分母是 state_check_observed，与一致率不同）。 */
  stateCheckLowSample: boolean;
}

export function buildModelSubstitutionChartSeries(response: ModelSubstitutionResponse): ModelSubstitutionChartSeries[] {
  return response.series.map((point) => ({
    bucketStart: point.bucket_start,
    requestsWithModel: point.requests_with_model,
    matchRate: point.match_rate,
    stateCheckObserved: point.state_check_observed,
    stateCheckFailureRate: point.state_check_failure_rate,
    lowSample: point.requests_with_model > 0 && point.requests_with_model < MODEL_SUBSTITUTION_LOW_BUCKET_SAMPLE,
    // 状态检查曲线各有自己的分母，不能用一致率的样本量判断它是否可信。
    stateCheckLowSample:
      point.state_check_observed > 0 && point.state_check_observed < MODEL_SUBSTITUTION_LOW_BUCKET_SAMPLE,
  }))
}
