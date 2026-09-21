// turn-state 结构判定的展示契约：判定码 -> 色调/标签，失败规则码 -> 人类标签。
// 请求事件表与模型质量页的“最近观测”共用这一份映射，避免两处标签各自漂移。
// 后端契约：internal/api/turn_state_model_mismatch.go、internal/api/usage_events.go。

export type StateCheckTone = 'success' | 'danger' | 'neutral';

// 判定码到展示色与标签的映射；未知码必须落到 neutral，永远不能是绿色。
// shape_mismatch / invalid / expired 共用“可能降智”标签，失败规则由 reason 行说明。
const STATE_CHECK_VERDICTS: Record<string, { tone: StateCheckTone; labelKey: string }> = {
  ok: { tone: 'success', labelKey: 'usage_stats.request_events_state_check_ok' },
  shape_mismatch: { tone: 'danger', labelKey: 'usage_stats.request_events_state_check_degraded' },
  invalid: { tone: 'danger', labelKey: 'usage_stats.request_events_state_check_degraded' },
  expired: { tone: 'danger', labelKey: 'usage_stats.request_events_state_check_degraded' },
  no_state: { tone: 'neutral', labelKey: 'usage_stats.request_events_state_check_none' },
};

export interface StateCheckPresentation {
  tone: StateCheckTone;
  /** 已知判定码的 i18n 标签 key；未知码为空，此时直接展示 verdictCode。 */
  labelKey: string;
  verdictCode: string;
  /** 空表示该判定没有可展示的失败规则。 */
  reasonCode: string;
}

// 空判定表示上游未上报 state，返回 null 由调用方渲染“无”。
export const resolveStateCheckPresentation = (stateCheck: string, stateCheckReason = ''): StateCheckPresentation | null => {
  const verdictCode = stateCheck.trim();
  if (!verdictCode) return null;
  const verdict = STATE_CHECK_VERDICTS[verdictCode];
  if (!verdict) {
    return { tone: 'neutral', labelKey: '', verdictCode, reasonCode: '' };
  }
  const reasonCode = verdict.tone === 'danger'
    ? stateCheckReason.trim() || (verdictCode === 'expired' ? 'expired' : '')
    : '';
  return { tone: verdict.tone, labelKey: verdict.labelKey, verdictCode, reasonCode };
};

// 失败规则码到人类标签；未知码由调用方回退到 generic 标签加原始码。
// 未知规则码必须保留原始码，不能编造一个看起来确定的规则名。
// 导出给运行事件展示复用：主动探测的拒绝必须和请求事件表用同一套规则文案。
export const STATE_CHECK_REASON_LABEL_KEYS: Record<string, string> = {
  encoding_length: 'usage_stats.request_events_state_check_reason_encoding_length',
  encoding_whitespace: 'usage_stats.request_events_state_check_reason_encoding_whitespace',
  encoding_padding: 'usage_stats.request_events_state_check_reason_encoding_padding',
  encoding_base64: 'usage_stats.request_events_state_check_reason_encoding_base64',
  envelope_too_short: 'usage_stats.request_events_state_check_reason_envelope_too_short',
  envelope_version: 'usage_stats.request_events_state_check_reason_envelope_version',
  envelope_structure: 'usage_stats.request_events_state_check_reason_envelope_structure',
  timestamp_range: 'usage_stats.request_events_state_check_reason_timestamp_range',
  timestamp_future: 'usage_stats.request_events_state_check_reason_timestamp_future',
  expired: 'usage_stats.request_events_state_check_reason_expired',
  block_mismatch: 'usage_stats.request_events_state_check_reason_block_mismatch',
};

export interface StateCheckBlocks {
  observedBlocks: number | null;
  expectedBlocks: number | null;
}

/**
 * 参考封套长度：57 字节头部 + 每块 16 字节，整体做 base64 编码。
 * 块数与字符数是一个整体，只报块数会让人以为可以单独凑块数。
 * 这是由封套结构推导出来的值，不是上游实测长度（实测长度无法可靠拿到时也不编造）。
 */
export const stateShapeCharacters = (blocks: number | null): number | null =>
  blocks === null || blocks < 0 ? null : 4 * Math.ceil((57 + 16 * blocks) / 3);

// 形状标签统一走这里，请求事件表、模型质量页、运行事件三处不能再各写一套顺序。
export const formatStateShape = (
  blocks: number | null,
  t: (key: string, options?: Record<string, string | number>) => string,
  characters?: number | null,
): string => t('usage_stats.state_shape', {
    blocks: blocks ?? '-',
    // 有实测长度就用实测，否则用封套结构推导值；两者都没有才显示 '-'。
    characters: characters ?? stateShapeCharacters(blocks) ?? '-',
  });

/**
 * 把判定结果翻译成一行人类可读标签，块数不符时附上实际/期望块数。
 * 返回空串表示该行没有可展示的失败规则（判定 ok 或上游未上报）。
 */
export const formatStateCheckDetail = (
  stateCheck: string,
  stateCheckReason: string,
  blocks: StateCheckBlocks,
  t: (key: string, options?: Record<string, string | number>) => string,
): string => {
  const presentation = resolveStateCheckPresentation(stateCheck, stateCheckReason);
  if (!presentation || !presentation.reasonCode) return '';
  const reasonKey = STATE_CHECK_REASON_LABEL_KEYS[presentation.reasonCode];
  if (!reasonKey) {
    return t('usage_stats.request_events_state_check_reason_unknown', { code: presentation.reasonCode });
  }
  if (presentation.reasonCode !== 'block_mismatch') {
    return t(reasonKey);
  }
  // 块数缺失时用 '-' 明确表示未上报，不把缺值当成 0。
  return t(reasonKey, {
    observed: formatStateShape(blocks.observedBlocks, t),
    expected: formatStateShape(blocks.expectedBlocks, t),
  });
};
