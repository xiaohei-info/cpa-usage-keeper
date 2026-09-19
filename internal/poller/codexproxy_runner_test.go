package poller

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"cpa-usage-keeper/internal/codexproxy"
	"cpa-usage-keeper/internal/entities"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestCodexProxyRunnerPersistsCheckpointAndDeduplicatesReplay(t *testing.T) {
	status := 200
	latency := int64(42)
	page := map[string]any{
		"schema": "codex-proxy.keeper-event.v1", "after": 0, "next_cursor": 1,
		"has_more": false, "cursor_gap": false,
		"events": []any{map[string]any{
			"schema": "codex-proxy.keeper-event.v1", "event_id": "evt-1", "event_type": "request.completed",
			"occurred_at": "2026-09-18T09:00:00Z", "request_id": "req-1", "attempt_id": "attempt-1",
			"account_entry_id": "acct-1", "provider": "codex", "endpoint": "/v1/responses",
			"model": "gpt-5.6-sol", "status_code": status, "failed": false, "fallback": false,
			"latency_ms": latency, "usage": map[string]any{"input_tokens": 10, "output_tokens": 2, "cached_tokens": 4, "reasoning_tokens": 1},
		}},
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Errorf("missing auth")
		}
		if r.URL.Path == "/admin/integration/keeper/accounts" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"schema":"codex-proxy.keeper-account-metadata.v1","accounts":[{"account_entry_id":"acct-1","email":"user@example.com","status":"active"}]}`))
			return
		}
		if r.URL.Path != "/admin/integration/keeper/events" || r.URL.Query().Get("limit") != "10" {
			t.Errorf("unexpected endpoint: %s", r.URL)
		}
		after, _ := strconv.Atoi(r.URL.Query().Get("after"))
		page["after"] = after
		page["next_cursor"] = after + 1
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(page)
	}))
	defer server.Close()

	path := filepath.Join(t.TempDir(), "keeper.sqlite")
	db, err := gorm.Open(sqlite.Open(path), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&entities.UsageEvent{}, &entities.UsageIdentity{}, &entities.CodexProxyCheckpoint{}, &entities.CodexProxyEventIdentity{}); err != nil {
		t.Fatal(err)
	}
	runner := NewCodexProxyRunner(db, codexproxy.NewClient(server.URL, "test-token", time.Second), time.Second, 10)

	if err := runner.PullOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	if err := sqlDB.Close(); err != nil {
		t.Fatal(err)
	}
	db, err = gorm.Open(sqlite.Open(path), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err = db.DB()
	if err != nil {
		t.Fatal(err)
	}
	defer sqlDB.Close()
	runner = NewCodexProxyRunner(db, codexproxy.NewClient(server.URL, "test-token", time.Second), time.Second, 10)
	// Replay the same identity in a new page after reopening the persistent DB.
	if err := runner.PullOnce(context.Background()); err != nil {
		t.Fatal(err)
	}

	encoded, err := json.Marshal(page)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"request_body", "response_body", "request_headers", "response_headers", "prompt"} {
		if strings.Contains(string(encoded), key) {
			t.Fatalf("metadata fixture leaks %s", key)
		}
	}
	var events []entities.UsageEvent
	if err := db.Find(&events).Error; err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 {
		t.Fatalf("expected one usage event after replay, got %d", len(events))
	}
	var identity entities.UsageIdentity
	if err := db.Where("auth_type = ? AND identity = ?", entities.UsageIdentityAuthTypeCodexProxy, "acct-1").First(&identity).Error; err != nil {
		t.Fatal(err)
	}
	if identity.IsDeleted || identity.Name != "user@example.com" {
		t.Fatalf("unexpected synced identity: %+v", identity)
	}
	if events[0].AuthIndex != "acct-1" || events[0].TotalTokens != 12 || events[0].CachedTokens != 4 || events[0].Failed {
		t.Fatalf("unexpected mapped event: %+v", events[0])
	}
	var checkpoint entities.CodexProxyCheckpoint
	if err := db.First(&checkpoint).Error; err != nil {
		t.Fatal(err)
	}
	if checkpoint.Cursor != 2 {
		t.Fatalf("expected checkpoint 2, got %d", checkpoint.Cursor)
	}
}
