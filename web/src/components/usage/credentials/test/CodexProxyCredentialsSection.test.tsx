// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchUsageIdentitiesPage } from '@/lib/api'
import styles from '../CredentialSections.module.scss'
import type { UsageIdentity } from '@/lib/types'
import { CodexProxyAccount, CodexProxyCredentialsSection } from '../CodexProxyCredentialsSection'

vi.mock('@/lib/api', () => ({ fetchUsageIdentitiesPage: vi.fn() }))
vi.mock('react-i18next', () => ({ initReactI18next: { type: '3rdParty', init: () => undefined }, useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../CredentialHealthPanel', () => ({ CredentialHealthPanel: () => <div>request-health</div> }))
const row = {
  id: '3', identity: 'entry-3', type: 'codex-proxy-account', name: 'Codex account', auth_type: 3,
  codex_quota: { status: 'active', stale: true, quota_fetched_at: '2026-09-19T00:00:00Z', quota_verify_required: false,
    quota: { plan_type: 'pro', rate_limit: { used_percent: 0, remaining_percent: 100, reset_at: null, limit_window_seconds: 604800 }, secondary_rate_limit: null, code_review_rate_limit: null } },
} as UsageIdentity

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })
describe('Codex read-only observations', () => {
  it('preserves observed zero, unknown reset, stale and request-health independently; offers no mutation', () => {
    const html = renderToStaticMarkup(<CodexProxyAccount row={row} />)
    expect(html).toContain('codex_accounts.stale')
    expect(html).toContain('codex_accounts.no')
    expect(html).not.toContain('<button')
    expect(html).not.toContain('refresh')
  })
  it('does not invent zero percent for absent quota', () => {
    const html = renderToStaticMarkup(<CodexProxyAccount row={{ ...row, codex_quota: undefined }} />)
    expect(html).toContain('codex_accounts.unavailable')
    expect(html).not.toContain('0%')
  })
  it('only fetches authorized type-3 pages; hidden section performs no polling', async () => {
    vi.useFakeTimers()
    vi.mocked(fetchUsageIdentitiesPage).mockResolvedValue({ identities: [row], total_count: 1, page: 1, page_size: 10, total_pages: 1 })
    const node = document.createElement('div')
    const root = createRoot(node)
    try {
      await act(async () => root.render(<CodexProxyCredentialsSection enabled />))
      expect(fetchUsageIdentitiesPage).toHaveBeenCalledWith(expect.any(AbortSignal), { authType: 3, page: 1, pageSize: 10, activeOnly: false, sort: 'last_used_at' })
      expect(node.querySelector(`.${styles.credentialSectionCard}`)).not.toBeNull()
      expect(node.querySelector(`.${styles.authFileCredentialRow}`)).not.toBeNull()
      expect(node.querySelector(`.${styles.credentialTableHeader}`)).not.toBeNull()
      expect(node.textContent).toContain('0%')
      expect(node.querySelector(`.${styles.credentialRowRefreshButton}`)).toBeNull()
      expect(node.querySelector(`.${styles.credentialInspectionButton}`)).toBeNull()
      expect(node.querySelector('[data-credential-detail-trigger]')).toBeNull()
      const health = Array.from(node.querySelectorAll('button')).find(b => b.textContent?.includes('credentials_auth_files_display_mode_health'))!
      await act(async () => health.click())
      expect(node.textContent).toContain('request-health')
      await act(async () => root.render(<CodexProxyCredentialsSection enabled={false} />))
      await act(async () => vi.advanceTimersByTime(120_000))
      expect(fetchUsageIdentitiesPage).toHaveBeenCalledTimes(1)
    } finally { await act(async () => root.unmount()) }
  })
})
