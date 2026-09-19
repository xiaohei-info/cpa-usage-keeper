package codexproxy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"cpa-usage-keeper/internal/service/tokenprocessor"
)

func TestAccountsAndPullAndMap(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/admin/integration/keeper/accounts" {
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"schema":"codex-proxy.keeper-account-metadata.v1","status":"ready","accounts":[{"account_entry_id":"acct","email":"user@example.com","label":"Work","account_id":"account-1","plan_type":"pro","status":"active"}]}`))
			return
		}
		if r.URL.Query().Get("after") != "7" {
			t.Fatalf("after=%s", r.URL.Query().Get("after"))
		}
		if r.Header.Get("Authorization") != "Bearer x" {
			t.Fatalf("auth missing")
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"schema":"codex-proxy.keeper-event.v1","after":7,"next_cursor":8,"has_more":false,"cursor_gap":false,"events":[{"schema":"codex-proxy.keeper-event.v1","event_id":"e1","event_type":"request.completed","occurred_at":"2026-01-01T00:00:00Z","request_id":"r1","attempt_id":"a1","account_entry_id":"acct","provider":"codex","endpoint":"/v1/responses","model":"m","status_code":200,"failed":false,"fallback":false,"latency_ms":12,"usage":{"input_tokens":10,"output_tokens":2,"cached_tokens":8,"reasoning_tokens":1}}]}`))
	}))
	defer srv.Close()
	client := NewClient(srv.URL, "x", time.Second)
	accounts, err := client.Accounts(context.Background())
	if err != nil || len(accounts) != 1 || accounts[0].AccountEntryID != "acct" || accounts[0].Email != "user@example.com" {
		t.Fatalf("accounts=%+v err=%v", accounts, err)
	}
	p, err := client.Pull(context.Background(), 7, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Events) != 1 || p.NextCursor != 8 {
		t.Fatalf("page=%+v", p)
	}
	u, err := p.Events[0].UsageEvent(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if u.AuthIndex != "acct" || u.APIGroupKey != "codex" || u.ExecutorType != tokenprocessor.CodexExecutor || u.TotalTokens != 12 || u.CachedTokens != 8 || u.ReasoningTokens != 1 || u.Failed {
		t.Fatalf("usage=%+v", u)
	}
}

func TestPullRequiresProducerIDs(t *testing.T) {
	for _, missing := range []string{"", "event_id", "request_id", "attempt_id"} {
		t.Run("missing_"+missing, func(t *testing.T) {
			event := map[string]any{"schema": "codex-proxy.keeper-event.v1", "event_type": "request.completed", "event_id": "legacy-event", "request_id": "legacy-request", "attempt_id": "attempt-1", "failed": false}
			delete(event, missing)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				json.NewEncoder(w).Encode(map[string]any{"schema": "codex-proxy.keeper-event.v1", "after": 0, "next_cursor": 1, "events": []any{event}})
			}))
			defer server.Close()
			page, err := NewClient(server.URL, "", time.Second).Pull(context.Background(), 0, 10)
			if missing != "" {
				if err == nil {
					t.Fatal("accepted missing stable ID")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if page.Events[0].AttemptID != "attempt-1" {
				t.Fatal("changed producer attempt ID")
			}
			mapped, err := page.Events[0].UsageEvent(time.Now())
			if err != nil || mapped.EventKey != "legacy-event" || mapped.Source != "codex-proxy" {
				t.Fatalf("legacy mapping: %+v, %v", mapped, err)
			}
		})
	}
}

func TestPullMapsOptionalReasoningEffort(t *testing.T) {
	for _, tc := range []struct {
		name  string
		field map[string]any
		want  string
	}{
		{"absent", nil, ""},
		{"null", map[string]any{"reasoning_effort": nil}, ""},
		{"provided", map[string]any{"reasoning_effort": "low"}, "low"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			event := map[string]any{"schema": "codex-proxy.keeper-event.v1", "event_type": "request.completed", "event_id": "e1", "request_id": "r1", "attempt_id": "a1", "failed": false}
			for key, value := range tc.field {
				event[key] = value
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_ = json.NewEncoder(w).Encode(map[string]any{"schema": "codex-proxy.keeper-event.v1", "after": 0, "next_cursor": 1, "events": []any{event}})
			}))
			defer server.Close()
			page, err := NewClient(server.URL, "", time.Second).Pull(context.Background(), 0, 10)
			if err != nil {
				t.Fatal(err)
			}
			usage, err := page.Events[0].UsageEvent(time.Now())
			if err != nil {
				t.Fatal(err)
			}
			if usage.ReasoningEffort != tc.want {
				t.Fatalf("reasoning effort=%q, want %q", usage.ReasoningEffort, tc.want)
			}
		})
	}
}
