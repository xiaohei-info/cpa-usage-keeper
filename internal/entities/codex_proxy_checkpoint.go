package entities

import "time"

// CodexProxyCheckpoint stores the last successfully ingested Codex Proxy event cursor.
type CodexProxyCheckpoint struct {
	Name      string    `gorm:"primaryKey"`
	Cursor    int64     `gorm:"not null"`
	UpdatedAt time.Time `gorm:"serializer:storageTime;not null"`
}
