package migration

import (
	"fmt"

	"cpa-usage-keeper/internal/entities"
	"gorm.io/gorm"
)

// createCodexProxyTablesMigration 为既有数据库创建 Codex Proxy 事件游标表和事件去重表。
// 两张表只服务 Codex Proxy 数据源；CPA 行为与既有表结构完全不变。
func createCodexProxyTablesMigration(db *gorm.DB) error {
	if err := db.AutoMigrate(&entities.CodexProxyCheckpoint{}, &entities.CodexProxyEventIdentity{}); err != nil {
		return fmt.Errorf("create codex proxy tables: %w", err)
	}
	return nil
}
