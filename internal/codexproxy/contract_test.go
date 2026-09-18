package codexproxy

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestPullRejectsInvalidProgressAndEvents(t *testing.T) {
	baseEvent := `{"schema":"codex-proxy.keeper-event.v1","event_id":"e1","event_type":"request.completed","occurred_at":"2026-01-01T00:00:00Z","request_id":"r1","attempt_id":"a1","account_entry_id":"acct","provider":"codex","endpoint":"/v1/responses","model":"m","failed":false,"fallback":false}`
	cases := []struct {
		name string
		page string
	}{
		{"same cursor", `{"schema":"codex-proxy.keeper-event.v1","after":7,"next_cursor":7,"events":[` + baseEvent + `]}`},
		{"backward cursor", `{"schema":"codex-proxy.keeper-event.v1","after":7,"next_cursor":6,"events":[]}`},
		{"wrong after", `{"schema":"codex-proxy.keeper-event.v1","after":6,"next_cursor":8,"events":[]}`},
		{"unsupported event type", `{"schema":"codex-proxy.keeper-event.v1","after":7,"next_cursor":8,"events":[` + strings.Replace(baseEvent, "request.completed", "request.failed", 1) + `]}`},
		{"wrong event schema", `{"schema":"codex-proxy.keeper-event.v1","after":7,"next_cursor":8,"events":[` + strings.Replace(baseEvent, "codex-proxy.keeper-event.v1", "other.v1", 1) + `]}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(tc.page))
			}))
			defer srv.Close()
			_, err := NewClient(srv.URL, "", time.Second).Pull(context.Background(), 7, 10)
			if err == nil {
				t.Fatal("expected contract validation error")
			}
		})
	}
}

func TestPullAcceptsEmptyPageWithoutProgress(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"schema":"codex-proxy.keeper-event.v1","after":7,"next_cursor":7,"has_more":false,"cursor_gap":false,"events":[]}`))
	}))
	defer srv.Close()
	page, err := NewClient(srv.URL, "", time.Second).Pull(context.Background(), 7, 10)
	if err != nil || page.NextCursor != 7 || len(page.Events) != 0 {
		t.Fatalf("page=%+v err=%v", page, err)
	}
}
