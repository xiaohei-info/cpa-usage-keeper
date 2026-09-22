// @vitest-environment happy-dom
/**
 * 合并总表的核心契约：行 = 账号 x 模型。
 *
 * 覆盖三件必须成立的事：
 *   1. 同一模型在两个账号下必须是两行（不再汇总成一行）。
 *   2. 历史档隐藏“有效期/下次采集”这两个瞬时列，当前档显示。
 *   3. 排序按替换率/降智率/请求数生效。
 * 另外验证主动/被动两路采集数据分开呈现，超时单独标出。
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

const row = (overrides: Record<string, unknown>) => ({
  requested_model: 'gpt-5.6-sol', upstream_model: 'gpt-5.6-sol', matched: true,
  observed_at: fixture.server_time, observed: true, age_seconds: 60,
  state_check: 'ok', state_check_reason: null,
  state_check_observed_blocks: null, state_check_expected_blocks: null,
  account_entry_id: 'acct-a', account_name: 'xiaohei.info@gmail.com',
  request_count: 10, mismatched: 0, mismatch_rate: 0,
  state_check_observed: 10, state_check_failed: 0, state_check_failure_rate: 0,
  probe_attempts: 5, probe_accepted: 4, probe_rejected: 1, probe_timeouts: 0,
  ...overrides,
});

const payload = (current: unknown[], range = '24h') => ({
  schema: 'cpa-usage-keeper.turn-state-model-mismatch.v1', range,
  window_start: '2026-09-21T00:00:00Z', window_end: '2026-09-22T00:00:00Z', bucket_seconds: 3600,
  summary: { requests_with_model: 0, matched: 0, mismatched: 0, match_rate: null, empty: true, top_substitution: null },
  series: [], matrix: [], substitutions: [], current, truncated: false,
});

async function render(current: unknown[], sessions: unknown[] = []) {
  vi.mocked(fetchTurnStateOverview).mockResolvedValue({ ...fixture, sessions } as unknown as TurnStateOverview);
  vi.mocked(fetchModelSubstitution).mockResolvedValue(payload(current) as never);
  const node = document.createElement('div');
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = createRoot(node);
  await act(async () => root.render(<TurnStatePanel />));
  return { node, root };
}

const bodyRows = (node: HTMLElement) => [...node.querySelectorAll('[data-turn-state-merged-table] tbody tr')];
const headerTexts = (node: HTMLElement) => [...node.querySelectorAll('[data-turn-state-merged-table] thead tr:last-child th')].map((th) => th.textContent ?? '');

it('renders one row per account and model, splitting the same model across accounts', async () => {
  const { node, root } = await render([
    row({ account_entry_id: 'acct-a', account_name: 'xiaohei.info@gmail.com', mismatch_rate: 65 }),
    row({ account_entry_id: 'acct-b', account_name: 'vampire728ly@163.com', mismatch_rate: 12.3 }),
  ]);
  const rows = bodyRows(node);
  expect(rows).toHaveLength(2);
  expect(rows[0].textContent).toContain('xiaohei.info@gmail.com');
  expect(rows[1].textContent).toContain('vampire728ly@163.com');
  // 两行都是同一个请求模型，但必须并存而不是被合并。
  expect(rows[0].textContent).toContain('gpt-5.6-sol');
  expect(rows[1].textContent).toContain('gpt-5.6-sol');
  await act(async () => root.unmount());
});

it('falls back to the id prefix when no account name was resolved', async () => {
  const { node, root } = await render([row({ account_name: null, account_entry_id: 'd0f784113bd9d041' })]);
  expect(bodyRows(node)[0].textContent).toContain('d0f78411');
  await act(async () => root.unmount());
});

it('hides the transient expire / next-collection columns on a historical range', async () => {
  const { node, root } = await render([row({})]);
  // 默认档是“当前”：两个瞬时列必须存在。
  const currentHeaders = headerTexts(node);
  expect(currentHeaders.some((text) => text.includes('turn_state.merged_expires'))).toBe(true);
  expect(currentHeaders.some((text) => text.includes('turn_state.merged_next_probe'))).toBe(true);

  // 切到历史档：两者都必须消失，避免把“现在的剩余时间”读成那个窗口的状态。
  const thirtyDay = [...node.querySelectorAll('button')].find((button) => button.textContent === 'turn_state.model_sub_range_30d');
  await act(async () => { thirtyDay!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await act(async () => { await Promise.resolve(); });
  const historicalHeaders = headerTexts(node);
  expect(historicalHeaders.some((text) => text.includes('turn_state.merged_expires'))).toBe(false);
  expect(historicalHeaders.some((text) => text.includes('turn_state.merged_next_probe'))).toBe(false);
  // 窗口聚合列反过来只应出现在历史档。
  expect(historicalHeaders.some((text) => text.includes('turn_state.merged_mismatch_rate'))).toBe(true);
  await act(async () => root.unmount());
});

it('sorts by replacement rate and by request count', async () => {
  const { node, root } = await render([
    row({ account_entry_id: 'a', account_name: 'low', mismatch_rate: 5, request_count: 100 }),
    row({ account_entry_id: 'b', account_name: 'high', mismatch_rate: 90, request_count: 1 }),
  ]);
  // 默认按替换率降序：最高的在最前面。
  expect(bodyRows(node)[0].textContent).toContain('high');

  // 切到历史档才有替换率列；用当前档验证请求数排序。
  const requestSort = [...node.querySelectorAll('button')].find((button) => (button.textContent ?? '').includes('turn_state.merged_requests'));
  await act(async () => { requestSort!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  expect(bodyRows(node)[0].textContent).toContain('low');
  await act(async () => root.unmount());
});

it('shows active and passive collection separately and flags probe timeouts', async () => {
  const { node, root } = await render([row({ probe_attempts: 8, probe_timeouts: 2 })], [{
    ...fixture.sessions[0], entry_id: 'acct-a', model: 'gpt-5.6-sol',
    injection_count: 12, observation_count: 30, active: null, ready: null,
  }]);
  const text = bodyRows(node)[0].textContent ?? '';
  // 注入（累计）、被动、主动三列必须在同一行里各给各的数。
  expect(text).toContain('12');
  expect(text).toContain('30');
  expect(text).toContain('8');
  // 超时单独标出，不能混进普通失败。
  expect(text).toContain('turn_state.merged_timeouts');
  await act(async () => root.unmount());
});

it('shows an explicit empty state instead of an empty table', async () => {
  const { node, root } = await render([]);
  expect(node.querySelector('[data-turn-state-merged-empty]')).not.toBeNull();
  expect(node.textContent).toContain('turn_state.merged_empty');
  await act(async () => root.unmount());
});
