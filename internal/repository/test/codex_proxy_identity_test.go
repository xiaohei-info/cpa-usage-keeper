package test

import (
	"context"
	"testing"
	"time"

	"cpa-usage-keeper/internal/entities"
	"cpa-usage-keeper/internal/repository"
)

func TestCodexProxyIdentitySyncKeepsSourceDedicatedAndAggregatesOAuthEvents(t *testing.T) {
	db := openTestDatabase(t)
	ctx := context.Background()
	now := time.Date(2026, 9, 19, 0, 0, 0, 0, time.UTC)
	if err := repository.ReplaceUsageIdentitiesForAuthType(ctx, db, []entities.UsageIdentity{{
		Name: "user@example.com", Alias: stringPtr("Work"), AuthType: entities.UsageIdentityAuthTypeCodexProxy,
		AuthTypeName: "codex-proxy", Identity: "entry-1", Type: "codex-proxy-account", Provider: "Codex Proxy",
	}}, entities.UsageIdentityAuthTypeCodexProxy, now); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&entities.UsageEvent{
		EventKey: "codex-event", AuthType: "oauth", AuthIndex: "entry-1", Source: "codex-proxy",
		Provider: "codex", Model: "gpt-6-astra", Timestamp: now, InputTokens: 10, OutputTokens: 2, TotalTokens: 12,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := repository.AggregateUsageIdentityStats(ctx, db, now); err != nil {
		t.Fatal(err)
	}
	var identity entities.UsageIdentity
	if err := db.Where("auth_type = ? AND identity = ?", entities.UsageIdentityAuthTypeCodexProxy, "entry-1").First(&identity).Error; err != nil {
		t.Fatal(err)
	}
	if identity.IsDeleted || identity.TotalRequests != 1 || identity.TotalTokens != 12 {
		t.Fatalf("identity=%+v", identity)
	}
}

func stringPtr(value string) *string { return &value }
