import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { fetchUsageIdentitiesPage, type UsageIdentityPageSort } from '@/lib/api'
import type { UsageIdentity, UsageQuotaCheckResponse } from '@/lib/types'
import { AuthFileCredentialsSection } from './AuthFileCredentialsSection'
import { buildAuthFileCredentialRows } from './credentialViewModels'
import styles from './CredentialSections.module.scss'

/** Read-only Codex observations. Never uses CPA quota or credential mutation APIs. */
export function CodexProxyCredentialsSection({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<UsageIdentity[]>([])
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [pageSize, setPageSize] = useState(10)
  const [activeOnly, setActiveOnly] = useState(false)
  const [sort, setSort] = useState<UsageIdentityPageSort>('last_used_at')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    let pending = false
    const load = async () => {
      if (pending) return
      pending = true
      setLoading(true)
      try {
        const result = await fetchUsageIdentitiesPage(controller.signal, { authType: 3, page, pageSize, activeOnly, sort })
        if (!controller.signal.aborted) {
          setRows(result.identities)
          setPages(result.total_pages)
          setTotal(result.total_count)
          setPage(result.page)
          setError(false)
        }
      } catch {
        if (!controller.signal.aborted) setError(true)
      } finally { pending = false; if (!controller.signal.aborted) setLoading(false) }
    }
    void load()
    const timer = setInterval(() => { void load() }, 60_000)
    return () => { controller.abort(); clearInterval(timer) }
  }, [enabled, page, pageSize, activeOnly, sort])
  if (!rows.length && !error) return null
  const quotas = new Map<string, UsageQuotaCheckResponse>(rows.map(row => [row.identity, {
    id: row.id,
    quota: (['rate_limit', 'secondary_rate_limit', 'code_review_rate_limit'] as const).flatMap(key => {
      const window = row.codex_quota?.quota?.[key]
      return window ? [{
        key, label: t(`codex_accounts.${key}`),
        usedPercent: window.used_percent ?? undefined,
        remainingFraction: window.remaining_percent == null ? undefined : window.remaining_percent / 100,
        window: window.limit_window_seconds == null ? undefined : { seconds: window.limit_window_seconds },
        resetAt: window.reset_at == null ? undefined : new Date(window.reset_at * 1000).toISOString(),
      }] : []
    }),
  }]))
  const credentialRows = buildAuthFileCredentialRows(rows, quotas)
  return <AuthFileCredentialsSection
    rows={credentialRows} total={total} page={page} totalPages={pages} pageSize={pageSize}
    activeOnly={activeOnly} sort={sort} loading={loading} quotaRefreshing={false}
    quotaRefreshError={error ? t('codex_accounts.stale') : ''} quotaInspectionStatus={null}
    quotaInspectionLoading={false} quotaInspectionStarting={false} quotaInspectionError=""
    onPageChange={setPage} onPageSizeChange={value => { setPageSize(value); setPage(1) }} onActiveOnlyChange={value => { setActiveOnly(value); setPage(1) }}
    onSortChange={value => { setSort(value); setPage(1) }} onRefreshQuota={async () => undefined}
    onRefreshQuotaForAuthIndex={async () => undefined} onResetQuotaForAuthIndex={async () => undefined}
    onRefreshInspectionStatus={async () => undefined} onStartInspection={async () => undefined}
    renderQuotaNotes={row => <CodexProxyAccount row={row.identity} />}
    readOnly title="Codex Proxy" subtitle={t('codex_accounts.read_only')}
  />
}

export function CodexProxyAccount({ row }: { row: UsageIdentity }) {
  const { t } = useTranslation()
  const snapshot = row.codex_quota
  const unknown = t('codex_accounts.unknown')
  const date = (value: string | number | null | undefined) => value == null ? unknown : new Date(value).toLocaleString()
  return <div className={styles.credentialQuotaState}>
    <p>{t('codex_accounts.status')}: {snapshot?.status || unknown}</p>
    {(!snapshot || !snapshot.quota) && <p>{t('codex_accounts.unavailable')}</p>}
    {snapshot?.stale && <p role="status">{t('codex_accounts.stale')}</p>}
    <p>{t('codex_accounts.fetched')}: {date(snapshot?.quota_fetched_at)}</p>
    <p>{t('codex_accounts.verify')}: {snapshot?.quota_verify_required == null ? unknown : t(snapshot.quota_verify_required ? 'codex_accounts.yes' : 'codex_accounts.no')}</p>
  </div>
}
