// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChartData, ChartOptions } from 'chart.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import { MODEL_SUBSTITUTION_SCHEMA, normalizeModelSubstitution, type ModelSubstitutionResponse } from '@/lib/modelSubstitution';
import { ModelSubstitutionPanel, buildModelSubstitutionChartData, buildModelSubstitutionChartOptions, formatModelSubstitutionBucket } from '../ModelSubstitutionPanel';

const fetchModelSubstitution = vi.fn();
type ChartKind = 'bar' | 'line';
let latestChartData: ChartData<ChartKind, Array<number | null>, string> | null = null;
let latestChartOptions: ChartOptions<ChartKind> | null = null;

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, fetchModelSubstitution: (...args: unknown[]) => fetchModelSubstitution(...args) };
});

vi.mock('react-chartjs-2', () => ({
  Chart: (props: { data: ChartData<ChartKind, Array<number | null>, string>; options: ChartOptions<ChartKind> }) => {
    latestChartData = props.data;
    latestChartOptions = props.options;
    return null;
  },
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string, params?: Record<string, unknown>) => params ? `${key}:${JSON.stringify(params)}` : key }),
}));

const response = (overrides: Partial<ModelSubstitutionResponse> = {}): ModelSubstitutionResponse => ({
  schema: MODEL_SUBSTITUTION_SCHEMA,
  range: '24h',
  window_start: '2026-09-20T13:00:00+08:00',
  window_end: '2026-09-21T13:00:00+08:00',
  bucket_seconds: 3600,
  summary: {
    requests_with_model: 183,
    matched: 64,
    mismatched: 119,
    match_rate: 34.97,
    empty: false,
    top_substitution: { from: 'gpt-6-astra', to: 'gpt-5.6-luna', count: 119 },
  },
  series: [
    { bucket_start: '2026-09-21T11:00:00+08:00', requests_with_model: 180, mismatched: 117, match_rate: 35, state_check_observed: 60, state_check_failed: 21, state_check_failure_rate: 35 },
    { bucket_start: '2026-09-21T12:00:00+08:00', requests_with_model: 3, mismatched: 2, match_rate: 33.3, state_check_observed: 0, state_check_failed: 0, state_check_failure_rate: null },
  ],
  matrix: [
    { requested_model: 'gpt-6-astra', upstream_model: 'gpt-5.6-luna', count: 119, share: 0.65, matched: false },
    { requested_model: 'gpt-6-astra', upstream_model: 'gpt-6-astra', count: 64, share: 0.35, matched: true },
  ],
  substitutions: [
    { requested_model: 'gpt-6-astra', requests_with_model: 183, mismatched: 119, match_rate: 34.97 },
  ],
  truncated: false,
  ...overrides,
});

const emptyResponse = (): ModelSubstitutionResponse => response({
  summary: { requests_with_model: 0, matched: 0, mismatched: 0, match_rate: null, empty: true, top_substitution: null },
  series: [{ bucket_start: '2026-09-21T12:00:00+08:00', requests_with_model: 0, mismatched: 0, match_rate: null, state_check_observed: 0, state_check_failed: 0, state_check_failure_rate: null }],
  matrix: [],
  substitutions: [],
});

let root: Root | null = null;
let node: HTMLDivElement | null = null;

const render = async (payload: unknown) => {
  // fetchModelSubstitution 在真实路径上已经归一化；这里复用同一个归一化器，
  // 保证组件只面对契约内形状，也顺便验证旧后端缺字段时不崩。
  const normalized = normalizeModelSubstitution(payload);
  fetchModelSubstitution.mockResolvedValueOnce(normalized);
  node = document.createElement('div');
  document.body.appendChild(node);
  root = createRoot(node);
  await act(async () => { root!.render(<ModelSubstitutionPanel />); });
  return node;
};

beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); latestChartData = null; latestChartOptions = null; });
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  node?.remove();
  root = null;
  node = null;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('ModelSubstitutionPanel', () => {
  it('shows the covered sample size, summary cards and the top substitution', async () => {
    const element = await render(response());
    expect(fetchModelSubstitution).toHaveBeenCalledWith('24h', expect.anything());
    // upstream_model 是新字段，覆盖样本量必须始终显示。
    expect(element.textContent).toContain('turn_state.model_sub_coverage:{"count":183}');
    expect(element.textContent).toContain('183');
    expect(element.textContent).toContain('119');
    expect(element.textContent).toContain('gpt-6-astra → gpt-5.6-luna 65%');
  });

  it('colours the match rate with the 90/60 bands and keeps 89/59 on their own side', async () => {
    await render(response());
    const findTone = () => document.querySelector('[data-model-subscription-match-rate] [data-tone]')?.getAttribute('data-tone');
    expect(findTone()).toBe('danger');

    await act(async () => root!.unmount());
    node!.remove();
    await render(response({ summary: { ...response().summary, match_rate: 90 } }));
    expect(findTone()).toBe('success');

    await act(async () => root!.unmount());
    node!.remove();
    await render(response({ summary: { ...response().summary, match_rate: 89 } }));
    expect(findTone()).toBe('warning');

    await act(async () => root!.unmount());
    node!.remove();
    await render(response({ summary: { ...response().summary, match_rate: 60 } }));
    expect(findTone()).toBe('warning');

    await act(async () => root!.unmount());
    node!.remove();
    await render(response({ summary: { ...response().summary, match_rate: 59 } }));
    expect(findTone()).toBe('danger');
  });

  it('renders no rate at all when there is no sample instead of a red 0%', async () => {
    const element = await render(emptyResponse());
    const tone = document.querySelector('[data-model-subscription-match-rate] [data-tone]')?.getAttribute('data-tone');
    expect(tone).toBe('neutral');
    expect(element.textContent).toContain('turn_state.not_available');
    // 无带上游模型信息的请求：显示明确文案，且不渲染空图表。
    expect(element.textContent).toContain('turn_state.model_sub_empty');
    expect(element.textContent).toContain('turn_state.none');
    expect(document.querySelector('[data-model-subscription-chart]')).toBeNull();
    expect(document.querySelector('[data-model-subscription-matrix]')).toBeNull();
    expect(element.textContent).not.toContain('0.0%');
  });

  it('plots both series on one 0-100 axis with volume bars and flags low-sample buckets', async () => {
    const element = await render(response());
    expect(latestChartData).not.toBeNull();
    const datasets = latestChartData!.datasets;
    expect(datasets.map((dataset) => dataset.label)).toEqual([
      'turn_state.model_sub_series_volume',
      'turn_state.model_sub_series_match',
      'turn_state.model_sub_series_state_check',
    ]);
    // 一致率 35%，状态检查失败率 35% —— 共用同一组桶。
    expect(datasets[1].data).toEqual([35, 33.3]);
    expect(datasets[2].data).toEqual([35, null]);
    const scales = latestChartOptions!.scales as Record<string, { max?: number; display?: boolean }>;
    expect(scales.rate.max).toBe(100);
    // 请求量柱使用隐藏轴，只做视觉提示。
    expect(scales.volume.display).toBe(false);
    expect(scales.volume.max).toBeUndefined();
    // 3 条样本的桶被标注为低样本。
    expect(element.textContent).toContain('turn_state.model_sub_low_sample:{"count":1,"threshold":5}');
    expect(datasets[1].pointRadius).toEqual([0, 4]);
  });

  it('marks the matrix diagonal neutral and off-diagonal cells as substitutions', async () => {
    await render(response({
      matrix: [
        { requested_model: 'gpt-6-astra', upstream_model: 'gpt-5.6-luna', count: 119, share: 0.65, matched: false },
        { requested_model: 'gpt-6-astra', upstream_model: 'gpt-6-astra', count: 64, share: 0.35, matched: true },
        { requested_model: 'o5-code', upstream_model: 'o5-mini', count: 4, share: 1, matched: false },
      ],
    }));
    const cells = [...document.querySelectorAll('[data-model-subscription-matrix] td[data-cell-diagonal]')];
    const diagonal = cells.filter((cell) => cell.getAttribute('data-cell-diagonal') === 'true');
    const offDiagonal = cells.filter((cell) => cell.getAttribute('data-cell-diagonal') === 'false');
    expect(diagonal).toHaveLength(1);
    expect(diagonal[0].textContent).toBe('64');
    expect(offDiagonal.some((cell) => cell.textContent === '119')).toBe(true);
    // o5-code 行没有 gpt-5.6-luna / gpt-6-astra 样本：用中划线而不是 0。
    expect(cells.some((cell) => cell.textContent === '—')).toBe(true);
    // 最后一列是该请求模型的一致率，用同一套分段色。
    const rateCell = document.querySelector('[data-model-subscription-matrix] td[data-tone]');
    expect(rateCell?.getAttribute('data-tone')).toBe('danger');
  });

  it('switches range on click and keeps the previous snapshot visible while loading', async () => {
    await render(response());
    fetchModelSubstitution.mockResolvedValueOnce(response({ range: '1h', bucket_seconds: 60, series: [] }));
    const buttons = [...document.querySelectorAll('button')];
    const oneHour = buttons.find((button) => button.textContent === 'turn_state.model_sub_range_1h');
    expect(oneHour).toBeTruthy();
    await act(async () => { oneHour!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(fetchModelSubstitution).toHaveBeenLastCalledWith('1h', expect.anything());
    expect(node!.textContent).not.toContain('turn_state.model_sub_unavailable');
  });

  it('reports a failure without leaking the raw error and honours 401 handling', async () => {
    const onAuthRequired = vi.fn();
    fetchModelSubstitution.mockRejectedValueOnce(new ApiError('private detail', 401));
    node = document.createElement('div');
    document.body.appendChild(node);
    root = createRoot(node);
    await act(async () => { root!.render(<ModelSubstitutionPanel onAuthRequired={onAuthRequired} />); });
    expect(onAuthRequired).toHaveBeenCalledOnce();
    expect(node.textContent).toContain('turn_state.model_sub_unavailable');
    expect(node.textContent).not.toContain('private detail');
  });

  it('does not crash on payloads without the newer field shapes', async () => {
    const element = await render({
      schema: MODEL_SUBSTITUTION_SCHEMA,
      range: '24h',
      bucket_seconds: 3600,
      // 旧后端：series/matrix 行缺少 state_check 与 share 字段。
      summary: { requests_with_model: 2, matched: 2, mismatched: 0 },
      series: [{ bucket_start: '2026-09-21T12:00:00+08:00', requests_with_model: 2, mismatched: 0, match_rate: 100 }],
      matrix: [{ requested_model: 'gpt-6-astra', upstream_model: 'gpt-6-astra', count: 2 }],
      substitutions: [{ requested_model: 'gpt-6-astra', requests_with_model: 2, mismatched: 0, match_rate: 100 }],
    });
    expect(element.textContent).toContain('turn_state.model_sub_title');
    expect(element.textContent).not.toContain('NaN');
    // 旧后端缺 match_rate：按契约显示不可用（中性色），不能把缺失当成 100%。
    expect(document.querySelector('[data-model-subscription-match-rate] [data-tone]')?.getAttribute('data-tone')).toBe('neutral');
    expect(element.textContent).toContain('turn_state.not_available');
    // 缺少状态检查字段的桶必须是 null 缺口，而不是 0% 的假失败。
    expect((latestChartData!.datasets[2].data as Array<number | null>)).toEqual([null]);
  });
});

describe('model substitution chart helpers', () => {
  it('formats bucket labels with the resolution implied by the bucket width', () => {
    const start = '2026-09-21T12:00:00+08:00';
    expect(formatModelSubstitutionBucket(start, 60)).toBe('12:00');
    expect(formatModelSubstitutionBucket(start, 3600)).toBe('09-21 12:00');
    expect(formatModelSubstitutionBucket(start, 24 * 3600)).toBe('09-21');
    expect(formatModelSubstitutionBucket('not-a-date', 3600)).toBe('not-a-date');
    // 标签读服务端墙钟时间，不受运行测试的浏览器时区影响。
    expect(formatModelSubstitutionBucket('2026-09-21T00:05:00+08:00', 60)).toBe('00:05');
  });

  it('keeps null rates as gaps instead of zero, so a missing sample cannot look like failure', () => {
    const data = buildModelSubstitutionChartData([
      { bucketStart: '2026-09-21T12:00:00+08:00', requestsWithModel: 0, matchRate: null, stateCheckObserved: 0, stateCheckFailureRate: null, lowSample: false },
    ], 3600, key => key);
    expect(data.datasets[1].data).toEqual([null]);
    expect(data.datasets[2].data).toEqual([null]);
    expect(data.datasets[0].data).toEqual([0]);
  });

  it('exposes both sample sizes in the tooltip footer', () => {
    const t = (key: string, params?: Record<string, unknown>) => params ? `${key}:${JSON.stringify(params)}` : key;
    const options = buildModelSubstitutionChartOptions(
      [{ bucketStart: '2026-09-21T12:00:00+08:00', requestsWithModel: 7, matchRate: 50, stateCheckObserved: 3, stateCheckFailureRate: 33, lowSample: false }],
      t,
      false,
      false,
    );
    const footer = options.plugins!.tooltip!.callbacks!.footer;
    const lines = footer!([{ dataIndex: 0, dataset: { yAxisID: 'rate' } }] as never, {} as never);
    expect(lines).toEqual(['turn_state.model_sub_tooltip_match_sample:{"count":7}', 'turn_state.model_sub_tooltip_state_sample:{"count":3}']);
  });
});

describe('Latest model observations table', () => {
  const currentPayload = (current: unknown[]) => response({ current } as Partial<ModelSubstitutionResponse>);

  it('lists one row per requested model with match/replaced result and relative time', async () => {
    const element = await render(currentPayload([
      {
        requested_model: 'gpt-6-astra', upstream_model: 'gpt-5.6-luna', matched: false,
        observed_at: '2026-09-21T12:25:00+08:00', age_seconds: 300,
        state_check: 'shape_mismatch', state_check_reason: 'block_mismatch',
        state_check_observed_blocks: 11, state_check_expected_blocks: 10, account_entry_id: 'acct-1',
      },
      {
        requested_model: 'gpt-5.6-sol', upstream_model: 'gpt-5.6-sol', matched: true,
        observed_at: '2026-09-21T12:29:00+08:00', age_seconds: 45,
        state_check: 'ok', state_check_reason: null,
        state_check_observed_blocks: null, state_check_expected_blocks: null, account_entry_id: null,
      },
    ]));

    // 表必须出现在历史图表之前：先回答“现在谁被换成了谁”。
    const currentBlock = element.querySelector('[data-model-subscription-current]');
    const chartBlock = element.querySelector('[data-model-subscription-chart]');
    expect(currentBlock).not.toBeNull();
    expect(chartBlock).not.toBeNull();
    expect(currentBlock!.compareDocumentPosition(chartBlock!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // 被替换行：红色 + 人类可读标签，并带出失败规则与块数。
    const replaced = currentBlock!.querySelector('[data-current-result="danger"]');
    expect(replaced?.textContent).toContain('turn_state.model_sub_current_replaced');
    const replacedState = currentBlock!.querySelector('[data-current-state="danger"]');
    expect(replacedState?.textContent).toContain('usage_stats.request_events_state_check_degraded');
    expect(replacedState?.textContent).toContain('block_mismatch');

    // 一致行：绿色。
    const matched = currentBlock!.querySelector('[data-current-result="success"]');
    expect(matched?.textContent).toContain('turn_state.model_sub_current_match');
    expect(currentBlock!.querySelector('[data-current-state="success"]')?.textContent)
      .toContain('usage_stats.request_events_state_check_ok');

    // 相对时间必须渲染，而不是只给原始时间戳。
    expect(currentBlock!.textContent).toContain('turn_state.model_sub_current_minutes_ago');
  });

  it('renders an unreported state as neutral instead of healthy', async () => {
    const element = await render(currentPayload([
      {
        requested_model: 'gpt-6-astra', upstream_model: 'gpt-5.6-terra', matched: false,
        observed_at: '2026-09-21T12:28:00+08:00', age_seconds: 120,
        state_check: null, state_check_reason: null,
        state_check_observed_blocks: null, state_check_expected_blocks: null, account_entry_id: null,
      },
    ]));

    const block = element.querySelector('[data-model-subscription-current]');
    // 未上报 state 既不能是绿，也不能被算成一致。
    expect(block!.querySelector('[data-current-state="neutral"]')).not.toBeNull();
    expect(block!.querySelector('[data-current-state="success"]')).toBeNull();
    expect(block!.querySelector('[data-current-result="danger"]')).not.toBeNull();
  });

  it('keeps an unknown state code neutral and shows the raw code', async () => {
    const element = await render(currentPayload([
      {
        requested_model: 'gpt-6-astra', upstream_model: 'gpt-6-astra', matched: true,
        observed_at: '2026-09-21T12:29:00+08:00', age_seconds: 30,
        state_check: 'brand_new_verdict', state_check_reason: 'brand_new_reason',
        state_check_observed_blocks: null, state_check_expected_blocks: null, account_entry_id: null,
      },
    ]));

    const block = element.querySelector('[data-model-subscription-current]');
    const neutral = block!.querySelector('[data-current-state="neutral"]');
    // 未来新增的判定码必须中性呈现，并保留原始码以便排查。
    expect(neutral).not.toBeNull();
    expect(neutral!.textContent).toContain('brand_new_verdict');
    expect(block!.querySelector('[data-current-state="success"]')).toBeNull();
  });

  it('shows an explicit empty state when no observation carries an upstream model', async () => {
    const element = await render(currentPayload([]));
    const block = element.querySelector('[data-model-subscription-current]');
    expect(block!.querySelector('[data-model-subscription-current-empty]')?.textContent)
      .toContain('turn_state.model_sub_current_empty');
  });

  it('renders the current table even when the historical window is empty', async () => {
    // 历史桶为空但最近有观测：顶部表仍必须显示，避免“有最新替换但页面说没数据”。
    const element = await render(response({
      summary: { requests_with_model: 0, matched: 0, mismatched: 0, match_rate: null, empty: true, top_substitution: null },
      series: [],
      matrix: [],
      substitutions: [],
      current: [{
        requested_model: 'gpt-6-astra', upstream_model: 'gpt-5.6-luna', matched: false,
        observed_at: '2026-09-21T12:29:00+08:00', age_seconds: 10,
        state_check: 'ok', state_check_reason: null,
        state_check_observed_blocks: null, state_check_expected_blocks: null, account_entry_id: null,
      }],
    } as Partial<ModelSubstitutionResponse>));

    const block = element.querySelector('[data-model-subscription-current]');
    expect(block!.querySelector('[data-current-result="danger"]')).not.toBeNull();
    expect(element.textContent).toContain('turn_state.model_sub_empty');
  });
});

describe('Latest observations polling', () => {
  it('polls every 30s while visible and stops on unmount', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const element = await render(response());
      expect(element.querySelector('[data-model-subscription-current]')).not.toBeNull();
      const callsAfterMount = fetchModelSubstitution.mock.calls.length;

      // 可见时到点必须再拉一次同一接口。
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(fetchModelSubstitution.mock.calls.length).toBeGreaterThan(callsAfterMount);

      // 卸载后必须清掉定时器。
      await act(async () => root!.unmount());
      const callsAfterUnmount = fetchModelSubstitution.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
      expect(fetchModelSubstitution.mock.calls.length).toBe(callsAfterUnmount);
      root = null;
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not poll while the document is hidden', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    try {
      await render(response());
      const calls = fetchModelSubstitution.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
      expect(fetchModelSubstitution.mock.calls.length).toBe(calls);
    } finally {
      hidden.mockRestore();
      vi.useRealTimers();
    }
  });
});
