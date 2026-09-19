package service

import (
	"cpa-usage-keeper/internal/codexproxy"
	"cpa-usage-keeper/internal/entities"
	"testing"
)

type codexQuotaStub struct{}

func (codexQuotaStub) CodexQuota(id string) (codexproxy.QuotaSnapshot, bool) {
	return codexproxy.QuotaSnapshot{Status: "active"}, id == "shared"
}

func TestCodexQuotaExtensionDoesNotEnrichCPAIdentities(t *testing.T) {
	service := &usageIdentityService{codexQuotaProvider: codexQuotaStub{}}
	for _, authType := range []entities.UsageIdentityAuthType{entities.UsageIdentityAuthTypeAuthFile, entities.UsageIdentityAuthTypeAIProvider} {
		if snapshots := service.codexQuotaSnapshots([]entities.UsageIdentity{{Identity: "shared", AuthType: authType}}); len(snapshots) != 0 {
			t.Fatalf("enriched CPA identity %d", authType)
		}
	}
	snapshots := service.codexQuotaSnapshots([]entities.UsageIdentity{{Identity: "shared", AuthType: entities.UsageIdentityAuthTypeCodexProxy}, {Identity: "absent", AuthType: entities.UsageIdentityAuthTypeCodexProxy}})
	if len(snapshots) != 1 || snapshots["shared"].Status != "active" || snapshots["shared"].Quota != nil {
		t.Fatal("invalid optional quota projection")
	}
	service.codexQuotaProvider = nil
	if len(service.codexQuotaSnapshots([]entities.UsageIdentity{{Identity: "shared", AuthType: entities.UsageIdentityAuthTypeCodexProxy}})) != 0 {
		t.Fatal("invented quota without provider")
	}
}
