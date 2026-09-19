package codexproxy

import (
	"testing"
	"time"

	"cpa-usage-keeper/internal/entities"
)

func TestAccountUsageIdentityIsDedicatedAndNonSecret(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	identity := AccountUsageIdentity(AccountMetadata{
		AccountEntryID: "entry-1",
		Email:          "user@example.com",
		Label:          "Work",
		PlanType:       "pro",
		Status:         "active",
	}, now)
	if identity.AuthType != entities.UsageIdentityAuthTypeCodexProxy || identity.AuthTypeName != "codex-proxy" {
		t.Fatalf("identity type=%+v", identity)
	}
	if identity.Identity != "entry-1" || identity.Name != "user@example.com" || identity.Alias == nil || *identity.Alias != "Work" {
		t.Fatalf("identity=%+v", identity)
	}
	if identity.Provider != "Codex Proxy" || identity.Type != "codex-proxy-account" || identity.IsDeleted {
		t.Fatalf("identity source=%+v", identity)
	}
}
