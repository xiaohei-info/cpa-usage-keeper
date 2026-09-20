import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { UsageEvent } from '@/lib/types';
import {
  REQUEST_EVENT_COLUMN_IDS,
  RequestEventsDetailsCard,
  resolveStateCheckPresentation,
  resolveUpstreamModelStatus,
} from '../RequestEventsDetailsCard';

const baseEvent: UsageEvent = {
  id: 'observability',
  timestamp: '2026-09-21T10:00:00+08:00',
  model: 'gpt-5',
  source: 'Provider A',
  source_raw: 'source-a',
  auth_index: '1',
  failed: false,
  latency_ms: 120,
  tokens: {
    input_tokens: 10,
    output_tokens: 5,
    reasoning_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    total_tokens: 15,
  },
};

const renderCard = (row: Partial<UsageEvent>) => renderToStaticMarkup(
  <RequestEventsDetailsCard
    events={[{ ...baseEvent, ...row }]}
    loading={false}
    totalCount={1}
    modelOptions={['gpt-5']}
    sourceOptions={[{ value: 'source-a', label: 'Provider A' }]}
    modelFilter="__all__"
    sourceFilter="__all__"
    resultFilter="__all__"
    onModelFilterChange={() => undefined}
    onSourceFilterChange={() => undefined}
    onResultFilterChange={() => undefined}
  />,
);

const textFromMarkup = (value: string) => value.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

const extractTableHeaders = (html: string) => (
  Array.from(html.matchAll(/<th\b[^>]*>(.*?)<\/th>/gs), (match) => textFromMarkup(match[1]))
);

const extractCell = (html: string, headerIndex: number) => {
  const row = html.match(/<tbody><tr>(.*?)<\/tr><\/tbody>/s)?.[1] ?? '';
  const cells = Array.from(row.matchAll(/<td\b[^>]*>(.*?)<\/td>/gs), (match) => match[1]);
  return { text: textFromMarkup(cells[headerIndex] ?? ''), markup: cells[headerIndex] ?? '' };
};

const cellFor = (html: string, header: string) => {
  const index = extractTableHeaders(html).indexOf(header);
  expect(index).toBeGreaterThanOrEqual(0);
  return { ...extractCell(html, index), index };
};

describe('RequestEventsDetailsCard observability columns', () => {
  it('places the two observability columns immediately after Model and lists them as visible', () => {
    const html = renderCard({});
    const headers = extractTableHeaders(html);

    expect(headers.slice(3, 6)).toEqual(['Model', 'Upstream Model', 'State Check']);
  });

  it('renders the upstream model with a green match tag when it equals the requested model', () => {
    const { text, markup } = cellFor(renderCard({ model: 'gpt-5', upstream_model: 'gpt-5' }), 'Upstream Model');

    expect(text).toBe('gpt-5 → gpt-5Match');
    expect(markup).toContain('data-upstream-model-status="match"');
    expect(markup).toContain('requestEventsStatusTagSuccess');
    expect(markup).not.toContain('requestEventsStatusTagDanger');
  });

  it('renders a red mismatch tag and both names when upstream differs from the request', () => {
    const { text, markup } = cellFor(renderCard({ model: 'gpt-5', upstream_model: 'gpt-5-mini' }), 'Upstream Model');

    expect(text).toBe('gpt-5 → gpt-5-miniMismatch');
    expect(markup).toContain('data-upstream-model-status="mismatch"');
    expect(markup).toContain('requestEventsStatusTagDanger');
  });

  it('renders a dash when the upstream model was not observed', () => {
    const fromMissing = cellFor(renderCard({}), 'Upstream Model');
    const fromBlank = cellFor(renderCard({ upstream_model: '   ' }), 'Upstream Model');

    expect(fromMissing.text).toBe('-');
    expect(fromMissing.markup).not.toContain('requestEventsStatusTag');
    expect(fromBlank.text).toBe('-');
  });

  it('renders ok as a green OK verdict without a reason line', () => {
    const { text, markup } = cellFor(renderCard({ state_check: 'ok' }), 'State Check');

    expect(text).toBe('OK');
    expect(markup).toContain('data-state-check-tone="success"');
    expect(markup).not.toContain('data-state-check-reason');
  });

  it('renders shape_mismatch as possibly degraded with the human label of the failed rule', () => {
    const { text, markup } = cellFor(renderCard({
      state_check: 'shape_mismatch',
      state_check_reason: 'encoding_length',
    }), 'State Check');

    expect(text).toBe('Possibly degradedLength over limit');
    expect(markup).toContain('data-state-check-tone="danger"');
    expect(markup).toContain('data-state-check-reason="encoding_length"');
    expect(markup).toContain('requestEventsStatusTagDanger');
  });

  it('renders block_mismatch with the observed and expected block counts', () => {
    const { text, markup } = cellFor(renderCard({
      state_check: 'shape_mismatch',
      state_check_reason: 'block_mismatch',
      state_check_observed_blocks: 11,
      state_check_expected_blocks: 10,
    }), 'State Check');

    expect(text).toBe('Possibly degradedBlock count mismatch (observed 11 / expected 10)');
    expect(markup).toContain('data-state-check-reason="block_mismatch"');
  });

  it('renders a real zero block count instead of treating it as missing', () => {
    const { text } = cellFor(renderCard({
      state_check: 'shape_mismatch',
      state_check_reason: 'block_mismatch',
      state_check_observed_blocks: 0,
      state_check_expected_blocks: 10,
    }), 'State Check');

    expect(text).toBe('Possibly degradedBlock count mismatch (observed 0 / expected 10)');
  });

  it('marks missing block counts as unreported rather than zero', () => {
    const { text } = cellFor(renderCard({
      state_check: 'shape_mismatch',
      state_check_reason: 'block_mismatch',
    }), 'State Check');

    expect(text).toBe('Possibly degradedBlock count mismatch (observed - / expected -)');
  });

  it('renders invalid and expired as possibly degraded with their own reason label', () => {
    const invalid = cellFor(renderCard({
      state_check: 'invalid',
      state_check_reason: 'envelope_version',
    }), 'State Check');
    const expired = cellFor(renderCard({ state_check: 'expired' }), 'State Check');

    expect(invalid.text).toBe('Possibly degradedEnvelope version mismatch');
    expect(invalid.markup).toContain('data-state-check-tone="danger"');
    expect(expired.text).toBe('Possibly degradedExpired');
    expect(expired.markup).toContain('data-state-check-reason="expired"');
  });

  it('renders no_state as a neutral None verdict instead of a green one', () => {
    const { text, markup } = cellFor(renderCard({ state_check: 'no_state' }), 'State Check');

    expect(text).toBe('None');
    expect(markup).toContain('data-state-check-tone="neutral"');
    expect(markup).toContain('requestEventsStatusTagNeutral');
    expect(markup).not.toContain('requestEventsStatusTagSuccess');
  });

  it('renders a dash when the state check was not observed', () => {
    const { text, markup } = cellFor(renderCard({}), 'State Check');

    expect(text).toBe('-');
    expect(markup).not.toContain('requestEventsStatusTag');
  });

  it('never renders an unknown verdict code as green and exposes the raw code', () => {
    const html = renderCard({ state_check: 'brand_new_verdict' });
    const { text, markup } = cellFor(html, 'State Check');

    expect(text).toBe('brand_new_verdict');
    expect(markup).toContain('data-state-check-tone="neutral"');
    expect(markup).toContain('requestEventsStatusTagNeutral');
    expect(markup).not.toContain('requestEventsStatusTagSuccess');
    // 未知码的原始判定码同时挂在单元格 tooltip 上，避免只能看到中性色而不知原因。
    expect(html).toContain('aria-label="brand_new_verdict"');
  });

  it('falls back to a generic label that keeps the unknown reason code visible', () => {
    const { text, markup } = cellFor(renderCard({
      state_check: 'shape_mismatch',
      state_check_reason: 'brand_new_reason',
    }), 'State Check');

    expect(text).toBe('Possibly degradedUnknown reason (brand_new_reason)');
    expect(markup).toContain('data-state-check-reason="brand_new_reason"');
  });

  it('renders legacy rows without the observability fields without crashing', () => {
    const legacy: UsageEvent = {
      id: 'legacy',
      timestamp: '2026-09-21T10:00:00+08:00',
      model: 'gpt-5',
      source: 'Provider A',
      failed: false,
      latency_ms: 100,
      tokens: { input_tokens: 1, output_tokens: 1, reasoning_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, total_tokens: 2 },
    };
    const html = renderToStaticMarkup(
      <RequestEventsDetailsCard
        events={[legacy]}
        loading={false}
        totalCount={1}
        modelOptions={['gpt-5']}
        sourceOptions={[]}
        modelFilter="__all__"
        sourceFilter="__all__"
        resultFilter="__all__"
        onModelFilterChange={() => undefined}
        onSourceFilterChange={() => undefined}
        onResultFilterChange={() => undefined}
      />,
    );

    expect(cellFor(html, 'Upstream Model').text).toBe('-');
    expect(cellFor(html, 'State Check').text).toBe('-');
  });

  it('tolerates null observability fields from the API', () => {
    const html = renderCard({
      upstream_model: null,
      state_check: null,
      state_check_reason: null,
      state_check_observed_blocks: null,
      state_check_expected_blocks: null,
    });

    expect(cellFor(html, 'Upstream Model').text).toBe('-');
    expect(cellFor(html, 'State Check').text).toBe('-');
  });
});

describe('observability column helpers', () => {
  it('registers both columns right after Model so column settings can toggle them', () => {
    expect(REQUEST_EVENT_COLUMN_IDS.slice(3, 6)).toEqual(['model', 'upstream_model', 'state_check']);
  });

  it('treats an empty side as unobserved rather than a match', () => {
    expect(resolveUpstreamModelStatus('gpt-5', 'gpt-5')).toBe('match');
    expect(resolveUpstreamModelStatus('gpt-5', 'gpt-5-mini')).toBe('mismatch');
    expect(resolveUpstreamModelStatus('gpt-5', '')).toBe('unobserved');
    expect(resolveUpstreamModelStatus('', 'gpt-5')).toBe('unobserved');
    expect(resolveUpstreamModelStatus('', '')).toBe('unobserved');
  });

  it('returns null for an empty verdict and a neutral presentation for unknown codes', () => {
    expect(resolveStateCheckPresentation('')).toBeNull();
    expect(resolveStateCheckPresentation('  ')).toBeNull();

    const unknown = resolveStateCheckPresentation('brand_new_verdict');
    expect(unknown).toEqual({ tone: 'neutral', labelKey: '', verdictCode: 'brand_new_verdict', reasonCode: '' });
  });

  it('keeps the reason only for failing verdicts', () => {
    expect(resolveStateCheckPresentation('ok', 'encoding_length')?.reasonCode).toBe('');
    expect(resolveStateCheckPresentation('no_state', 'encoding_length')?.reasonCode).toBe('');
    expect(resolveStateCheckPresentation('shape_mismatch', 'encoding_length')?.reasonCode).toBe('encoding_length');
    expect(resolveStateCheckPresentation('expired')?.reasonCode).toBe('expired');
  });
});
