package migration

import (
	"path/filepath"
	"testing"

	"cpa-usage-keeper/internal/entities"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

// TestAddUsageEventObservabilityFieldsMigrationAddsAdditiveColumns 验证新列 additive：
// 旧行落空串/NULL，且重复执行保持幂等。
func TestAddUsageEventObservabilityFieldsMigrationAddsAdditiveColumns(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(testSQLiteDSN(filepath.Join(t.TempDir(), "legacy.db"))), &gorm.Config{})
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer closeOpenedDatabase(t, db)

	if err := db.Exec(`CREATE TABLE usage_events (
		id integer PRIMARY KEY,
		event_key text,
		model text,
		timestamp datetime,
		source text,
		auth_index text,
		total_tokens integer
	)`).Error; err != nil {
		t.Fatalf("create legacy usage_events table: %v", err)
	}
	if err := db.Exec(`INSERT INTO usage_events (id, event_key, model, timestamp, source, auth_index, total_tokens)
		VALUES (?, ?, ?, ?, ?, ?, ?)`, int64(1), "event-legacy", "gpt-5", "2026-09-21 08:00:00", "source-a", "auth-1", 10).Error; err != nil {
		t.Fatalf("seed legacy usage event: %v", err)
	}
	if err := db.Exec(`CREATE TABLE usage_events_archive (
		id integer PRIMARY KEY,
		event_key text,
		model text,
		timestamp datetime
	)`).Error; err != nil {
		t.Fatalf("create legacy archive table: %v", err)
	}
	if err := db.Exec(`INSERT INTO usage_events_archive (id, event_key, model, timestamp) VALUES (?, ?, ?, ?)`, int64(1), "archived-legacy", "gpt-5", "2026-09-21 08:00:00").Error; err != nil {
		t.Fatalf("seed legacy archived event: %v", err)
	}

	if err := addUsageEventObservabilityFieldsMigration(db); err != nil {
		t.Fatalf("add observability fields: %v", err)
	}
	if err := addUsageEventObservabilityFieldsMigration(db); err != nil {
		t.Fatalf("add observability fields should be idempotent: %v", err)
	}

	for _, table := range []struct {
		model any
		name  string
	}{
		{model: &entities.UsageEvent{}, name: "usage_events"},
		{model: &entities.UsageEventArchive{}, name: "usage_events_archive"},
	} {
		for _, column := range []string{"upstream_model", "state_check", "state_check_reason", "state_check_observed_blocks", "state_check_expected_blocks"} {
			if !db.Migrator().HasColumn(table.model, column) {
				t.Fatalf("expected %s.%s column to exist", table.name, column)
			}
		}
	}

	// 旧行必须落空串与 NULL，不能因为 additive 列变成 non-null 失败或隐藏默认值。
	var legacy struct {
		UpstreamModel            string
		StateCheck               string
		StateCheckReason         string
		StateCheckObservedBlocks *int64
		StateCheckExpectedBlocks *int64
	}
	if err := db.Table("usage_events").
		Select("upstream_model, state_check, state_check_reason, state_check_observed_blocks, state_check_expected_blocks").
		Where("id = ?", int64(1)).
		Scan(&legacy).Error; err != nil {
		t.Fatalf("scan legacy observability columns: %v", err)
	}
	if legacy.UpstreamModel != "" || legacy.StateCheck != "" || legacy.StateCheckReason != "" {
		t.Fatalf("expected legacy text columns to default to empty, got %+v", legacy)
	}
	// NULL 必须与 0 区分：未上报块数不能显示成 0 块。
	if legacy.StateCheckObservedBlocks != nil || legacy.StateCheckExpectedBlocks != nil {
		t.Fatalf("expected legacy block columns to stay NULL, got %+v", legacy)
	}

	var archiveCount int64
	if err := db.Table("usage_events_archive").Where("id = ?", int64(1)).Count(&archiveCount).Error; err != nil {
		t.Fatalf("count archived row: %v", err)
	}
	if archiveCount != 1 {
		t.Fatalf("expected archive row to survive migration, got %d", archiveCount)
	}
}
