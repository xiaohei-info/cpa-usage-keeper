package api

import (
	"cpa-usage-keeper/internal/entities"
	servicedto "cpa-usage-keeper/internal/service/dto"
	"testing"
)

func TestCodexIdentityUsesExistingSourceDisplay(t *testing.T) {
	identity := entities.UsageIdentity{AuthType: entities.UsageIdentityAuthTypeCodexProxy, Identity: "entry-1", Name: "account@example.com", Provider: "Codex Proxy"}
	resolved, matched := newUsageIdentityResolver([]entities.UsageIdentity{identity}).resolveByAuthIndex("entry-1")
	label, deleted := usageEventPublicSource(servicedto.UsageEventRecord{AuthIndex: "entry-1", AuthType: "oauth", Source: "codex-proxy"}, resolved, matched)
	if !matched || deleted || label != "account@example.com (Codex Proxy)" {
		t.Fatalf("label=%q deleted=%v matched=%v", label, deleted, matched)
	}
	if _, ok := usageSourceFilterOptionFromIdentity(identity); !ok {
		t.Fatal("Codex identity missing from source filters")
	}
}
