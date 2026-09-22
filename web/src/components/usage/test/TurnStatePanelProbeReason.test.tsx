// @vitest-environment happy-dom
/**
 * 事件时间线已从页面移除（对用户没有可操作价值）。
 * state 形状与失败规则现在由【合并总表】的一行承载：形状必须作为
 * “块数 / 字符数”整体展示，未上报时不得编造块数，未知判定码原样保留。
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { fetchModelSubstitution, fetchTurnStateOverview } from '@/lib/api';
import { TurnStatePanel } from '../TurnStatePanel';
import fixture from '../../../../../internal/codexproxy/testdata/turn_state_overview.json';
import type { TurnStateOverview } from '@/lib/turnState';

vi.mock('@/lib/api', () => ({ fetchTurnStateOverview: vi.fn(), fetchModelSubstitution: vi.fn(), ApiError: class extends Error { constructor(message: string, public status: number) { super(message); } } }));
vi.mock('react-chartjs-2', () => ({ Chart: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, params?: Record<string, unknown>) => params ? `${key}:${JSON.stringify(params)}` : key }) }));

afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

const session = (overrides: Record<string, unknown>) => ({
  ...fixture.sessions[0], model: 'gpt-6-astra', phase: 'empty',
  last_result: null, last_failure: null, last_upstream_model: null, model_mismatch: false,
  ...overrides,
});

/** 合并总表行；只给出关心的字段，其余按未观测/无样本中性缺省。 */
const currentRow = (overrides: Record<string, unknown>) => ({
  requested_model: 'gpt-6-astra', upstream_model: '', matched: false,
  observed_at: fixture.server_time, observed: false, age_seconds: 0,
  state_check: null, state_check_reason: null,
  state_check_observed_blocks: null, state_check_expected_blocks: null,
  account_entry_id: 'acct-1', account_name: null,
  request_count: 0, mismatched: 0, mismatch_rate: null,
  state_check_observed: 0, state_check_failed: 0, state_check_failure_rate: null,
  probe_attempts: 0, probe_accepted: 0, probe_rejected: 0, probe_timeouts: 0,
  ...overrides,
});

const substitutionPayload = (current: unknown[]) => ({
  schema: 'cpa-usage-keeper.turn-state-model-mismatch.v1', range: '24h',
  window_start: '2026-09-21T00:00:00Z', window_end: '2026-09-22T00:00:00Z', bucket_seconds: 3600,
  summary: { requests_with_model: 0, matched: 0, mismatched: 0, match_rate: null, empty: true, top_substitution: null },
  series: [], matrix: [], substitutions: [], current, truncated: false,
});

async function render(sessions: unknown[], summary?: Record<string, unknown>, current: unknown[] = []) {
  vi.mocked(fetchTurnStateOverview).mockResolvedValue({ ...fixture, sessions, ...(summary ? { summary: { ...fixture.summary, ...summary } } : {}) } as unknown as TurnStateOverview);
  vi.mocked(fetchModelSubstitution).mockResolvedValue(substitutionPayload(current) as never);
  const node = document.createElement('div');
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = createRoot(node);
  await act(async () => root.render(<TurnStatePanel />));
  return { node, root };
}

it('names the failed rule and the whole shape on the merged table row for a block_mismatch rejection', async () => {
  const { node, root } = await render([session({ phase: 'collecting' })], undefined, [currentRow({
    state_check: 'shape_mismatch', state_check_reason: 'block_mismatch',
    state_check_observed_blocks: 11, state_check_expected_blocks: 10,
  })]);
  const cell = node.querySelector('[data-merged-state]');
  expect(cell).not.toBeNull();
  // 形状是“块数 / 字符数”整体：11 块 = 312 字符，10 块 = 292 字符。
  expect(cell!.textContent).toContain('"blocks\\":11');
  expect(cell!.textContent).toContain('"characters\\":312');
  expect(cell!.textContent).toContain('"blocks\\":10');
  expect(cell!.textContent).toContain('"characters\\":292');
  // 不得出现嵌套模板残留。
  expect(node.textContent).not.toContain('{{');
  await act(async () => root.unmount());
});

it('renders a mismatch that still passed the rules as its own neutral observation', async () => {
  // 模型被替换但 state 结构通过：形状列必须是 ok（成功色），不能显示成降智。
  const { node, root } = await render([session({ phase: 'usable', last_upstream_model: 'gpt-5.6-luna', model_mismatch: true })], undefined, [currentRow({
    upstream_model: 'gpt-5.6-luna', observed: true, matched: false, state_check: 'ok',
  })]);
  const cell = node.querySelector('[data-merged-state]');
  expect(cell?.getAttribute('data-merged-state')).toBe('success');
  expect(node.textContent).toContain('gpt-5.6-luna');
  await act(async () => root.unmount());
});

it('explains no_state without a phantom rule', async () => {
  const { node, root } = await render([session({})], undefined, [currentRow({
    state_check: 'no_state', state_check_reason: null,
  })]);
  const cell = node.querySelector('[data-merged-state]');
  expect(cell!.textContent).toContain('usage_stats.request_events_state_check_none');
  // 没有形状数据时不得编造块数。
  expect(cell!.textContent).not.toContain('- 块');
  await act(async () => root.unmount());
});

it('keeps an unknown rule code visible instead of inventing a label', async () => {
  const { node, root } = await render([session({})], undefined, [currentRow({
    state_check: 'future_verdict', state_check_reason: 'future_rule',
  })]);
  expect(node.textContent).toContain('future_verdict');
  await act(async () => root.unmount());
});

it('shows the attempt split and the timeouts on the merged collection columns', async () => {
  const { node, root } = await render(
    [session({ last_observed_at: fixture.server_time, last_injected_at: null, observation_count: 121, ticket_round_count: 12 })],
    undefined,
    [currentRow({ probe_attempts: 12, probe_accepted: 1, probe_rejected: 11, probe_timeouts: 2, state_check_observed: 121, state_check_failed: 121 })],
  );
  // 被动采集列给出尝试数与成功/未通过拆分，与主动列用同一套措辞。
  expect(node.textContent).toContain('turn_state.overview_capture_split');
  expect(node.textContent).toContain('121');
  // 主动列在当前档读会话上的实时计数。
  expect(node.textContent).toContain('12');
  await act(async () => root.unmount());
});

it('no longer renders an events timeline', async () => {
  const { node, root } = await render([session({})]);
  expect(node.textContent).not.toContain('turn_state.events');
  await act(async () => root.unmount());
});
