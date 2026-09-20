import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_SUBSTITUTION_RANGE,
  MODEL_SUBSTITUTION_SCHEMA,
  buildModelSubstitutionChartSeries,
  buildModelSubstitutionMatrix,
  normalizeModelSubstitution,
  type ModelSubstitutionResponse,
} from '../modelSubstitution';
import { upstreamModelMatchTone } from '@/utils/usage/health';

const response = (overrides: Partial<ModelSubstitutionResponse> = {}): ModelSubstitutionResponse => ({
  schema: MODEL_SUBSTITUTION_SCHEMA,
  range: '24h',
  window_start: '2026-09-20T13:00:00+08:00',
  window_end: '2026-09-21T13:00:00+08:00',
  bucket_seconds: 3600,
  summary: {
    requests_with_model: 4,
    matched: 1,
    mismatched: 3,
    match_rate: 25,
    empty: false,
    top_substitution: { from: 'gpt-6-astra', to: 'gpt-5.6-luna', count: 3 },
  },
  series: [],
  matrix: [
    { requested_model: 'gpt-6-astra', upstream_model: 'gpt-5.6-luna', count: 3, share: 0.75, matched: false },
    { requested_model: 'gpt-6-astra', upstream_model: 'gpt-6-astra', count: 1, share: 0.25, matched: true },
    { requested_model: 'o5-code', upstream_model: 'o5-mini', count: 2, share: 1, matched: false },
  ],
  substitutions: [
    { requested_model: 'gpt-6-astra', requests_with_model: 4, mismatched: 3, match_rate: 25 },
    { requested_model: 'o5-code', requests_with_model: 2, mismatched: 2, match_rate: 0 },
  ],
  truncated: false,
  ...overrides,
});

describe('normalizeModelSubstitution', () => {
  it('rejects payloads without the expected schema marker', () => {
    expect(normalizeModelSubstitution(null)).toBeNull();
    expect(normalizeModelSubstitution({ schema: 'something-else', series: [], matrix: [], substitutions: [] })).toBeNull();
    // 顶层数组缺失同样拒绝，避免渲染出半截表格。
    expect(normalizeModelSubstitution({ schema: MODEL_SUBSTITUTION_SCHEMA, series: [] })).toBeNull();
  });

  it('tolerates rows without the newer fields instead of throwing', () => {
    const normalized = normalizeModelSubstitution({
      schema: MODEL_SUBSTITUTION_SCHEMA,
      range: '1h',
      bucket_seconds: 60,
      summary: { requests_with_model: 2, matched: 2 },
      series: [{ bucket_start: '2026-09-21T12:00:00+08:00', requests_with_model: 2, mismatched: 0 }],
      matrix: [{ requested_model: 'gpt-6-astra', upstream_model: 'gpt-6-astra', count: 2 }],
      substitutions: [{ requested_model: 'gpt-6-astra', requests_with_model: 2 }],
    });
    expect(normalized).not.toBeNull();
    // 缺失字段补 0/null，rather than undefined 泄漏到图表。
    expect(normalized!.series[0].match_rate).toBeNull();
    expect(normalized!.series[0].state_check_observed).toBe(0);
    expect(normalized!.series[0].state_check_failure_rate).toBeNull();
    expect(normalized!.matrix[0].share).toBe(0);
    expect(normalized!.matrix[0].matched).toBe(false);
    expect(normalized!.summary.empty).toBe(false);
    expect(normalized!.summary.top_substitution).toBeNull();
  });

  it('marks the payload empty when there is no request with model info', () => {
    const normalized = normalizeModelSubstitution({
      schema: MODEL_SUBSTITUTION_SCHEMA,
      range: '24h',
      summary: { requests_with_model: 0, matched: 0, mismatched: 0 },
      series: [],
      matrix: [],
      substitutions: [],
    });
    expect(normalized!.summary.empty).toBe(true);
    expect(normalized!.summary.match_rate).toBeNull();
  });

  it('ignores negative counts instead of rendering them', () => {
    const normalized = normalizeModelSubstitution({
      schema: MODEL_SUBSTITUTION_SCHEMA,
      summary: { requests_with_model: -4, matched: 3, mismatched: -1 },
      series: [],
      matrix: [],
      substitutions: [],
    });
    expect(normalized!.summary.requests_with_model).toBe(0);
    expect(normalized!.summary.mismatched).toBe(0);
    // 归一化后没有样本 -> 显式 empty，绝不当成“全部一致”。
    expect(normalized!.summary.empty).toBe(true);
  });
});

describe('buildModelSubstitutionMatrix', () => {
  it('puts the requested model on rows and the upstream model on columns with a per-model match rate', () => {
    const matrix = buildModelSubstitutionMatrix(response());
    // 列按上游模型样本量降序；行按请求模型样本量降序。
    expect(matrix.columns.map((column) => column.label)).toEqual(['gpt-5.6-luna', 'o5-mini', 'gpt-6-astra']);
    expect(matrix.rows.map((row) => row.requestedModel)).toEqual(['gpt-6-astra', 'o5-code']);
    expect(matrix.rows[0].matchRate).toBe(25);
    expect(matrix.rows[1].matchRate).toBe(0);
    // 每个格子都带列下标，方便判断对角线（requested == upstream）。
    const diagonal = matrix.rows[0].cells.find((cell) => cell.matched);
    expect(diagonal?.columnIndex).toBe(2);
    expect(diagonal?.count).toBe(1);
    const substitution = matrix.rows[0].cells.find((cell) => !cell.matched && cell.count !== null);
    expect(substitution?.count).toBe(3);
    // 没有样本的格子保持 null，不用 0 冒充“没有替换”。
    expect(matrix.rows[0].cells[1].count).toBeNull();
    expect(matrix.rows[1].cells[2].count).toBeNull();
  });

  it('aggregates upstream models beyond the column limit and never marks the aggregate as matched', () => {
    const matrix = buildModelSubstitutionMatrix(response({
      matrix: [
        { requested_model: 'gpt-6-astra', upstream_model: 'gpt-6-astra', count: 1, share: 0.2, matched: true },
        { requested_model: 'gpt-6-astra', upstream_model: 'upstream-a', count: 1, share: 0.2, matched: false },
        { requested_model: 'gpt-6-astra', upstream_model: 'upstream-b', count: 1, share: 0.2, matched: false },
        { requested_model: 'gpt-6-astra', upstream_model: 'upstream-c', count: 2, share: 0.4, matched: false },
      ],
      substitutions: [{ requested_model: 'gpt-6-astra', requests_with_model: 5, mismatched: 4, match_rate: 20 }],
    }), 2);
    expect(matrix.columns).toHaveLength(3);
    expect(matrix.columns.map((column) => column.label)).toEqual(['upstream-c', 'gpt-6-astra', '']);
    expect(matrix.columns.at(-1)?.aggregated).toBe(true);
    expect(matrix.columns.at(-1)?.upstreamModels).toEqual(['upstream-a', 'upstream-b']);
    // 合并列汇总了多个替换上游，永远不能算成一致。
    const aggregated = matrix.rows[0].cells.at(-1);
    expect(aggregated?.count).toBe(2);
    expect(aggregated?.matched).toBe(false);
    // 可见的单列仍然保留真实的一致判定。
    expect(matrix.rows[0].cells[1].matched).toBe(true);
  });

  it('still lists a requested model that has matrix cells but no summary row', () => {
    const matrix = buildModelSubstitutionMatrix(response({ substitutions: [] }));
    expect(matrix.rows.map((row) => row.requestedModel)).toEqual(['gpt-6-astra', 'o5-code']);
    expect(matrix.rows[0].matchRate).toBeNull();
  });
});

describe('buildModelSubstitutionChartSeries', () => {
  it('keeps both rates on the same buckets and flags low-sample buckets', () => {
    const series = buildModelSubstitutionChartSeries(response({
      series: [
        { bucket_start: '2026-09-21T11:00:00+08:00', requests_with_model: 40, mismatched: 12, match_rate: 70, state_check_observed: 10, state_check_failed: 4, state_check_failure_rate: 40 },
        { bucket_start: '2026-09-21T12:00:00+08:00', requests_with_model: 2, mismatched: 0, match_rate: 100, state_check_observed: 0, state_check_failed: 0, state_check_failure_rate: null },
      ],
    }));
    expect(series).toHaveLength(2);
    expect(series[0].lowSample).toBe(false);
    // 小样本桶必须被标注，而不是把 100% 当成可信结论。
    expect(series[1].lowSample).toBe(true);
    expect(series[1].stateCheckFailureRate).toBeNull();
    expect(series[1].matchRate).toBe(100);
  });
});

describe('upstream model match tone bands', () => {
  it('uses 90/89/60/59 as the band boundaries and keeps no-sample neutral', () => {
    expect(upstreamModelMatchTone(100)).toBe('success');
    expect(upstreamModelMatchTone(90)).toBe('success');
    expect(upstreamModelMatchTone(89)).toBe('warning');
    expect(upstreamModelMatchTone(60)).toBe('warning');
    expect(upstreamModelMatchTone(59)).toBe('danger');
    expect(upstreamModelMatchTone(0)).toBe('danger');
    expect(upstreamModelMatchTone(null)).toBe('neutral');
    expect(upstreamModelMatchTone(Number.NaN)).toBe('neutral');
  });
});

describe('default range', () => {
  it('defaults to the operator-approved 24h window', () => {
    expect(DEFAULT_MODEL_SUBSTITUTION_RANGE).toBe('24h');
  });
});
