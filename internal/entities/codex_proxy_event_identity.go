package entities

import "time"

// CodexProxyEventIdentity is a durable, database-enforced claim for one
// Codex Proxy event. It keeps replay/race idempotency isolated from CPA's
// existing usage_events semantics.
type CodexProxyEventIdentity struct {
	EventID   string    `gorm:"primaryKey"`
	CreatedAt time.Time `gorm:"serializer:storageTime;not null"`
}
