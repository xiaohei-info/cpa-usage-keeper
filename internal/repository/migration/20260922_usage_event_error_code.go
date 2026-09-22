package migration

import (
	"fmt"

	"cpa-usage-keeper/internal/entities"

	"gorm.io/gorm"
)

// addUsageEventErrorCodeMigration 增加 producer 上报的稳定失败码列。
//
// 主动探测超时需要与普通传输失败区分开：两者旧口径下都会落成没有状态码的失败行，
// Keeper 无法判断到底是超时还是连不上。该列 additive，旧行落空串，不回填历史数据。
func addUsageEventErrorCodeMigration(tx *gorm.DB) error {
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
		if tx.Migrator().HasColumn(table.model, "error_code") {
			continue
		}
		if err := tx.Migrator().AddColumn(table.model, "ErrorCode"); err != nil {
			return fmt.Errorf("add %s.error_code column: %w", table.name, err)
		}
	}
	return nil
}
