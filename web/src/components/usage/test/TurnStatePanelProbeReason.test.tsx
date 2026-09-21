// @vitest-environment happy-dom
/**
 * Active-probe rejections must name the failing reference rule instead of a
 * generic "probe failed", and must show the observed/expected envelope shape.
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

const probeEvent = (overrides: Record<string, unknown>) => ({
  id: 'evt', at: fixture.server_time, entry_id: 'acct', model: 'gpt-6-astra', source: 'active',
  action: 'reject', result: 'block_mismatch', length: null, blocks: null,
  reason: 'block_mismatch', observed_blocks: 11, expected_blocks: 10, route_id: null, usage: null,
  ...overrides,
});

async function render(events: unknown[]) {
  vi.mocked(fetchTurnStateOverview).mockResolvedValue({ ...fixture, events } as unknown as TurnStateOverview);
  const node = document.createElement('div');
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = createRoot(node);
  await act(async () => root.render(<TurnStatePanel />));
  return { node, root };
}

it("names the failed rule and shape for a block_mismatch probe rejection", async () => {
  const { node, root } = await render([probeEvent({})]);
  expect(node.textContent).toContain('turn_state.event_rejected_rule');
  // 形状是“块数 / 字符数”整体：11 块 = 312 字符，10 块 = 292 字符。
  expect(node.textContent).toContain('"blocks\\":11');
  expect(node.textContent).toContain('"characters\\":312');
  expect(node.textContent).toContain('"blocks\\":10');
  expect(node.textContent).toContain('"characters\\":292');
  await act(async () => root.unmount());
});

it("reports a mismatch that still passed every rule as accepted, not rejected", async () => {
  const { node, root } = await render([probeEvent({ action: 'accept', result: 'accepted_model_mismatch', reason: null, blocks: 10, observed_blocks: 10, expected_blocks: 10 })]);
  expect(node.textContent).toContain('turn_state.event_accepted_model_mismatch');
  expect(node.textContent).not.toContain('turn_state.event_rejected_rule');
  await act(async () => root.unmount());
});

it("explains no_state and auth blocks without a phantom rule", async () => {
  const { node, root } = await render([probeEvent({ result: 'no_state', reason: null, observed_blocks: null, expected_blocks: 10 }), probeEvent({ id: 'e2', result: 'auth_blocked', reason: null })]);
  expect(node.textContent).toContain('turn_state.event_no_state');
  expect(node.textContent).toContain('turn_state.event_auth_blocked');
  await act(async () => root.unmount());
});

it("keeps an unknown rule code visible instead of inventing a label", async () => {
  const { node, root } = await render([probeEvent({ result: 'future_rule', reason: 'future_rule', observed_blocks: null, expected_blocks: null })]);
  expect(node.textContent).toContain('"code":"future_rule"');
  await act(async () => root.unmount());
});
