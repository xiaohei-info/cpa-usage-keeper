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
  usage: TurnStateUsage | null;
}
export interface TurnStateUsage {
  input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
}

const shapes: Record<string, Record<string, string>> = {"TurnStateOverview": {"schema": "string", "server_time": "string", "epoch": "string", "config": "TurnStateConfig", "summary": "TurnStateCounters", "sessions": "[]TurnStateSession", "events": "[]TurnStateEvent"}, "TurnStateConfig": {"enabled": "bool", "passive_enabled": "bool", "active_enabled": "bool", "mode": "string", "fallback": "string", "account_mode": "string", "ttl_seconds": "int64", "refresh_before_seconds": "int64", "probe_timeout_seconds": "int64", "cooldown_seconds": "int64", "max_attempts_per_round": "int64"}, "TurnStateCounters": {"sessions": "int64", "usable": "int64", "ready": "int64", "collecting": "int64", "expired": "int64", "blocked": "int64", "injection_count": "int64", "passive_observations": "int64", "active_probes": "int64", "accepted_probes": "int64", "rejected_probes": "int64"}, "TurnStateSession": {"entry_id": "string", "model": "string", "account_mode": "string", "phase": "string", "account_label": "*string", "diagnostic": "*string", "last_observed_at": "*string", "last_injected_at": "*string", "next_probe_at": "*string", "active": "*TurnStateSummary", "ready": "*TurnStateSummary", "injection_count": "int64", "observation_count": "int64", "probe_count": "int64", "strikes": "int64"}, "TurnStateSummary": {"usable": "bool", "length": "int64", "blocks": "int64", "version": "int64", "fingerprint": "string", "issued_at": "string", "expires_at": "string", "route_id": "*string"}, "TurnStateEvent": {"id": "string", "at": "string", "source": "string", "action": "string", "result": "string", "entry_id": "*string", "model": "*string", "route_id": "*string", "length": "*int64", "blocks": "*int64", "usage": "*TurnStateUsage"}, "TurnStateUsage": {"input_tokens": "*int64", "output_tokens": "*int64", "reasoning_tokens": "*int64"}};

function valid(value: unknown, type: string, field = ''): boolean {
  if (type.startsWith('*')) return value === null || valid(value, type.slice(1), field);
  if (type.startsWith('[]')) return Array.isArray(value) && value.length <= (field === 'events' ? 200 : 1000) && value.every(item => valid(item, type.slice(2)));
  if (type === 'bool') return typeof value === 'boolean';
  if (type === 'int64') return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  if (type === 'string') {
    if (typeof value !== 'string' || value.length > 256 || /[\r\n\0]/.test(value)) return false;
    if (['server_time', 'at', 'issued_at', 'expires_at', 'last_observed_at', 'last_injected_at', 'next_probe_at'].includes(field)) return value.endsWith('Z') && Number.isFinite(Date.parse(value));
    if (['phase', 'diagnostic', 'action', 'result'].includes(field)) return /^[a-z][a-z0-9_]{0,63}$/.test(value);
    if (field === 'fingerprint') return /^[a-f0-9]{8,32}$/.test(value);
    const enums: Record<string, string[]> = { mode: ['off', 'observe', 'replace', 'always'], fallback: ['passthrough', 'strict'], account_mode: ['auto', 'personal', 'team'], source: ['passive', 'active', 'injection', 'lifecycle'] };
    return enums[field] ? enums[field].includes(value) : value.length > 0 || field === 'account_label';
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(shapes[type]).every(([key, child]) => Object.hasOwn(value, key) && valid((value as Record<string, unknown>)[key], child, key));
}
export function isTurnStateOverview(value: unknown): value is TurnStateOverview {
  return valid(value, 'TurnStateOverview') && (value as TurnStateOverview).schema === 'codex-proxy.turn-state-overview.v1';
}
