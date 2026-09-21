// @vitest-environment happy-dom
/**
 * 事件时间线已从页面移除（对用户没有可操作价值），失败原因必须由会话卡承载：
 * 主动探测的拒绝要说明未通过的规则，并把形状作为“块数 / 字符数”整体展示。
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { fetchTurnStateOverview } from '@/lib/api';
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

async function render(sessions: unknown[], summary?: Record<string, unknown>) {
  vi.mocked(fetchTurnStateOverview).mockResolvedValue({ ...fixture, sessions, ...(summary ? { summary: { ...fixture.summary, ...summary } } : {}) } as unknown as TurnStateOverview);
  const node = document.createElement('div');
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = createRoot(node);
  await act(async () => root.render(<TurnStatePanel />));
  return { node, root };
}

it('names the failed rule and the whole shape on the session card for a block_mismatch rejection', async () => {
  const { node, root } = await render([session({
    phase: 'collecting', last_result: 'block_mismatch',
    last_failure: { code: 'block_mismatch', reason: 'block_mismatch', verdict: 'shape_mismatch', observed_blocks: 11, expected_blocks: 10 },
  })]);
  const failure = node.querySelector('[data-turn-state-failure]');
  expect(failure).not.toBeNull();
  // 形状是“块数 / 字符数”整体：11 块 = 312 字符，10 块 = 292 字符。
  expect(failure!.textContent).toContain('"blocks\\":11');
  expect(failure!.textContent).toContain('"characters\\":312');
  expect(failure!.textContent).toContain('"blocks\\":10');
  expect(failure!.textContent).toContain('"characters\\":292');
  // 不得出现嵌套模板残留。
  expect(node.textContent).not.toContain('{{');
  await act(async () => root.unmount());
});

it('reports a mismatch that still passed every rule as accepted, not rejected', async () => {
  const { node, root } = await render([session({
    phase: 'usable', last_result: 'accepted_model_mismatch', last_upstream_model: 'gpt-5.6-luna', model_mismatch: true,
    last_failure: null,
  })]);
  expect(node.querySelector('[data-turn-state-failure]')).toBeNull();
  expect(node.textContent).toContain('turn_state.model_replaced');
  expect(node.textContent).toContain('gpt-5.6-luna');
  await act(async () => root.unmount());
});

it('explains no_state and auth blocks without a phantom rule', async () => {
  const { node, root } = await render([session({
    last_result: 'no_state', last_failure: { code: 'no_state', reason: null, verdict: 'no_state', observed_blocks: null, expected_blocks: null },
  })]);
  const failure = node.querySelector('[data-turn-state-failure]');
  expect(failure!.textContent).toContain('turn_state.event_no_state');
  // 没有形状数据时不得编造块数。
  expect(failure!.textContent).not.toContain('- 块');
  await act(async () => root.unmount());
});

it('keeps an unknown rule code visible instead of inventing a label', async () => {
  const { node, root } = await render([session({
    last_result: 'future_rule', last_failure: { code: 'future_rule', reason: 'future_rule', verdict: 'invalid', observed_blocks: null, expected_blocks: null },
  })]);
  expect(node.textContent).toContain('future_rule');
  await act(async () => root.unmount());
});

it('shows the attempt split and the last update on both capture cards', async () => {
  const { node, root } = await render(
    [session({ last_observed_at: fixture.server_time, last_injected_at: null })],
    { passive_observations: 121, passive_accepted: 0, passive_rejected: 121, active_probes: 12, accepted_probes: 0, rejected_probes: 11 },
  );
  const passive = node.querySelector('[data-turn-state-passive-observed]');
  expect(passive).not.toBeNull();
  // 被动采集已按结果拆分：成功 / 未通过，与主动探测对称。
  expect(node.textContent).toContain('turn_state.overview_capture_split');
  // 尝试数 121、未通过 121 都要出现，且与主动探测用同一套措辞。
  expect(node.textContent).toContain('121');
  expect(passive!.textContent).toContain('121');
  expect(node.textContent).toContain('turn_state.last_updated');
  await act(async () => root.unmount());
});

it('no longer renders an events timeline', async () => {
  const { node, root } = await render([session({})]);
  expect(node.textContent).not.toContain('turn_state.events');
  await act(async () => root.unmount());
});
