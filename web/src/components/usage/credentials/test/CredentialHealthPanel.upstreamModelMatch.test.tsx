import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { UsageCredentialHealth } from '@/lib/types'
import { CredentialHealthPanel, resolveUpstreamModelMatch, upstreamModelMatchTone } from '../CredentialHealthPanel'

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      if (key === 'usage_stats.credentials_health_upstream_model_match_sample') {
        return `mismatched ${params?.count} sampled ${params?.total}`
      }
      if (key === 'usage_stats.credentials_health_upstream_model_match_aria') {
        return `${params?.name}|${params?.rate}|${params?.total}|${params?.count}`
      }
      return key
    },
  }),
}))

const health = (overrides: Partial<UsageCredentialHealth> = {}): UsageCredentialHealth => ({
  window_seconds: 18_000,
  bucket_seconds: 600,
  window_start: '2026-09-21T05:00:00+08:00',
  window_end: '2026-09-21T10:00:00+08:00',
  total_success: 2,
  total_failure: 0,
  success_rate: 100,
  input_tokens: 0,
  cache_read_tokens: 0,
  buckets: [],
  ...overrides,
})

const renderPanel = (value?: UsageCredentialHealth) => renderToStaticMarkup(
  <CredentialHealthPanel displayName="Provider Key" health={value} />,
)

describe('CredentialHealthPanel upstream model match rate', () => {
  it.each([
    { label: '90 percent', matched: 90, total: 100, tone: 'credentialMetricValueSuccess', display: '90.00%' },
    { label: '89 percent', matched: 89, total: 100, tone: 'credentialMetricValueWarning', display: '89.00%' },
    { label: '60 percent', matched: 60, total: 100, tone: 'credentialMetricValueWarning', display: '60.00%' },
    { label: '59 percent', matched: 59, total: 100, tone: 'credentialMetricValueDanger', display: '59.00%' },
    { label: '100 percent', matched: 100, total: 100, tone: 'credentialMetricValueSuccess', display: '100.00%' },
  ])('colors $label with the $tone tone band', ({ matched, total, tone, display }) => {
    const html = renderPanel(health({ upstream_model_match_total: total, upstream_model_match_matched: matched }))

    expect(html).toContain('usage_stats.credentials_health_upstream_model_match')
    expect(html).toContain(`>${display}<`)
    expect(html).toContain(tone)
    for (const other of ['credentialMetricValueSuccess', 'credentialMetricValueWarning', 'credentialMetricValueDanger']) {
      if (other !== tone) {
        expect(html).not.toContain(other)
      }
    }
  })

  it('shows the sample size and the mismatch count as an uncolored secondary figure', () => {
    const html = renderPanel(health({ upstream_model_match_total: 40, upstream_model_match_matched: 30 }))

    expect(html).toContain('mismatched 10 sampled 40')
    expect(html).toContain('credentialHealthMetaCacheSecondary')
  })

  it('reports a zero-sample rate as not available instead of a red zero percent', () => {
    const html = renderPanel(health({ upstream_model_match_total: 0, upstream_model_match_matched: 0 }))

    expect(html).toContain('usage_stats.credentials_health_upstream_model_match_unavailable')
    expect(html).not.toContain('>0.00%<')
    expect(html).not.toContain('credentialMetricValueDanger')
    expect(html).toContain('credentialMetricValueNeutral')
  })

  it('treats a legacy payload without the match sample fields as not available', () => {
    const html = renderPanel(health())

    expect(html).toContain('usage_stats.credentials_health_upstream_model_match_unavailable')
    expect(html).not.toContain('credentialMetricValueDanger')
  })

  it('clamps a matched count above the total to a 100 percent sample', () => {
    const resolved = resolveUpstreamModelMatch(health({
      upstream_model_match_total: 5,
      upstream_model_match_matched: 9,
    }))

    expect(resolved).toEqual({ percent: 100, total: 5, mismatched: 0 })
  })

  it('never reports a negative mismatch count for damaged payloads', () => {
    const resolved = resolveUpstreamModelMatch(health({
      upstream_model_match_total: -4,
      upstream_model_match_matched: -4,
    }))

    expect(resolved).toEqual({ percent: null, total: 0, mismatched: 0 })
  })
})

describe('upstreamModelMatchTone bands', () => {
  it('maps the 90/89/60/59 boundaries and the unavailable sample', () => {
    expect([
      upstreamModelMatchTone(100),
      upstreamModelMatchTone(90),
      upstreamModelMatchTone(89.99),
      upstreamModelMatchTone(60),
      upstreamModelMatchTone(59.99),
      upstreamModelMatchTone(0),
      upstreamModelMatchTone(null),
    ]).toEqual(['success', 'success', 'warning', 'warning', 'danger', 'danger', 'neutral'])
  })
})
