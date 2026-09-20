package migration

import (
	"fmt"

	"cpa-usage-keeper/internal/entities"

	"gorm.io/gorm"
)

// addUsageEventObservabilityFieldsMigration 增加上游模型与 turn-state 结构判定列。
// 全部列对旧行保持空串/NULL，Keeper 也继续接收没有这些字段的 CPA 数据。
func addUsageEventObservabilityFieldsMigration(tx *gorm.DB) error {
	for _, table := range []struct {
		model any
		name  string
	}{
		{model: &entities.UsageEvent{}, name: "usage_events"},
		{model: &entities.UsageEventArchive{}, name: "usage_events_archive"},
	} {
		if !tx.Migrator().HasTable(table.model) {
			continue
		}
		for _, column := range []struct {
			name  string
			field string
		}{
			{name: "upstream_model", field: "UpstreamModel"},
			{name: "state_check", field: "StateCheck"},
			{name: "state_check_reason", field: "StateCheckReason"},
			{name: "state_check_observed_blocks", field: "StateCheckObservedBlocks"},
			{name: "state_check_expected_blocks", field: "StateCheckExpectedBlocks"},
		} {
			if tx.Migrator().HasColumn(table.model, column.name) {
				continue
			}
			if err := tx.Migrator().AddColumn(table.model, column.field); err != nil {
				return fmt.Errorf("add %s.%s column: %w", table.name, column.name, err)
			}
		}
	}
	return nil
}
