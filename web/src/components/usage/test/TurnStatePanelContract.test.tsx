// @vitest-environment happy-dom
/**
 * Keeper 侧的 Turn-State 展示契约（/tmp/codex-state-audit/turn-state-ui-contract.md §2-§7）。
 * 只验证展示层：状态词、形状整体表达、无嵌套插值、会话卡可读性、事件过滤与向后兼容。
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { fetchModelSubstitution, fetchTurnStateOverview } from '@/lib/api';
import { TurnStatePanel } from '../TurnStatePanel';
import fixture from '../../../../../internal/codexproxy/testdata/turn_state_overview.json';
import type { TurnStateOverview } from '@/lib/turnState';

// 翻译函数按真实语义返回文本，这样断言检查的是用户看到的字，而不是翻译 key。
const STRINGS: Record<string, string> = {
  'turn_state.title': '模型质量',
  'turn_state.updated_at': '更新于 {{time}}',
  'turn_state.current': '最新快照',
  'turn_state.stale': '数据已过期',
  'turn_state.unavailable': '状态不可用',
  'common.loading': '加载中',
  'turn_state.unknown': '未知',
  'turn_state.not_available': '暂无',
  'turn_state.empty': '此快照没有记录。',
  'turn_state.none': '无',
  'turn_state.available': '有',
  'turn_state.value_on': '已开启',
  'turn_state.value_off': '未开启',
  'turn_state.mode_off': '关闭',
  'turn_state.mode_observe': '仅观察',
  'turn_state.mode_replace': '仅替换异常状态',
  'turn_state.mode_always': '尽可能始终注入',
  'turn_state.rule_value': '{{plan}} · {{shape}}',
  'turn_state.rule_auto': '自动识别',
  'turn_state.plan_personal': 'Personal',
  'turn_state.plan_team': 'Team',
  'turn_state.config_column': '配置',
  'turn_state.config_state_column': '当前状态',
  'turn_state.config_meaning_column': '含义',
  'turn_state.config_help': '当前实际开启的配置',
  'turn_state.config_experiment': '实验总开关',
  'turn_state.config_experiment_help': 'Turn-State 功能整体启用',
  'turn_state.config_passive': '被动采集',
  'turn_state.config_passive_help': '正常业务响应会被保存为新 State',
  'turn_state.config_active': '主动探测',
  'turn_state.config_active_help': '会主动发起短探测请求，可能消耗额度',
  'turn_state.config_mode': '注入模式',
  'turn_state.config_mode_help': '当前是否会把 State 写入业务请求',
  'turn_state.config_rule': '当前 State 规则',
  'turn_state.config_rule_help': '来自账号套餐自动识别，或手动设置',
  'turn_state.session_help': '每个账号与模型当前缓存的 turn-state，以及下一步会发生什么',
  'turn_state.event_rule_unknown': '未知原因（{{code}}）',
  'turn_state.model_sub_current_title': '最近模型观测',
  'turn_state.model_sub_current_help': '每个请求模型最近一次的上游应答',
  'turn_state.model_sub_current_requested': '请求模型',
  'turn_state.model_sub_current_upstream': '上游实际模型',
  'turn_state.model_sub_current_result': '结果',
  'turn_state.model_sub_current_match': '一致',
  'turn_state.model_sub_current_replaced': '被替换',
  'turn_state.model_sub_current_unobserved': '未观测',
  'turn_state.model_sub_current_last_observed': '最近观测',
  'turn_state.model_sub_current_state': 'state 探查',
  'turn_state.model_sub_current_empty': '最近范围内没有模型观测',
  'turn_state.model_sub_current_polling': '页面打开时每 30 秒自动刷新一次。',
  'turn_state.model_sub_current_just_now': '刚刚',
  'turn_state.model_sub_current_minutes_ago': '{{count}} 分钟前',
  'usage_stats.request_events_state_check_ok': '正常',
  'usage_stats.request_events_state_check_none': '无',
  'usage_stats.request_events_state_check_degraded': '可能降智',
  'turn_state.model_sub_title': '模型替换观测',
  'turn_state.model_sub_help': '只读展示每个请求上游实际返回的模型历史',
  'turn_state.model_sub_range_label': '时间范围',
  'turn_state.model_sub_range_1h': '1 小时',
  'turn_state.model_sub_range_6h': '6 小时',
  'turn_state.model_sub_range_24h': '24 小时',
  'turn_state.model_sub_range_7d': '7 天',
  'turn_state.model_sub_range_30d': '30 天',
  'turn_state.model_sub_unavailable': '模型替换数据暂不可用',
  'turn_state.model_sub_empty': '暂无带上游模型信息的请求',
  'turn_state.status_ready': '已就绪',
  'turn_state.status_collecting': '采集中',
  'turn_state.status_expired': '已过期',
  'turn_state.status_paused': '已暂停',
  'turn_state.status_not_ready': '未就绪',
  'turn_state.status_not_applicable': '不适用',
  'turn_state.excluded_reason': '该模型已排除主动探测',
  'turn_state.current_state': '当前 State',
  'turn_state.state_ready': '可用',
  'turn_state.state_unavailable': '无可用状态',
  'turn_state.shape': 'State 形状',
  'turn_state.remaining': '剩余',
  'turn_state.minutes': '分钟',
  'turn_state.last_probe': '最近探测',
  'turn_state.failure_reason': '失败原因',
  'turn_state.failure_shape': '实际与目标',
  'turn_state.requested_model': '请求模型',
  'turn_state.actual_model': '实际模型',
  'turn_state.model_replaced': '已替换',
  'turn_state.model_matched': '一致',
  'turn_state.model_unobserved': '未观测',
  'turn_state.next_probe': '下次探测',
  'turn_state.business_injection': '业务注入',
  'turn_state.injection_none': '尚未发生',
  'turn_state.injection_count': '已注入 {{count}} 次，最近 {{time}}',
  'turn_state.reused_connections': '复用已有连接',
  'turn_state.backup_state': '备用 State',
  'turn_state.technical_details': '高级诊断',
  'turn_state.entry_id': '账号条目 ID',
  'turn_state.route_id': '线路 ID',
  'turn_state.fingerprint': 'State 指纹',
  'turn_state.diagnostic': '原始诊断码',
  'turn_state.epoch': '运行实例',
  'turn_state.events': '最近事件',
  'turn_state.sessions': '账号模型 State',
  'turn_state.config': '配置状态',
  'turn_state.relative_just_now': '刚刚',
  'turn_state.relative_minutes_ago': '{{count}} 分钟前',
  'turn_state.countdown_minutes': '约 {{count}} 分钟后',
  'turn_state.countdown_now': '即将开始',
  'turn_state.source_active': '主动探测',
  'turn_state.source_passive': '被动采集',
  'turn_state.source_injection': '注入',
  'turn_state.source_lifecycle': '生命周期',
  'turn_state.probe_usage': '探测用量',
  'turn_state.usage_input': '输入',
  'turn_state.usage_output': '输出',
  'turn_state.event_accepted': '已保存 State',
  'turn_state.event_probe_success': '主动探测成功，已保存 State',
  'turn_state.event_passive_success': '被动观测成功，已保存 State',
  'turn_state.event_accepted_model_mismatch': '已保存 State，但上游实际使用了 {{model}}',
  'turn_state.event_block_mismatch': 'State 形状不符',
  'turn_state.event_no_state': '上游没有返回 State',
  'turn_state.event_incomplete': '响应未完整结束，未保存 State',
  'turn_state.event_expired': 'State 已过期',
  'turn_state.event_timestamp_future': 'State 时间戳异常',
  'turn_state.event_encoding': 'State 编码或封装异常',
  'turn_state.event_auth_blocked': '上游拒绝了凭据，已暂停该账号探测',
  'turn_state.event_quota_blocked': '达到上游限制，已暂停该账号探测',
  'turn_state.event_budget_exhausted': '该账号探测预算已用完',
  'turn_state.event_model_unknown': '已保存 State，但上游未返回模型名',
  'turn_state.event_generic': '事件：{{result}}',
  'turn_state.overview_ready': '可用 State',
  'turn_state.overview_ready_help': '当前可用于注入',
  'turn_state.overview_ready_none': '当前没有可注入的状态',
  'turn_state.overview_probes': '最近主动探测',
  'turn_state.overview_observed': '被动采集',
  'turn_state.overview_observed_help': '完整响应中成功拿到 turn-state 的次数',
  'turn_state.overview_observed_none': '尚无响应提供 State',
  'turn_state.overview_probe_help': '成功 {{accepted}} · 未通过 {{rejected}}',
  'turn_state.overview_injected': '实际注入',
  'turn_state.overview_substitution': '模型替换',
  'turn_state.substitution_none': '暂无替换记录',
  'turn_state.overview_substitution_count': '最近 24 小时 {{count}} 次',
  'turn_state.overview_injected_help': '真正把状态写入请求的次数',
  'turn_state.overview_injection_none': '尚未发生实际注入',
  'turn_state.overview_sessions': '当前账号会话',
  'turn_state.overview_sessions_none_ready': '暂无就绪会话',
  'turn_state.overview_sessions_ready': '已就绪 {{count}} 个',
  'usage_stats.state_shape': '{{blocks}} 块 / {{characters}} 字符',
  'usage_stats.state_shape_unobserved': '未观测',
  'usage_stats.state_shape_comparison': '实际 {{observed}}，目标 {{expected}}',
  'usage_stats.request_events_state_check_reason_block_mismatch': '块数不符',
  'usage_stats.request_events_state_check_reason_expired': '已过期',
  'usage_stats.request_events_state_check_reason_unknown': '未知原因（{{code}}）',
};

const translate = (key: string, params?: Record<string, unknown>) => {
  const template = STRINGS[key] ?? key;
  if (!params) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(params[name] ?? ''));
};

vi.mock('@/lib/api', () => ({
  fetchTurnStateOverview: vi.fn(),
  fetchModelSubstitution: vi.fn(),
  ApiError: class extends Error { constructor(message: string, public status: number) { super(message); } },
}));
vi.mock('react-chartjs-2', () => ({ Chart: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }));

afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const NOW = fixture.server_time;

const render = async (overrides: Partial<TurnStateOverview> = {}, substitution?: unknown) => {
  vi.mocked(fetchTurnStateOverview).mockResolvedValue({ ...fixture, ...overrides } as unknown as TurnStateOverview);
  vi.mocked(fetchModelSubstitution).mockResolvedValue(substitution as never);
  vi.mocked(fetchModelSubstitution).mockClear();
  const node = document.createElement('div');
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = createRoot(node);
  await act(async () => root.render(<TurnStatePanel />));
  return { node, root };
};

const configRow = (node: HTMLElement, key: string) =>
  [...node.querySelectorAll('[data-turn-state-config] tbody tr')]
    .find((row) => row.querySelector('th')?.textContent?.includes(key));

const event = (overrides: Record<string, unknown>) => ({
  id: 'evt', at: NOW, entry_id: 'acct', model: 'gpt-6-astra', source: 'active', action: 'reject',
  result: 'block_mismatch', length: null, blocks: null, reason: 'block_mismatch',
  observed_blocks: 11, expected_blocks: 10, route_id: null, usage: null,
  ...overrides,
});

const session = (overrides: Record<string, unknown>) => ({ ...fixture.sessions[0], ...overrides });

it('keeps the contract §1 block order', async () => {
  const payload = {
    schema: 'cpa-usage-keeper.turn-state-model-mismatch.v1', range: '24h',
    window_start: '2026-09-21T00:00:00Z', window_end: '2026-09-22T00:00:00Z', bucket_seconds: 3600,
    summary: { requests_with_model: 1, matched: 0, mismatched: 1, match_rate: 0, empty: false,
      top_substitution: { from: 'gpt-6-astra', to: 'gpt-5.6-luna', count: 1 } },
    series: [], matrix: [], substitutions: [], truncated: false,
    current: [{ requested_model: 'gpt-6-astra', upstream_model: 'gpt-5.6-luna', matched: false,
      observed_at: NOW, age_seconds: 30, state_check: null, state_check_reason: null,
      state_check_observed_blocks: null, state_check_expected_blocks: null, account_entry_id: null }],
  };
  const { node, root } = await render({ events: [event({})] }, payload);
  // 模型替换观测（含内部“最近观测”表）→ 标题/状态 → 结论卡 → 配置表 → 会话 → 事件。
  const heading = (text: string) => [...node.querySelectorAll('h3')].find((item) => item.textContent === text);
  const markers = [
    heading('模型替换观测'),
    node.querySelector('[data-model-subscription-current]'),
    node.querySelector('[data-turn-state-status]'),
    heading('可用 State'),
    node.querySelector('[data-turn-state-config]'),
    heading('账号模型 State'),
    heading('最近事件'),
  ];
  expect(markers.every(Boolean)).toBe(true);
  for (let index = 1; index < markers.length; index++) {
    expect(markers[index - 1]!.compareDocumentPosition(markers[index]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }
  await act(async () => root.unmount());
});

it('shows every config row as a human state word, never a translation key or 主开关', async () => {  const { node, root } = await render({
    config: { ...fixture.config, enabled: true, mode: 'observe', passive_enabled: false, active_enabled: true, account_mode: 'auto' },
  });
  const experiment = configRow(node, '实验总开关');
  expect(experiment).toBeTruthy();
  expect(experiment!.textContent).toContain('已开启');
  expect(experiment!.querySelector('[data-config-value="on"]')).not.toBeNull();
  expect(configRow(node, '被动采集')!.textContent).toContain('未开启');
  expect(configRow(node, '主动探测')!.querySelector('[data-config-value="on"]')).not.toBeNull();
  expect(configRow(node, '注入模式')!.textContent).toContain('仅观察');
  // 规则必须整体显示 plan + 形状，并标出自动识别来源。
  const rule = configRow(node, '当前 State 规则')!;
  expect(rule.textContent).toContain('Personal · 10 块 / 292 字符');
  expect(rule.textContent).toContain('自动识别');  // 页面任何位置都不允许出现翻译 key 或“主开关”。
  expect(node.textContent).not.toContain('turn_state.');
  expect(node.textContent).not.toContain('主开关');
  expect(node.textContent).not.toContain('usage_stats.');
  await act(async () => root.unmount());
});

it('switches the config table to Team 12 blocks / 332 chars and marks a manual override', async () => {
  const { node, root } = await render({ config: { ...fixture.config, enabled: true, account_mode: 'team' } });
  const rule = configRow(node, '当前 State 规则')!;
  const value = rule.querySelector('[data-config-value]')!;
  expect(value.textContent).toContain('Team · 12 块 / 332 字符');
  // 手动 override 不得再标“自动识别”（帮助列文案不参与这个断言）。
  expect(value.textContent).not.toContain('自动识别');
  expect(rule.getAttribute('data-config-value')).toBeNull();
  await act(async () => root.unmount());
});

it('renders the observed/expected shape as one unit and never a placeholder dash shape', async () => {
  const { node, root } = await render({
    sessions: [session({ phase: 'collecting', last_observed_at: NOW, last_result: 'block_mismatch',
      last_failure: { code: 'block_mismatch', reason: 'block_mismatch', verdict: 'shape_mismatch', observed_blocks: 11, expected_blocks: 10 } })],
    summary: { ...fixture.summary, active_probes: 6, rejected_probes: 6 },
    events: [event({})],
  });
  const failure = node.querySelector('[data-turn-state-failure]');
  expect(failure?.textContent).toContain('实际 11 块 / 312 字符，目标 10 块 / 292 字符');
  expect(node.textContent).not.toContain('- 块');
  expect(node.textContent).not.toContain('- 字符');
  await act(async () => root.unmount());
});

it('uses 未观测 instead of a dash shape when a failure carries no block counts', async () => {
  const { node, root } = await render({
    sessions: [session({ phase: 'empty', last_result: 'no_state', last_failure: { code: 'no_state', reason: null, verdict: 'no_state', observed_blocks: null, expected_blocks: null } })],
  });
  expect(node.querySelector('[data-turn-state-failure]')?.textContent).toContain('上游没有返回 State');
  expect(node.textContent).not.toContain('未观测 块');
  await act(async () => root.unmount());
});

it('never leaves a nested interpolation remnant in the UI', async () => {
  const { node, root } = await render({
    sessions: [session({ phase: 'collecting', last_failure: { code: 'block_mismatch', reason: 'block_mismatch', verdict: 'shape_mismatch', observed_blocks: 11, expected_blocks: 10 } })],
    events: [event({}), event({ id: 'e2', result: 'accepted_model_mismatch', action: 'accept', upstream_model: 'gpt-5.6-luna' })],
  });
  expect(node.textContent).not.toContain('{{');
  expect(node.textContent).not.toContain('}}');
  await act(async () => root.unmount());
});

it('marks an unsupported or excluded session as 不适用 with the reason', async () => {
  const { node, root } = await render({
    sessions: [session({ phase: 'unsupported', excluded: true, model: 'codex-auto-review' })],
  });
  const card = node.querySelector('article')!;
  expect(card.textContent).toContain('不适用');
  expect(card.textContent).toContain('该模型已排除主动探测');
  // 排除的模型不能再展示探测相关字段。
  expect(card.textContent).not.toContain('最近探测');
  await act(async () => root.unmount());
});

it('renders only conclusion-bearing events, hiding dispatched and reused-socket noise', async () => {
  const { node, root } = await render({
    events: [
      event({ id: 'dispatch', action: 'probe', result: 'dispatched', observed_blocks: null }),
      event({ id: 'reused', action: 'skip', result: 'ws_connection_reused', observed_blocks: null, reason: null }),
      event({ id: 'real' }),
    ],
    sessions: [session({ ws_connection_reused: 5 })],
  });
  const events = [...node.querySelectorAll('article')].filter((article) => article.querySelector('time'));
  expect(events).toHaveLength(1);
  expect(events[0].textContent).toContain('State 形状不符');
  // 复用连接改由会话卡计数承载。
  expect(node.textContent).toContain('复用已有连接');
  expect(node.textContent).toContain('5');
  await act(async () => root.unmount());
});

it('shows the whole shape, both models and the usage units on an event', async () => {
  const { node, root } = await render({
    events: [event({ upstream_model: 'gpt-5.6-luna', usage: { input_tokens: 16, output_tokens: 5, reasoning_tokens: 0 } })],
  });
  const article = [...node.querySelectorAll('article')].find((item) => item.querySelector('time'))!;
  expect(article.textContent).toContain('实际 11 块 / 312 字符，目标 10 块 / 292 字符');
  expect(article.textContent).toContain('请求模型');
  expect(article.textContent).toContain('gpt-6-astra');
  expect(article.textContent).toContain('实际模型');
  expect(article.textContent).toContain('gpt-5.6-luna');
  expect(article.textContent).toContain('探测用量');
  expect(article.textContent).toContain('输入 16');
  expect(article.textContent).toContain('输出 5');
  await act(async () => root.unmount());
});

it('renders an old payload without the newer fields instead of crashing', async () => {
  // 旧 proxy：session 没有 excluded/last_failure/last_upstream_model，event 没有 upstream_model/verdict。
  const { node, root } = await render({
    sessions: [session({ phase: 'observing' })],
    events: [event({ result: 'missing_state', reason: null, observed_blocks: null, expected_blocks: null })],
    config: { ...fixture.config, enabled: true, passive_enabled: true, active_enabled: true, account_mode: 'personal' },
  });
  expect(node.textContent).toContain('模型质量');
  expect(node.textContent).not.toContain('undefined');
  expect(node.textContent).not.toContain('NaN');
  // 旧载荷中 account_mode=personal 也要显示成人类规则。
  expect(configRow(node, '当前 State 规则')!.textContent).toContain('Personal · 10 块 / 292 字符');
  await act(async () => root.unmount());
});

it('shows only present diagnostics and no 未知 placeholder rows', async () => {
  const { node, root } = await render({
    sessions: [session({ phase: 'usable', diagnostic: 'block_mismatch',
      active: { usable: true, length: 292, blocks: 10, version: 1, fingerprint: 'abcdef012345', issued_at: NOW, expires_at: '2026-09-22T01:00:00Z', route_id: 'route-1' } })],
  });
  const details = node.querySelector('article details')!;
  expect(details.textContent).toContain('账号条目 ID');
  expect(details.textContent).toContain('线路 ID');
  expect(details.textContent).toContain('State 指纹');
  expect(details.textContent).toContain('原始诊断码');
  // 有 active 时形状必须整体出现，且带 remaining。
  expect(node.textContent).toContain('10 块 / 292 字符');
  await act(async () => root.unmount());
});

it('keeps the overview cards honest when nothing is ready or injected', async () => {
  const { node, root } = await render({ summary: { ...fixture.summary, usable: 0, sessions: 2, ready: 0, injection_count: 0 } });
  expect(node.textContent).toContain('当前没有可注入的状态');
  expect(node.textContent).toContain('暂无就绪会话');
  // §2 第三张卡是模型替换（无数据时说明暂无替换记录），不再是注入次数。
  expect(node.textContent).toContain('暂无替换记录');
  await act(async () => root.unmount());
});

it('surfaces the latest probe failure on the conclusion card with its whole shape', async () => {
  const { node, root } = await render({
    sessions: [session({ phase: 'collecting', last_result: 'block_mismatch', last_failure: { code: 'block_mismatch', reason: 'block_mismatch', verdict: 'shape_mismatch', observed_blocks: 11, expected_blocks: 10 } })],
    summary: { ...fixture.summary, active_probes: 6, rejected_probes: 6 },
  });
  const note = node.querySelector('[data-turn-state-latest-failure]');
  expect(note?.textContent).toContain('实际 11 块 / 312 字符，目标 10 块 / 292 字符');
  await act(async () => root.unmount());
});
