// @vitest-environment happy-dom
/**
 * i18n key 泄漏是"页面正确但用户看到 turn_state.xxx"这类 bug 的唯一防线。
 * mock 的 t() 会把任何 key 原样返回，因此本文件**必须**用真实初始化过的 i18n 实例
 * 逐个语言渲染，断言真实文案出现、且 textContent 不含任何 'turn_state.' / 'usage_stats.' 前缀。
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { fetchModelSubstitution, fetchTurnStateOverview } from '@/lib/api';
import { TurnStatePanel } from '../TurnStatePanel';
import i18n, { SUPPORTED_LANGUAGES } from '@/i18n';
import fixture from '../../../../../internal/codexproxy/testdata/turn_state_overview.json';
import type { TurnStateOverview } from '@/lib/turnState';

vi.mock('@/lib/api', () => ({
  fetchTurnStateOverview: vi.fn(),
  fetchModelSubstitution: vi.fn(),
  ApiError: class extends Error { constructor(message: string, public status: number) { super(message); } },
}));
// 模型替换面板会画 canvas；本测试只关心 i18n 文案，不需要真实图表。
vi.mock('react-chartjs-2', () => ({ Chart: () => null }));

afterEach(async () => { vi.clearAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); await i18n.changeLanguage('en'); });

const NOW = fixture.server_time;

/** 合并总表的数据源：一行账号 x 模型，带主动/被动两路采集计数与超时。 */
const substitution = () => ({
  schema: 'cpa-usage-keeper.turn-state-model-mismatch.v1', range: '24h',
  window_start: NOW, window_end: NOW, bucket_seconds: 3600,
  summary: { requests_with_model: 10, matched: 6, mismatched: 4, match_rate: 60, empty: false, top_substitution: null },
  series: [], matrix: [], substitutions: [], truncated: false,
  current: [{
    requested_model: 'gpt-5.6-sol', upstream_model: 'gpt-5.6-luna', matched: false,
    observed_at: NOW, observed: true, age_seconds: 30,
    state_check: 'shape_mismatch', state_check_reason: 'block_mismatch',
    state_check_observed_blocks: 11, state_check_expected_blocks: 10,
    account_entry_id: 'acct-1', account_name: 'xiaohei.info@gmail.com',
    request_count: 10, mismatched: 4, mismatch_rate: 40,
    state_check_observed: 10, state_check_failed: 6, state_check_failure_rate: 60,
    probe_attempts: 8, probe_accepted: 5, probe_rejected: 3, probe_timeouts: 2,
  }],
});

/** 覆盖本轮新增/改动的每个键，否则泄漏只会在某个语言的分支里出现。 */
const overview = () => ({
  ...fixture,
  summary: { ...fixture.summary, active_probes: 0, accepted_probes: 0, rejected_probes: 0,
    active_attempts: 13, active_accepted: 1, active_rejected: 12, active_last_hour: 7, since: NOW },
  events: [
    { id: 't1', at: NOW, entry_id: 'acct', model: 'gpt-6-astra', source: 'ticket', action: 'harvest',
      result: 'ticket_model_mismatch', length: null, blocks: null, reason: 'ticket_model_mismatch',
      observed_blocks: null, expected_blocks: null, route_id: null, usage: null },
  ],
}) as unknown as TurnStateOverview;

const renderIn = async (language: string) => {
  vi.mocked(fetchTurnStateOverview).mockResolvedValue(overview());
  vi.mocked(fetchModelSubstitution).mockResolvedValue(substitution());
  await i18n.changeLanguage(language);
  const node = document.createElement('div');
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = createRoot(node);
  await act(async () => root.render(<TurnStatePanel />));
  return { node, root };
};

it('renders every locale without leaking a raw i18n key', async () => {
  expect(SUPPORTED_LANGUAGES).toEqual(['en', 'zh', 'zh-TW']);
  for (const language of SUPPORTED_LANGUAGES) {
    const { node, root } = await renderIn(language);
    const text = node.textContent ?? '';
    // 关键锚点：合并表标题与分区分组标题、账号列、采集列都必须真的翻译出来。
    expect(text).toContain(i18n.getResource(language, 'translation', 'turn_state.merged_group_collection'));
    expect(text).toContain(i18n.getResource(language, 'translation', 'turn_state.merged_account'));
    expect(text).toContain(i18n.getResource(language, 'translation', 'turn_state.merged_active'));
    expect(text).toContain(i18n.getResource(language, 'translation', 'turn_state.merged_passive'));
    // 分享/失败拆分文案与超时小字也在表内。
    expect(text).toContain(i18n.getResource(language, 'translation', 'turn_state.overview_capture_split').replace(/\s*\{\{.*$/, ''));
    expect(text).toContain(i18n.getResource(language, 'translation', 'turn_state.merged_timeouts').replace(/\s*\{\{.*$/, ''));
    // 账号名与模型名必须真实出现（数据到列位）。
    expect(text).toContain('xiaohei.info@gmail.com');
    expect(text).toContain('gpt-5.6-sol');
    // 真实引擎渲染下，任何未翻译的 key 都会以字面前缀出现。
    expect(text).not.toContain('turn_state.');
    expect(text).not.toContain('usage_stats.');
    await act(async () => root.unmount());
  }
});
