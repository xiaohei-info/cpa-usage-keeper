export interface TurnStateOverview {
  schema: string;
  server_time: string;
  epoch: string;
  config: TurnStateConfig;
  summary: TurnStateCounters;
  sessions: TurnStateSession[];
  events: TurnStateEvent[];
}
export interface TurnStateConfig {
  enabled: boolean;
  passive_enabled: boolean;
  active_enabled: boolean;
  mode: string;
  fallback: string;
  account_mode: string;
  ttl_seconds: number;
  refresh_before_seconds: number;
  probe_timeout_seconds: number;
  cooldown_seconds: number;
  max_attempts_per_round: number;
  /** Additive fields from the flattened proxy config; absent on older proxies. */
  harvest_proxy_url?: string | null;
  revalidate?: boolean | null;
  mismatch_is_success?: boolean | null;
  revoke_after_signals?: number | null;
}
export interface TurnStateCounters {
  sessions: number;
  usable: number;
  ready: number;
  collecting: number;
  expired: number;
  blocked: number;
  injection_count: number;
  passive_observations: number;
  /** 可加性字段：被动采集尝试按结果拆分，旧 proxy 不返回。 */
  passive_accepted?: number | null;
  passive_rejected?: number | null;
  active_probes: number;
  accepted_probes: number;
  rejected_probes: number;
}
export interface TurnStateSession {
  entry_id: string;
  model: string;
  account_mode: string;
  phase: string;
  account_label: string | null;
  diagnostic: string | null;
  last_observed_at: string | null;
  last_injected_at: string | null;
  next_probe_at: string | null;
  active: TurnStateSummary | null;
  ready: TurnStateSummary | null;
  injection_count: number;
  observation_count: number;
  probe_count: number;
  strikes: number;
  /** 以下为可加性字段（契约 §8.2）；旧 proxy 不返回时必须仍可渲染。 */
  excluded?: boolean;
  last_upstream_model?: string | null;
  model_mismatch?: boolean;
  last_result?: string | null;
  last_failure?: TurnStateFailure | null;
  ws_connection_reused?: number;
  plan_provenance?: string | null;
}
/** 最近一次未通过的探测/观测形状；仅在失败时由 proxy 填充。 */
export interface TurnStateFailure {
  code: string;
  reason: string | null;
  verdict: string | null;
  observed_blocks: number | null;
  expected_blocks: number | null;
}
export interface TurnStateSummary {
  usable: boolean;
  length: number;
  blocks: number;
  version: number;
  fingerprint: string;
  issued_at: string;
  expires_at: string;
  route_id: string | null;
}
export interface TurnStateEvent {
  id: string;
  at: string;
  source: string;
  action: string;
  result: string;
  entry_id: string | null;
  model: string | null;
  route_id: string | null;
  length: number | null;
  blocks: number | null;
  /** 拒绝时第一条未通过的规则码；无失败规则时为 null。 */
  reason: string | null;
  /** 候选 state 的块数形状，用于解释 block_mismatch。 */
  observed_blocks: number | null;
  expected_blocks: number | null;
  /** 可加性字段（契约 §8.3）：该次观测实际得到的上游模型与判定。 */
  upstream_model?: string | null;
  verdict?: string | null;
  usage: TurnStateUsage | null;
}
export interface TurnStateUsage {
  input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
}

const shapes: Record<string, Record<string, string>> = {"TurnStateOverview": {"schema": "string", "server_time": "string", "epoch": "string", "config": "TurnStateConfig", "summary": "TurnStateCounters", "sessions": "[]TurnStateSession", "events": "[]TurnStateEvent"}, "TurnStateConfig": {"enabled": "bool", "passive_enabled": "bool", "active_enabled": "bool", "mode": "string", "fallback": "string", "account_mode": "string", "ttl_seconds": "int64", "refresh_before_seconds": "int64", "probe_timeout_seconds": "int64", "cooldown_seconds": "int64", "max_attempts_per_round": "int64", "?harvest_proxy_url": "?*string", "?revalidate": "?bool", "?mismatch_is_success": "?bool", "?revoke_after_signals": "?int64"}, "TurnStateCounters": {"sessions": "int64", "usable": "int64", "ready": "int64", "collecting": "int64", "expired": "int64", "blocked": "int64", "injection_count": "int64", "passive_observations": "int64", "?passive_accepted": "?int64", "?passive_rejected": "?int64", "active_probes": "int64", "accepted_probes": "int64", "rejected_probes": "int64"}, "TurnStateSession": {"entry_id": "string", "model": "string", "account_mode": "string", "phase": "string", "account_label": "*string", "diagnostic": "*string", "last_observed_at": "*string", "last_injected_at": "*string", "next_probe_at": "*string", "active": "*TurnStateSummary", "ready": "*TurnStateSummary", "injection_count": "int64", "observation_count": "int64", "probe_count": "int64", "strikes": "int64", "?excluded": "?bool", "?last_upstream_model": "?*string", "?model_mismatch": "?bool", "?last_result": "?*string", "?last_failure": "?*TurnStateFailure", "?ws_connection_reused": "?int64", "?plan_provenance": "?*string"}, "TurnStateFailure": {"code": "string", "reason": "*string", "verdict": "*string", "observed_blocks": "*int64", "expected_blocks": "*int64"}, "TurnStateSummary": {"usable": "bool", "length": "int64", "blocks": "int64", "version": "int64", "fingerprint": "string", "issued_at": "string", "expires_at": "string", "route_id": "*string"}, "TurnStateEvent": {"id": "string", "at": "string", "source": "string", "action": "string", "result": "string", "entry_id": "*string", "model": "*string", "route_id": "*string", "length": "*int64", "blocks": "*int64", "?reason": "?*string", "?observed_blocks": "?*int64", "?expected_blocks": "?*int64", "?upstream_model": "?*string", "?verdict": "?*string", "usage": "*TurnStateUsage"}, "TurnStateUsage": {"input_tokens": "*int64", "output_tokens": "*int64", "reasoning_tokens": "*int64"}};

function valid(value: unknown, type: string, field = ''): boolean {
  if (type.startsWith('*')) return value === null || valid(value, type.slice(1), field);
  if (type.startsWith('[]')) return Array.isArray(value) && value.length <= (field === 'events' ? 200 : 1000) && value.every(item => valid(item, type.slice(2)));
  if (type === 'bool') return typeof value === 'boolean';
  if (type === 'int64') return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  if (type === 'string') {
    if (typeof value !== 'string' || value.length > 256 || /[\r\n\0]/.test(value)) return false;
    if (['server_time', 'at', 'issued_at', 'expires_at', 'last_observed_at', 'last_injected_at', 'next_probe_at'].includes(field)) return value.endsWith('Z') && Number.isFinite(Date.parse(value));
    // 码类字段（含契约 §8.2/§8.3 新增的 verdict/last_result/code）必须是合法码；
    // 非法码必须拒绝整份快照，而不是当成一个未知但可用的值。
    if (['phase', 'diagnostic', 'action', 'result', 'verdict', 'code', 'last_result'].includes(field)) return /^[a-z][a-z0-9_]{0,63}$/.test(value);
    if (field === 'plan_provenance') return ['account', 'override', 'assumed_personal'].includes(value);
    if (field === 'fingerprint') return /^[a-f0-9]{8,32}$/.test(value);
    const enums: Record<string, string[]> = { mode: ['off', 'observe', 'replace', 'always'], fallback: ['passthrough', 'strict'], account_mode: ['auto', 'personal', 'team'], source: ['passive', 'active', 'injection', 'lifecycle', 'ticket'] };
    return enums[field] ? enums[field].includes(value) : value.length > 0 || field === 'account_label';
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  // A '?' prefix on the key marks an additive field: absent is fine (older
  // producer), present must be valid. The prefix has to be stripped from BOTH
  // the lookup key and the type, otherwise the payload key is never found and a
  // present-but-invalid value would silently pass as "absent".
  return Object.entries(shapes[type]).every(([rawKey, child]) => {
    const optional = child.startsWith('?');
    const key = rawKey.startsWith('?') ? rawKey.slice(1) : rawKey;
    const expected = optional ? child.slice(1) : child;
    if (!Object.hasOwn(value, key)) return optional;
    return valid((value as Record<string, unknown>)[key], expected, key);
  });
}
export function isTurnStateOverview(value: unknown): value is TurnStateOverview {
  return valid(value, 'TurnStateOverview') && (value as TurnStateOverview).schema === 'codex-proxy.turn-state-overview.v1';
}
