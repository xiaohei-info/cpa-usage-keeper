package codexproxy

import (
	"encoding/json"
	"testing"
	"time"

	"cpa-usage-keeper/internal/entities"
	"cpa-usage-keeper/internal/repository"
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

// 探测事件必须落到独立 api_group_key，否则它会混进业务统计；同一条事件去掉 probe
// 标记后又必须回到业务分组。这是探测与业务数据的唯一隔离点。
func TestProbeEventsMapToTheirOwnAPIGroupKey(t *testing.T) {
	base := Event{
		Schema: "codex-proxy.keeper-event.v1", EventID: "e1", EventType: "request.completed",
		RequestID: "r1", AttemptID: "a1", AccountEntryID: "acct", Provider: "codex",
		Endpoint: "/codex/responses", Model: "gpt-5.6-sol", Failed: false,
	}
	probe := base
	probe.Probe = boolPointer(true)
	mapped, err := probe.UsageEvent(time.Now())
	if err != nil {
		t.Fatalf("UsageEvent returned error: %v", err)
	}
	if mapped.APIGroupKey != repository.CodexProxyProbeAPIGroupKey {
		t.Fatalf("probe event api_group_key = %q, want %q", mapped.APIGroupKey, repository.CodexProxyProbeAPIGroupKey)
	}
	// source 保持不变：探测确实也是 codex-proxy 产出的。
	if mapped.Source != repository.CodexProxySource {
		t.Fatalf("probe event source = %q, want %q", mapped.Source, repository.CodexProxySource)
	}

	// 缺省（旧 producer 不返回该字段）与显式 false 都必须留在业务分组。
	for _, tc := range []struct {
		name  string
		probe *bool
	}{
		{name: "absent", probe: nil},
		{name: "explicit false", probe: boolPointer(false)},
	} {
		event := base
		event.Probe = tc.probe
		business, err := event.UsageEvent(time.Now())
		if err != nil {
			t.Fatalf("%s: UsageEvent returned error: %v", tc.name, err)
		}
		if business.APIGroupKey != base.Provider {
			t.Fatalf("%s: api_group_key = %q, want business group %q", tc.name, business.APIGroupKey, base.Provider)
		}
	}
}

func boolPointer(value bool) *bool { return &value }
