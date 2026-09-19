package codexproxy

import (
	"encoding/json"
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

func TestDownstreamTransportMapping(t *testing.T) {
	for _, tc := range []struct{ transport, endpoint, want string }{
		{"sse", "/codex/responses", "POST /codex/responses"},
		{"http", "/codex/responses", "/codex/responses"},
		{"", "/codex/responses", "/codex/responses"},
		{"unknown", "/codex/responses", "/codex/responses"},
		{"sse", "POST /codex/responses", "POST /codex/responses"},
		{"sse", "GET /codex/responses", "GET /codex/responses"},
	} {
		for _, failed := range []bool{false, true} {
			kind := "request.completed"
			if failed {
				kind = "request.failed"
			}
			e := Event{EventID: "fixture", RequestID: "request", EventType: kind, Failed: failed, Endpoint: tc.endpoint, DownstreamTransport: tc.transport, Usage: &Usage{InputTokens: 56509, OutputTokens: 167, ReasoningTokens: 13}}
			got, err := e.UsageEvent(time.Now())
			if err != nil || got.Endpoint != tc.want || got.ReasoningTokens != 13 || got.TotalTokens != 56676 {
				t.Fatalf("%+v: %+v %v", tc, got, err)
			}
		}
	}
}

func TestEventDecodesOptionalTransport(t *testing.T) {
	for _, transport := range []string{"", "sse", "http", "future"} {
		payload := `{"event_id":"fixture","request_id":"request","event_type":"request.completed","endpoint":"/codex/responses"}`
		if transport != "" {
			payload = payload[:len(payload)-1] + `,"downstream_transport":"` + transport + `"}`
		}
		var event Event
		if err := json.Unmarshal([]byte(payload), &event); err != nil {
			t.Fatal(err)
		}
		if event.DownstreamTransport != transport {
			t.Fatalf("%+v", event)
		}
	}
}
