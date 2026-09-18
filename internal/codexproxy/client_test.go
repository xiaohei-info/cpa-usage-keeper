package codexproxy

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"cpa-usage-keeper/internal/service/tokenprocessor"
)

func TestPullAndMap(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
	p, err := NewClient(srv.URL, "x", time.Second).Pull(context.Background(), 7, 10)
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
	if u.AuthIndex != "acct" || u.ExecutorType != tokenprocessor.CodexExecutor || u.TotalTokens != 12 || u.CachedTokens != 8 || u.ReasoningTokens != 1 || u.Failed {
		t.Fatalf("usage=%+v", u)
	}
}
