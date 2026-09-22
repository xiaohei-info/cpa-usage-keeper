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
  'turn_state.config_fallback': '没有可用状态时',
  'turn_state.config_fallback_help': '没有可用状态时，决定继续发送还是拒绝请求',
  'turn_state.config_fallback_pass': '照常发送',
  'turn_state.config_fallback_strict': '拒绝请求',
  'turn_state.config_harvest_proxy': '采集出口',
  'turn_state.config_harvest_proxy_help': '用于获取状态的代理；留空表示使用默认业务出口',
  'turn_state.config_default_route': '默认业务出口',
  'turn_state.config_custom_route': '专用采集代理',
  'turn_state.config_revalidate': '采集后复验',
  'turn_state.config_revalidate_help': '重放采集到的状态，确认上游接受后再信任',
  'turn_state.config_mismatch': '模型不一致',
  'turn_state.config_mismatch_help': '模型不一致时是否仍视为成功',
  'turn_state.config_mismatch_success': '算作成功',
  'turn_state.config_mismatch_failure': '算作失败',
  'turn_state.config_ttl': '状态有效期',
  'turn_state.config_ttl_help': '状态在多长时间内保持有效',
  'turn_state.config_refresh': '提前刷新',
  'turn_state.config_refresh_help': '距离到期还有多久时开始重新采集',
  'turn_state.config_timeout': '采集超时',
  'turn_state.config_timeout_help': '单次采集最多等待时间',
  'turn_state.config_cooldown': '采集冷却',
  'turn_state.config_cooldown_help': '失败后再次尝试前等待时间',
  'turn_state.config_attempts': '每轮尝试次数',
  'turn_state.config_attempts_help': '一次采集最多发起几次请求',
  'turn_state.config_revoke': '连续失败后丢弃',
  'turn_state.config_revoke_help': '连续失败几次后丢弃已保存状态',
  'turn_state.config_seconds': '{{value}} 秒',
  'turn_state.config_count': '{{value}} 次',
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
  'turn_state.sessions': '账号模型 State',
  'turn_state.config': '配置状态',
  'turn_state.relative_just_now': '刚刚',
  'turn_state.relative_minutes_ago': '{{count}} 分钟前',
  // fixture 的 server_time 是固定过去时刻，跑得越晚越会走到小时/天分支；
  // 缺这两个键会让“不得出现 turn_state. 前缀”的断言随运行时间变成假失败。
  'turn_state.relative_hours_ago': '{{count}} 小时前',
  'turn_state.relative_days_ago': '{{count}} 天前',
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
  'turn_state.overview_probes': '主动采集',
  'turn_state.overview_last_hour': '过去 1 小时 {{count}} 次',
  'turn_state.overview_since': '累计自 {{time}}',
  'turn_state.event_ticket_verified': '主动采集成功，已保存可用状态',
  'turn_state.event_ticket_model_mismatch': '上游返回的模型不一致，采集失败',
  'turn_state.event_ticket_unverified': '尚未采集到可用状态',
  'turn_state.event_ticket_revoked': '已采集的状态被上游拒绝',
  'turn_state.event_ticket_revalidating': '正在复验已采集的状态',
  'turn_state.event_ticket_expired': '已采集的状态已过期',
  'turn_state.event_ticket_no_candidate': '上游没有返回可用状态',
  'turn_state.event_ticket_target_mismatch': '采集到的状态形状与目标不符',
  'turn_state.event_ticket_model_unknown': '上游没有返回模型名，状态无法确认',
  'turn_state.event_ticket_revalidation_failed': '复验失败，已采集的状态不可用',
  'turn_state.event_ticket_revalidation_required': '已采集的状态需要复验后才能使用',
  'turn_state.event_reused_ws': '复用了已有连接，未写入状态',
  'turn_state.overview_observed': '被动采集',
  'turn_state.overview_capture_split': '成功 {{accepted}} 次 · 未通过 {{rejected}} 次',
  'turn_state.overview_capture_none': '尚无采集记录',
  'turn_state.last_updated': '最近更新 {{time}}',
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
  expect(configRow(node, '没有可用状态时')!.textContent).toContain('照常发送');
  expect(configRow(node, '采集出口')!.textContent).toContain('默认业务出口');
  expect(configRow(node, '采集后复验')!.textContent).toContain('暂无');
  expect(configRow(node, '模型不一致')!.textContent).toContain('暂无');
  expect(configRow(node, '状态有效期')!.textContent).toContain('3600');
  expect(configRow(node, '连续失败后丢弃')!.textContent).toContain('暂无');
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

it('dates each capture card from its own events, not from the injection timestamp', async () => {
  // 仅观察模式下从不注入，last_injected_at 恒为空；主动探测卡必须用最近一次探测事件的时间。
  const { node, root } = await render({
    sessions: [session({ last_observed_at: null, last_injected_at: null })],
    summary: { ...fixture.summary, active_probes: 3, passive_observations: 5 },
    events: [
      { id: 'p1', at: NOW, entry_id: 'acct', model: 'gpt-6-astra', source: 'passive', action: 'reject', result: 'block_mismatch', length: null, blocks: null, reason: 'block_mismatch', observed_blocks: 11, expected_blocks: 10, route_id: null, usage: null },
      { id: 'a1', at: NOW, entry_id: 'acct', model: 'gpt-6-astra', source: 'active', action: 'reject', result: 'incomplete', length: null, blocks: null, reason: null, observed_blocks: null, expected_blocks: null, route_id: null, usage: null },
    ],
  });
  const text = node.textContent ?? '';
  // 两张卡都必须给出时间（STRINGS 把 last_updated 译成“最近更新 {{time}}”），不能是“暂无”。
  expect((text.match(/最近更新/g) ?? []).length).toBe(2);
  expect(text).not.toContain('最近更新 暂无');
  await act(async () => root.unmount());
});

it('does not show the non-terminal dispatched event as an unknown failure', async () => {
  const { node, root } = await render({
    events: [
      event({ id: 'dispatch', action: 'probe', result: 'dispatched', observed_blocks: null, reason: null }),
      event({ id: 'accepted', action: 'accept', result: 'accepted', observed_blocks: 10, expected_blocks: 10, reason: null }),
    ],
  });
  expect(node.querySelector('[data-turn-state-active-failure]')).toBeNull();
  expect(node.textContent).not.toContain('未知原因（dispatched）');
  await act(async () => root.unmount());
});

it('no longer renders an events timeline but keeps the reused-connection counter', async () => {
  // 事件时间线对用户没有可操作价值，已整体移除；复用连接计数仍由会话卡承载。
  const { node, root } = await render({
    events: [
      event({ id: 'dispatch', action: 'probe', result: 'dispatched', observed_blocks: null }),
      event({ id: 'reused', action: 'skip', result: 'ws_connection_reused', observed_blocks: null, reason: null }),
      event({ id: 'real' }),
    ],
    sessions: [session({ ws_connection_reused: 5 })],
  });
  expect(node.textContent).not.toContain('最近事件');
  // 复用连接计数仍由会话卡承载。
  expect(node.textContent).toContain('复用已有连接');
  expect(node.textContent).toContain('5');
  const timestamps = [...node.querySelectorAll('article time')];
  expect(timestamps).toHaveLength(0);
  await act(async () => root.unmount());
});

it('shows the failed rule and the whole shape on the session card instead of an event row', async () => {
  const { node, root } = await render({
    sessions: [session({
      phase: 'collecting', last_result: 'block_mismatch',
      last_failure: { code: 'block_mismatch', reason: 'block_mismatch', verdict: 'shape_mismatch', observed_blocks: 11, expected_blocks: 10 },
    })],
  });
  const failure = node.querySelector('[data-turn-state-failure]');
  expect(failure).not.toBeNull();
  expect(failure!.textContent).toContain('实际 11 块 / 312 字符，目标 10 块 / 292 字符');
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

it('surfaces each capture card failure from its own source, never the other one', async () => {
  // last_failure 是两种来源共用的最后一个结果；结论卡必须按事件来源取，否则会把主动探测的失败
  // 显示成被动采集的问题。
  const { node, root } = await render({
    sessions: [session({ phase: 'collecting', last_result: 'block_mismatch', last_failure: { code: 'block_mismatch', reason: 'block_mismatch', verdict: 'shape_mismatch', observed_blocks: 11, expected_blocks: 10 } })],
    summary: { ...fixture.summary, active_probes: 6, rejected_probes: 6, passive_observations: 30, passive_accepted: 0, passive_rejected: 30 },
    events: [
      { id: 'p1', at: NOW, entry_id: 'acct', model: 'gpt-6-astra', source: 'passive', action: 'reject', result: 'block_mismatch', length: null, blocks: null, reason: 'block_mismatch', observed_blocks: 11, expected_blocks: 10, route_id: null, usage: null },
      { id: 'a1', at: NOW, entry_id: 'acct', model: 'gpt-6-astra', source: 'active', action: 'reject', result: 'no_state', length: null, blocks: null, reason: null, observed_blocks: null, expected_blocks: null, route_id: null, usage: null },
    ],
  });
  // 被动采集卡说明形状不符并给出完整形状。
  const passiveNote = node.querySelector('[data-turn-state-passive-failure]');
  expect(passiveNote).not.toBeNull();
  expect(passiveNote!.textContent).toContain('实际 11 块 / 312 字符，目标 10 块 / 292 字符');
  // 主动探测卡说明它自己的失败原因，不能复用被动采集的那条。
  const activeNote = node.querySelector('[data-turn-state-active-failure]');
  expect(activeNote).not.toBeNull();
  expect(activeNote!.textContent).toContain('上游没有返回 State');
  expect(activeNote!.textContent).not.toContain('11 块');
  await act(async () => root.unmount());
});

it('shows the merged active-collection counters when the proxy reports them', async () => {
  // generic probe (active_probes=0) + ticket harvest (12 attempts) 合并后必须显示 12，而不是 0。
  const { node, root } = await render({
    summary: { ...fixture.summary, active_probes: 0, accepted_probes: 0, rejected_probes: 0,
      active_attempts: 13, active_accepted: 1, active_rejected: 12 },
  });
  const card = [...node.querySelectorAll('h3')].find((item) => item.textContent === '主动采集')?.closest('.card');
  expect(card).toBeTruthy();
  expect(card!.textContent).toContain('13');
  expect(card!.textContent).toContain('成功 1 次 · 未通过 12 次');
  await act(async () => root.unmount());
});

it('falls back to active_probes when the proxy predates the merged counters', async () => {
  // 旧 proxy 不返回 active_attempts：卡片必须回退，绝不能显示成 0 次采集。
  const { node, root } = await render({
    summary: { ...fixture.summary, active_probes: 7, accepted_probes: 2, rejected_probes: 5 },
  });
  const card = [...node.querySelectorAll('h3')].find((item) => item.textContent === '主动采集')?.closest('.card');
  expect(card!.textContent).toContain('7');
  expect(card!.textContent).toContain('成功 2 次 · 未通过 5 次');
  await act(async () => root.unmount());
});

it('shows the rolling hourly dispatch rate when the proxy reports it', async () => {
  // 累计数回答不了"现在跑多快"；实时速率行是用户把控消耗的唯一数字。
  const { node, root } = await render({
    summary: { ...fixture.summary, active_attempts: 13, active_accepted: 1, active_rejected: 12, active_last_hour: 7 },
  });
  const rate = node.querySelector('[data-turn-state-active-last-hour]');
  expect(rate).not.toBeNull();
  expect(rate!.textContent).toBe('过去 1 小时 7 次');
  await act(async () => root.unmount());
});

it('omits the hourly rate row entirely on a proxy that does not report it', async () => {
  // 旧 proxy 无该字段：整行不渲染，绝不退化成 "过去 1 小时 0 次"。
  const { node, root } = await render({
    summary: { ...fixture.summary, active_attempts: 13, active_accepted: 1, active_rejected: 12 },
  });
  expect(node.querySelector('[data-turn-state-active-last-hour]')).toBeNull();
  expect(node.textContent).not.toContain('过去 1 小时');
  await act(async () => root.unmount());
});

it('attributes a ticket-collection failure to the active card, never the passive one', async () => {
  // ticket 事件过去被来源筛选整份忽略，自动采集失败因此完全不可见。
  const { node, root } = await render({
    summary: { ...fixture.summary, active_attempts: 4, active_accepted: 0, active_rejected: 4, passive_observations: 2, passive_rejected: 2 },
    events: [
      event({ id: 't1', source: 'ticket', action: 'harvest', result: 'ticket_model_mismatch', reason: 'ticket_model_mismatch', observed_blocks: null, expected_blocks: null }),
    ],
  });
  const activeNote = node.querySelector('[data-turn-state-active-failure]');
  expect(activeNote).not.toBeNull();
  expect(activeNote!.textContent).toContain('上游返回的模型不一致，采集失败');
  expect(activeNote!.textContent).not.toContain('未知原因');
  expect(node.querySelector('[data-turn-state-passive-failure]')).toBeNull();
  await act(async () => root.unmount());
});

it('renders the cumulative start only when the proxy reports it', async () => {
  const withSince = await render({ summary: { ...fixture.summary, active_attempts: 3, since: NOW } });
  const line = withSince.node.querySelector('[data-turn-state-active-since]');
  expect(line).not.toBeNull();
  expect(line!.textContent).toContain('累计自');
  await act(async () => withSince.root.unmount());

  // 旧 proxy 无 since：不得渲染这一行，也不得编造时间。
  const withoutSince = await render({ summary: { ...fixture.summary, active_attempts: 3 } });
  expect(withoutSince.node.querySelector('[data-turn-state-active-since]')).toBeNull();
  expect(withoutSince.node.textContent).not.toContain('累计自');
  await act(async () => withoutSince.root.unmount());
});
