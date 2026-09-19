package poller

import (
	"context"
	"fmt"
	"sync"
	"time"

	"cpa-usage-keeper/internal/codexproxy"
	"cpa-usage-keeper/internal/entities"
	"cpa-usage-keeper/internal/repository"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const (
	codexProxyCheckpointName      = "codex-proxy:keeper-events"
	codexProxyAccountSyncInterval = time.Minute
)

// CodexProxyRunner pulls durable, cursor-addressed events and commits usage plus
// the cursor in one transaction. Replaying a page is safe because event IDs are
// checked before insertion.
type CodexProxyRunner struct {
	db     *gorm.DB
	recent interface {
		TryAppend([]entities.UsageEvent) bool
	}
	notifier        interface{ NotifyUsageEventsCommitted([]entities.UsageEvent) }
	client          *codexproxy.Client
	interval        time.Duration
	limit           int
	mu              sync.Mutex
	lastErr         error
	accountSyncMu   sync.Mutex
	lastAccountSync time.Time
	quotaMu         sync.RWMutex
	quotaSnapshots  map[string]codexproxy.QuotaSnapshot
}

func NewCodexProxyRunner(db *gorm.DB, client *codexproxy.Client, interval time.Duration, limit int) *CodexProxyRunner {
	if interval <= 0 {
		interval = 5 * time.Second
	}
	if limit < 1 || limit > 500 {
		limit = 100
	}
	return &CodexProxyRunner{db: db, client: client, interval: interval, limit: limit, quotaSnapshots: make(map[string]codexproxy.QuotaSnapshot)}
}

func (r *CodexProxyRunner) Run(ctx context.Context) error {
	if r == nil || r.db == nil || r.client == nil {
		return fmt.Errorf("codex proxy runner dependencies are missing")
	}
	for {
		if err := r.PullOnce(ctx); err != nil {
			r.mu.Lock()
			r.lastErr = err
			r.mu.Unlock()
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(r.interval):
		}
	}
}

func (r *CodexProxyRunner) SetPostCommitHooks(recent interface {
	TryAppend([]entities.UsageEvent) bool
}, notifier interface{ NotifyUsageEventsCommitted([]entities.UsageEvent) }) {
	r.recent, r.notifier = recent, notifier
}

func (r *CodexProxyRunner) PullOnce(ctx context.Context) error {
	// Account metadata is best-effort and independent from event ingestion. A
	// stale account list must never block usage events, so sync it before the
	// page pull and keep its error separate from the durable cursor transaction.
	if err := r.syncAccounts(ctx); err != nil {
		r.mu.Lock()
		r.lastErr = err
		r.mu.Unlock()
	}

	var checkpoint entities.CodexProxyCheckpoint
	if err := r.db.WithContext(ctx).Where("name = ?", codexProxyCheckpointName).First(&checkpoint).Error; err != nil && err != gorm.ErrRecordNotFound {
		return err
	}
	page, err := r.client.Pull(ctx, checkpoint.Cursor, r.limit)
	if err != nil {
		return err
	}
	if page.CursorGap {
		return fmt.Errorf("codex proxy cursor gap after %d", checkpoint.Cursor)
	}
	if len(page.Events) == 0 {
		if page.NextCursor < checkpoint.Cursor {
			return fmt.Errorf("codex proxy cursor moved backwards: %d -> %d", checkpoint.Cursor, page.NextCursor)
		}
		return nil
	}
	var committed []entities.UsageEvent
	if err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		for _, raw := range page.Events {
			claim := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&entities.CodexProxyEventIdentity{
				EventID:   raw.EventID,
				CreatedAt: time.Now(),
			})
			if claim.Error != nil {
				return fmt.Errorf("claim codex proxy event %q: %w", raw.EventID, claim.Error)
			}
			if claim.RowsAffected == 0 {
				continue
			}
			event, err := raw.UsageEvent(time.Now())
			if err != nil {
				return err
			}
			if err := tx.Create(&event).Error; err != nil {
				return fmt.Errorf("insert codex proxy usage event: %w", err)
			}
			committed = append(committed, event)
		}
		next := page.NextCursor
		if next < checkpoint.Cursor {
			return fmt.Errorf("codex proxy cursor moved backwards: %d -> %d", checkpoint.Cursor, next)
		}
		row := entities.CodexProxyCheckpoint{Name: codexProxyCheckpointName, Cursor: next, UpdatedAt: time.Now()}
		return tx.Save(&row).Error
	}); err != nil {
		return err
	}
	if len(committed) > 0 {
		if r.recent != nil {
			r.recent.TryAppend(committed)
		}
		if r.notifier != nil {
			r.notifier.NotifyUsageEventsCommitted(committed)
		}
	}
	return nil
}

func (r *CodexProxyRunner) syncAccounts(ctx context.Context) error {
	r.accountSyncMu.Lock()
	if !r.lastAccountSync.IsZero() && time.Since(r.lastAccountSync) < codexProxyAccountSyncInterval {
		r.accountSyncMu.Unlock()
		return nil
	}
	r.accountSyncMu.Unlock()

	accounts, err := r.client.Accounts(ctx)
	if err != nil {
		r.quotaMu.Lock()
		for id, snapshot := range r.quotaSnapshots {
			snapshot.Stale = true
			r.quotaSnapshots[id] = snapshot
		}
		r.quotaMu.Unlock()
		return fmt.Errorf("pull codex proxy account metadata: %w", err)
	}
	identities := make([]entities.UsageIdentity, 0, len(accounts))
	now := time.Now()
	snapshots := make(map[string]codexproxy.QuotaSnapshot, len(accounts))
	for _, account := range accounts {
		identities = append(identities, codexproxy.AccountUsageIdentity(account, now))
		snapshots[account.AccountEntryID] = codexproxy.QuotaSnapshot{Quota: account.Quota, FetchedAt: account.QuotaFetchedAt, VerifyRequired: account.QuotaVerifyRequired, Status: account.Status}
	}
	if err := repository.ReplaceUsageIdentitiesForAuthType(ctx, r.db, identities, entities.UsageIdentityAuthTypeCodexProxy, now); err != nil {
		return fmt.Errorf("sync codex proxy account identities: %w", err)
	}
	r.quotaMu.Lock()
	r.quotaSnapshots = snapshots
	r.quotaMu.Unlock()
	r.accountSyncMu.Lock()
	r.lastAccountSync = now
	r.accountSyncMu.Unlock()
	return nil
}

func (r *CodexProxyRunner) CodexQuota(accountEntryID string) (codexproxy.QuotaSnapshot, bool) {
	r.quotaMu.RLock()
	defer r.quotaMu.RUnlock()
	snapshot, ok := r.quotaSnapshots[accountEntryID]
	return snapshot, ok
}

func (r *CodexProxyRunner) LastError() error { r.mu.Lock(); defer r.mu.Unlock(); return r.lastErr }
