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
  'turn_state.merged_help': '合并总表说明',
  'turn_state.merged_account': '账号',
  'turn_state.merged_model': '模型',
  'turn_state.merged_upstream': '上游实际模型',
  'turn_state.merged_last_observed': '最近观测',
  'turn_state.merged_state_shape': 'State 形状',
  'turn_state.merged_requests': '请求',
  'turn_state.merged_mismatch_rate': '被替换',
  'turn_state.merged_degraded_rate': '可能降智',
  'turn_state.merged_current_state': 'State',
  'turn_state.merged_expires': '剩余有效期',
  'turn_state.merged_next_probe': '下次采集',
  'turn_state.merged_injected': '注入',
  'turn_state.merged_passive': '被动',
  'turn_state.merged_active': '主动',
  'turn_state.merged_cumulative': '累计',
  'turn_state.merged_state_check_split': '已检查 {{observed}} · 未通过 {{failed}}',
  'turn_state.merged_timeouts': '超时 {{count}} 次',
  'turn_state.merged_minutes_left': '{{count}} 分钟',
  'turn_state.merged_state_ready': '就绪（{{shape}}）',
  'turn_state.merged_state_unobserved': '未上报',
  'turn_state.merged_group_observation': '观测',
  'turn_state.merged_group_state': 'State',
  'turn_state.merged_group_collection': '采集执行',
  'turn_state.merged_range_current': '当前',
  'turn_state.merged_empty': '最近范围内没有账号模型观测',
  'turn_state.merged_unnamed_account': '未命名账号',
  'turn_state.merged_polling': '页面打开时每 30 秒自动刷新一次。',
  'turn_state.relative_seconds_ago': '{{count}} 秒前',
  'turn_state.model_sub_trend_title': '模型替换趋势',

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


/** 合并总表行：只有显式给出的字段非默认，其余按“未观测/无样本”中性缺省。 */
const currentRow = (overrides: Record<string, unknown>) => ({
  requested_model: 'gpt-6-astra',
  upstream_model: '',
  matched: false,
  observed_at: NOW,
  observed: false,
  age_seconds: 0,
  state_check: null,
  state_check_reason: null,
  state_check_observed_blocks: null,
  state_check_expected_blocks: null,
  account_entry_id: 'acct-1',
  account_name: null,
  request_count: 0,
  mismatched: 0,
  mismatch_rate: null,
  state_check_observed: 0,
  state_check_failed: 0,
  state_check_failure_rate: null,
  probe_attempts: 0,
  probe_accepted: 0,
  probe_rejected: 0,
  probe_timeouts: 0,
  ...overrides,
});

/** 模型替换接口的最小合法载荷；overrides 用来塞入合并总表行。 */
const emptySubstitutionPayload = () => ({
  schema: 'cpa-usage-keeper.turn-state-model-mismatch.v1',
  range: '24h',
  window_start: '2026-09-21T00:00:00Z',
  window_end: '2026-09-22T00:00:00Z',
  bucket_seconds: 3600,
  summary: { requests_with_model: 0, matched: 0, mismatched: 0, match_rate: null, empty: true, top_substitution: null },
  series: [], matrix: [], substitutions: [], current: [], truncated: false,
});

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
    current: [currentRow({ upstream_model: 'gpt-5.6-luna', matched: false, observed: true, age_seconds: 30, account_entry_id: null })],
  };
  const { node, root } = await render({ events: [event({})] }, payload);
  // 合并后的页面结构：标题/状态 → 合并总表 → 配置表 → 历史趋势标题。
  const heading = (text: string) => [...node.querySelectorAll('h3')].find((item) => item.textContent === text);
  // 顺序：大盘（状态 + 合并总表）→ 历史趋势 → 配置状态。
  const markers = [
    node.querySelector('[data-turn-state-status]'),
    node.querySelector('[data-turn-state-merged-table]'),
    heading('模型替换趋势'),
    node.querySelector('[data-turn-state-config]'),
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
  // 合并总表把 state 形状放在同一行里：实际/目标必须整体出现（块数与字符数成对）。
  const { node, root } = await render({}, {
    ...emptySubstitutionPayload(),
    current: [currentRow({ state_check: 'shape_mismatch', state_check_reason: 'block_mismatch',
      state_check_observed_blocks: 11, state_check_expected_blocks: 10 })],
  });
  const cell = node.querySelector('[data-merged-state]');
  expect(cell?.textContent).toContain('实际 11 块 / 312 字符，目标 10 块 / 292 字符');
  expect(node.textContent).not.toContain('- 块');
  expect(node.textContent).not.toContain('- 字符');
  await act(async () => root.unmount());
});

it('uses 未上报 instead of inventing a shape when the upstream reported no state', async () => {
  const { node, root } = await render({}, {
    ...emptySubstitutionPayload(),
    current: [currentRow({ state_check: null, state_check_reason: null })],
  });
  expect(node.querySelector('[data-merged-state]')?.textContent).toContain('未上报');
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

it('shows an未就绪 State for the account-model row instead of claiming readiness', async () => {
  // 没有 active state 的行必须说“尚未就绪”，不能因为行存在就显示成可用。
  // 行键必须与 session 的 entry_id + model 对得上，否则两边的“同一行”判断会失效。
  const { node, root } = await render({
    sessions: [session({ entry_id: 'acct-1', model: 'gpt-6-astra', phase: 'empty', active: null, ready: null })],
  }, {
    ...emptySubstitutionPayload(),
    current: [currentRow({ account_entry_id: 'acct-1', requested_model: 'gpt-6-astra' })],
  });
  const row = node.querySelector('[data-turn-state-merged-table] tbody tr')!;
  // STRINGS 把 state_unavailable 译成“无可用状态”；关键是绝不能显示成已就绪。
  expect(row.textContent).toContain('无可用状态');
  expect(row.textContent).not.toContain('可注入');
  await act(async () => root.unmount());
});

it('carries the failed rule and the whole shape on the merged table row', async () => {
  const { node, root } = await render({}, {
    ...emptySubstitutionPayload(),
    current: [currentRow({ state_check: 'shape_mismatch', state_check_reason: 'block_mismatch',
      state_check_observed_blocks: 11, state_check_expected_blocks: 10 })],
  });
  const cell = node.querySelector('[data-merged-state]');
  expect(cell).not.toBeNull();
  expect(cell!.textContent).toContain('实际 11 块 / 312 字符，目标 10 块 / 292 字符');
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

it('shows the resolved account name and falls back to the id prefix', async () => {
  // 有 account_name 时用它；没有时用 id 前 8 位，两者都不能显示成空单元格。
  const { node, root } = await render({}, {
    ...emptySubstitutionPayload(),
    current: [
      currentRow({ account_name: 'xiaohei.info@gmail.com', account_entry_id: 'd0f784113bd9d041' }),
      currentRow({ requested_model: 'gpt-5.6-luna', account_name: null, account_entry_id: '864277fc6d9299dc' }),
    ],
  });
  expect(node.textContent).toContain('xiaohei.info@gmail.com');
  expect(node.textContent).toContain('864277fc');
  await act(async () => root.unmount());
});

it('merges the model-quality dashboards: no separate conclusion cards remain', async () => {
  // 可用状态/主动采集/被动采集/当前账号会话四张卡与合并总表信息重复，已整体移除。
  const { node, root } = await render({ summary: { ...fixture.summary, usable: 3, sessions: 2, ready: 2, injection_count: 9 } });
  for (const removed of ['turn_state.overview_ready', 'turn_state.overview_probes', 'turn_state.overview_observed', 'turn_state.overview_sessions', 'turn_state.overview_substitution']) {
    expect(node.textContent).not.toContain(removed);
  }
  // 合并总表仍在，并且账号 x 模型的汇总仍在配置表之前。
  expect(node.querySelector('[data-turn-state-merged-table]')).not.toBeNull();
  expect(node.querySelector('[data-turn-state-config]')).not.toBeNull();
  await act(async () => root.unmount());
});

it('keeps collection data on the merged row instead of a duplicate card', async () => {
  const { node, root } = await render(
    { sessions: [session({ entry_id: 'acct-1', model: 'gpt-6-astra', injection_count: 7, observation_count: 10, ticket_round_count: 4 })] },
    { ...emptySubstitutionPayload(), current: [currentRow({ probe_attempts: 8, probe_accepted: 5, probe_rejected: 3, probe_timeouts: 1, state_check_observed: 10, state_check_failed: 4 })] },
  );
  const rowText = node.querySelector('[data-turn-state-merged-table] tbody tr')!.textContent ?? '';
  expect(rowText).toContain('7');
  expect(rowText).toContain('10');
  expect(rowText).toContain('4');
  await act(async () => root.unmount());
});
