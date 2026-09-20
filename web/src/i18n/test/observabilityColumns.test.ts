import { describe, expect, it } from 'vitest';
import i18n from '../index';

const labels = (language: string, keys: string[]) => keys.map((key) => (
  i18n.getResource(language, 'translation', `usage_stats.${key}`)
));

const OBSERVABILITY_KEYS = [
  'request_events_upstream_model',
  'request_events_state_check',
  'request_events_model_match',
  'request_events_model_mismatch',
  'request_events_state_check_ok',
  'request_events_state_check_none',
  'request_events_state_check_degraded',
  'request_events_state_check_reason_block_mismatch',
  'request_events_state_check_reason_unknown',
];

describe('observability column translations', () => {
  it('localizes the observability columns and verdicts in every supported language', () => {
    expect(labels('en', OBSERVABILITY_KEYS)).toEqual([
      'Upstream Model',
      'State Check',
      'Match',
      'Mismatch',
      'OK',
      'None',
      'Possibly degraded',
      'Block count mismatch (observed {{observed}} / expected {{expected}})',
      'Unknown reason ({{code}})',
    ]);
    expect(labels('zh', OBSERVABILITY_KEYS)).toEqual([
      '上游模型',
      'state 探查',
      '匹配',
      '不匹配',
      '正常',
      '无',
      '可能降智',
      '块数不符（实际 {{observed}} 块 / 期望 {{expected}} 块）',
      '未知原因（{{code}}）',
    ]);
    expect(labels('zh-TW', OBSERVABILITY_KEYS)).toEqual([
      '上游模型',
      'state 探查',
      '匹配',
      '不匹配',
      '正常',
      '無',
      '可能降智',
      '塊數不符（實際 {{observed}} 塊 / 期望 {{expected}} 塊）',
      '未知原因（{{code}}）',
    ]);
  });

  it('localizes every canonical failed rule code', () => {
    const reasonKeys = [
      'encoding_length',
      'encoding_whitespace',
      'encoding_padding',
      'encoding_base64',
      'envelope_too_short',
      'envelope_version',
      'envelope_structure',
      'timestamp_range',
      'timestamp_future',
      'expired',
      'block_mismatch',
    ].map((code) => `request_events_state_check_reason_${code}`);

    expect(labels('en', reasonKeys)).toEqual([
      'Length over limit',
      'Contains whitespace',
      'Padding mismatch',
      'Invalid Base64',
      'Envelope too short',
      'Envelope version mismatch',
      'Block structure mismatch',
      'Timestamp out of range',
      'Timestamp abnormal',
      'Expired',
      'Block count mismatch (observed {{observed}} / expected {{expected}})',
    ]);
    expect(labels('zh', reasonKeys)).toEqual([
      '长度超限',
      '编码含空白',
      '填充符不符',
      'Base64 无效',
      '封装过短',
      '封装版本不符',
      '分块结构不符',
      '时间戳越界',
      '时间戳异常',
      '已过期',
      '块数不符（实际 {{observed}} 块 / 期望 {{expected}} 块）',
    ]);
    expect(labels('zh-TW', reasonKeys)).toEqual([
      '長度超限',
      '編碼含空白',
      '填充符不符',
      'Base64 無效',
      '封裝過短',
      '封裝版本不符',
      '分塊結構不符',
      '時間戳越界',
      '時間戳異常',
      '已過期',
      '塊數不符（實際 {{observed}} 塊 / 期望 {{expected}} 塊）',
    ]);
  });

  it('localizes the upstream model match rate in every supported language', () => {
    expect(labels('en', ['credentials_health_upstream_model_match', 'credentials_health_upstream_model_match_unavailable'])).toEqual([
      'Upstream model match',
      'Not available',
    ]);
    expect(labels('zh', ['credentials_health_upstream_model_match', 'credentials_health_upstream_model_match_unavailable'])).toEqual([
      '上游模型一致率',
      '暂无',
    ]);
    expect(labels('zh-TW', ['credentials_health_upstream_model_match', 'credentials_health_upstream_model_match_unavailable'])).toEqual([
      '上游模型一致率',
      '暫無',
    ]);
  });
});
