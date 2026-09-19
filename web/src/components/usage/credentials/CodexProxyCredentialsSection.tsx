import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { fetchUsageIdentitiesPage } from '@/lib/api'
import type { UsageIdentity } from '@/lib/types'
import { CredentialSectionShell } from './CredentialSectionShell'
import { CredentialHealthPanel } from './CredentialHealthPanel'

/** Read-only Codex observations. Never uses CPA quota or credential mutation APIs. */
export function CodexProxyCredentialsSection({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<UsageIdentity[]>([])
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(1)
  const [error, setError] = useState(false)
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    let pending = false
    const load = async () => {
      if (pending) return
      pending = true
      try {
        const result = await fetchUsageIdentitiesPage(controller.signal, { authType: 3, page, pageSize: 10 })
        if (!controller.signal.aborted) {
          setRows(result.identities)
          setPages(result.total_pages)
          setError(false)
        }
      } catch {
        if (!controller.signal.aborted) setError(true)
      } finally { pending = false }
    }
    void load()
    const timer = setInterval(() => { void load() }, 60_000)
    return () => { controller.abort(); clearInterval(timer) }
  }, [enabled, page])
  if (!rows.length && !error) return null
  return <CredentialSectionShell title="Codex Proxy" subtitle={t('codex_accounts.read_only')} countLabel={`${page} / ${pages}`}>
    {error && <p role="alert">{t('codex_accounts.stale')}</p>}
    {rows.map(row => <CodexProxyAccount key={row.id} row={row} />)}
    {pages > 1 && <nav aria-label="Codex Proxy pages">
      <button disabled={page <= 1} onClick={() => setPage(page - 1)}>{t('codex_accounts.previous')}</button>
      <button disabled={page >= pages} onClick={() => setPage(page + 1)}>{t('codex_accounts.next')}</button>
    </nav>}
  </CredentialSectionShell>
}

export function CodexProxyAccount({ row }: { row: UsageIdentity }) {
  const { t } = useTranslation()
  const snapshot = row.codex_quota
  const unknown = t('codex_accounts.unknown')
  const date = (value: string | number | null | undefined) => value == null ? unknown : new Date(value).toLocaleString()
  const percent = (value: number | null | undefined) => value == null ? unknown : `${value}%`
  return <article>
    <h4>{row.displayName || row.name}</h4>
    <p>{t('codex_accounts.status')}: {snapshot?.status || unknown}</p>
    <CredentialHealthPanel displayName={row.displayName || row.name} health={row.credential_health} lastUsedAt={row.last_used_at} statsUpdatedAt={row.stats_updated_at} />
    {(!snapshot || !snapshot.quota) && <p>{t('codex_accounts.unavailable')}</p>}
    {snapshot?.stale && <p role="status">{t('codex_accounts.stale')}</p>}
    <p>{t('codex_accounts.fetched')}: {date(snapshot?.quota_fetched_at)}</p>
    <p>{t('codex_accounts.verify')}: {snapshot?.quota_verify_required == null ? unknown : t(snapshot.quota_verify_required ? 'codex_accounts.yes' : 'codex_accounts.no')}</p>
    {snapshot?.quota && <dl>{(['rate_limit', 'secondary_rate_limit', 'code_review_rate_limit'] as const).map(key => {
      const window = snapshot.quota![key]
      if (!window) return null
      return <div key={key}>
        <dt>{t(`codex_accounts.${key}`)}</dt>
        <dd>{t('codex_accounts.used')}: {percent(window.used_percent)}; {t('codex_accounts.remaining')}: {percent(window.remaining_percent)}</dd>
        <dd>{t('codex_accounts.window')}: {window.limit_window_seconds ?? unknown}; {t('codex_accounts.reset')}: {date(window.reset_at == null ? null : window.reset_at * 1000)}</dd>
      </div>
    })}</dl>}
  </article>
}
