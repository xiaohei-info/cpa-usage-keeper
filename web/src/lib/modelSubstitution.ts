// 模型替换观测（Turn-State 页）的响应契约与纯展示辅助函数。
// 后端契约：internal/api/turn_state_model_mismatch.go，schema cpa-usage-keeper.turn-state-model-mismatch.v1。

export const MODEL_SUBSTITUTION_SCHEMA = 'cpa-usage-keeper.turn-state-model-mismatch.v1';

// 时间维度：当前实时值优先，其余为窗口聚合。
// "current" 是默认档：显示实时快照（不请求历史窗口）。
export const MODEL_SUBSTITUTION_RANGES = ['1h', '6h', '24h', '7d', '30d'] as const;
export type ModelSubstitutionRange = (typeof MODEL_SUBSTITUTION_RANGES)[number];
/** 当前档在 UI 上的标识；它对应后端的默认窗口，但展示上强调“实时”。 */
export const MODEL_SUBSTITUTION_CURRENT = 'current' as const;
export type ModelSubstitutionRangeSelection = typeof MODEL_SUBSTITUTION_CURRENT | ModelSubstitutionRange;
export const MODEL_SUBSTITUTION_RANGE_SELECTIONS: readonly ModelSubstitutionRangeSelection[] = [MODEL_SUBSTITUTION_CURRENT, ...MODEL_SUBSTITUTION_RANGES];
export const DEFAULT_MODEL_SUBSTITUTION_RANGE: ModelSubstitutionRange = '24h';
/** “当前”档向服务端请求的窗口：实时表不看历史趋势，用最小窗口就够。 */
export const MODEL_SUBSTITUTION_CURRENT_RANGE: ModelSubstitutionRange = '1h';

/** 历史档才显示窗口聚合列；瞬时列（有效期/下次采集）只在当前档有意义。 */
export const isHistoricalRange = (selection: ModelSubstitutionRangeSelection): boolean =>
  selection !== MODEL_SUBSTITUTION_CURRENT;

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

/**
 * 合并总表的一行：账号 x 模型。
 * age_seconds 由服务端相对其 now 计算并夹紧到 >=0，前端不再自行推断时钟差异。
 * observed=false 表示该组在窗口内有业务数据但从未观测到上游模型（不能编造一个时刻）。
 */
export interface ModelSubstitutionCurrentRow {
  requested_model: string;
  upstream_model: string;
  matched: boolean;
  observed_at: string;
  observed: boolean;
  age_seconds: number;
  /** null 表示上游未上报 state_check，绝不能当成正常。 */
  state_check: string | null;
  state_check_reason: string | null;
  /** 仅在块数不符时上报；null 表示未上报，与真实 0 不同。 */
  state_check_observed_blocks: number | null;
  state_check_expected_blocks: number | null;
  account_entry_id: string | null;
  /** 账号显示名（别名 -> 邮箱）；null 表示未登记，前端回退到 id 前 8 位。 */
  account_name: string | null;
  /** 业务窗口聚合：请求数、替换数与替换率（无带模型信息的样本时 null，不是 0%）。 */
  request_count: number;
  mismatched: number;
  mismatch_rate: number | null;
  /** 被动采集：已上报 state_check 的样本数、失败数与降智率。 */
  state_check_observed: number;
  state_check_failed: number;
  state_check_failure_rate: number | null;
  /** 主动探测执行统计（独立 api_group_key），与业务数据严格隔离。 */
  probe_attempts: number;
  probe_accepted: number;
  probe_rejected: number;
  probe_timeouts: number;
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
  current: ModelSubstitutionCurrentRow[];
  truncated: boolean;
}

/** 服务端返回 null 或缺失时保持 null；空串判定码等价于“未上报”。 */
const nullableText = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

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
    // 合并表行：旧的按模型分组载荷没有 observed 与这些聚合计数字段，全部按中性缺省降级。
    current: (Array.isArray(value.current) ? value.current : []).filter(isRecord).map((row) => ({
      requested_model: safeText(row.requested_model),
      upstream_model: safeText(row.upstream_model),
      matched: row.matched === true,
      observed_at: safeText(row.observed_at),
      // 旧后端不带 observed：有非空 observed_at 就当作已观测，否则视为未观测。
      observed: typeof row.observed === 'boolean' ? row.observed : safeText(row.observed_at) !== '',
      age_seconds: safeCount(row.age_seconds),
      state_check: nullableText(row.state_check),
      state_check_reason: nullableText(row.state_check_reason),
      state_check_observed_blocks: finiteNumberOrNull(row.state_check_observed_blocks),
      state_check_expected_blocks: finiteNumberOrNull(row.state_check_expected_blocks),
      account_entry_id: nullableText(row.account_entry_id),
      account_name: nullableText(row.account_name),
      request_count: safeCount(row.request_count),
      mismatched: safeCount(row.mismatched),
      mismatch_rate: finiteNumberOrNull(row.mismatch_rate),
      state_check_observed: safeCount(row.state_check_observed),
      state_check_failed: safeCount(row.state_check_failed),
      state_check_failure_rate: finiteNumberOrNull(row.state_check_failure_rate),
      probe_attempts: safeCount(row.probe_attempts),
      probe_accepted: safeCount(row.probe_accepted),
      probe_rejected: safeCount(row.probe_rejected),
      probe_timeouts: safeCount(row.probe_timeouts),
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

/** 相对时间粒度：先最大的单位，让“3 分钟前”比“180 秒前”更好读。 */
export type RelativeTimeUnit = 'second' | 'minute' | 'hour' | 'day';

export interface RelativeTimeAmount {
  unit: RelativeTimeUnit;
  value: number;
}

/**
 * 把服务端给的 age_seconds 折算成展示用的最大单位。
 * 传入 null（旧后端或缺失字段）时返回 null，由调用方回退到精确时间，不编造“刚刚”。
 */
export function toRelativeTimeAmount(ageSeconds: number | null | undefined): RelativeTimeAmount | null {
  if (ageSeconds === null || ageSeconds === undefined || !Number.isFinite(ageSeconds)) return null;
  const seconds = Math.max(0, Math.floor(ageSeconds));
  if (seconds < 60) return { unit: 'second', value: seconds };
  if (seconds < 3600) return { unit: 'minute', value: Math.floor(seconds / 60) };
  if (seconds < 86_400) return { unit: 'hour', value: Math.floor(seconds / 3600) };
  return { unit: 'day', value: Math.floor(seconds / 86_400) };
}

/** 合并总表可排序的列；未在列表中的列不参与排序。 */
export type ModelSubstitutionSortKey = 'requests' | 'mismatch_rate' | 'state_check_failure_rate' | 'probe_attempts';
export type ModelSubstitutionSortDirection = 'asc' | 'desc';

export interface ModelSubstitutionSort {
  key: ModelSubstitutionSortKey;
  direction: ModelSubstitutionSortDirection;
}

/** 默认按替换率降序：最严重的账号 x 模型排在最上面。 */
export const DEFAULT_MODEL_SUBSTITUTION_SORT: ModelSubstitutionSort = { key: 'mismatch_rate', direction: 'desc' };

/** 账号显示名：优先服务端解析的名字，否则用 id 前 8 位，最后给一个中性占位。 */
export function accountDisplayName(row: Pick<ModelSubstitutionCurrentRow, 'account_name' | 'account_entry_id'>): string {
  const name = (row.account_name ?? '').trim();
  if (name) return name;
  const id = (row.account_entry_id ?? '').trim();
  return id ? id.slice(0, 8) : '';
}

/**
 * 按选定列排序行；null 百分比永远排在有样本的行之后（升序时相反），
 * 因为“无样本”不是 0%，不应该混进“最健康”那一端。
 */
export function sortModelSubstitutionRows(
  rows: ModelSubstitutionCurrentRow[],
  sort: ModelSubstitutionSort,
): ModelSubstitutionCurrentRow[] {
  const value = (row: ModelSubstitutionCurrentRow): number | null => {
    switch (sort.key) {
      case 'requests': return row.request_count;
      case 'mismatch_rate': return row.mismatch_rate;
      case 'state_check_failure_rate': return row.state_check_failure_rate;
      case 'probe_attempts': return row.probe_attempts;
    }
  };
  const direction = sort.direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = value(a);
    const right = value(b);
    if (left === null && right === null) return 0;
    // 无样本行永远排在末尾：升序/降序都不改变这个相对位置。
    if (left === null) return 1;
    if (right === null) return -1;
    if (left !== right) return (left - right) * direction;
    // 同值时按账号+模型稳定排序，避免每次重渲染行序抖动。
    return `${accountDisplayName(a)}${a.requested_model}`.localeCompare(`${accountDisplayName(b)}${b.requested_model}`);
  });
}
