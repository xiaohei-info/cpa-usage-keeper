package codexproxy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestTurnStateOverview(t *testing.T) {
	fixture, err := os.ReadFile("testdata/turn_state_overview.json")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name   string
		status int
		body   string
		valid  bool
	}{
		{"valid", 200, string(fixture), true},
		{"additive secret stripped", 200, strings.Replace(string(fixture), `"epoch":`, `"secret":"never-forward", "epoch":`, 1), true},
		{"old backend", 404, "secret", false}, {"auth", 401, "secret", false}, {"forbidden", 403, "secret", false},
		{"missing required", 200, strings.Replace(string(fixture), `"enabled": false,`, "", 1), false},
		{"null required", 200, strings.Replace(string(fixture), `"sessions": [`, `"sessions": null, "unused": [`, 1), false},
		{"wrong schema", 200, strings.Replace(string(fixture), TurnStateSchema, "old", 1), false},
		{"raw diagnostic", 200, strings.Replace(string(fixture), `"diagnostic": null`, `"diagnostic": "Bearer secret"`, 1), false},
		{"trailing data", 200, string(fixture) + `{}`, false},
		{"oversize", 200, string(fixture) + strings.Repeat(" ", 2<<20), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "GET" || r.URL.Path != "/admin/integration/keeper/turn-state/overview" || r.Header.Get("Authorization") != "Bearer test-token" {
					t.Error("wrong request")
				}
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			got, err := NewClient(server.URL, "test-token", time.Second).TurnStateOverview(context.Background())
			if (err == nil) != tc.valid {
				t.Fatalf("valid=%v err=%v", tc.valid, err)
			}
			if err != nil && strings.Contains(err.Error(), "secret") {
				t.Fatal("error leak")
			}
			if tc.valid {
				data, _ := json.Marshal(got)
				if strings.Contains(string(data), "never-forward") {
					t.Fatal("additive field leak")
				}
				if got.Events[0].Usage != nil {
					t.Fatal("unknown usage became known")
				}
			}
		})
	}
	t.Run("cancelled", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		_, err := NewClient("http://127.0.0.1:1", "", time.Millisecond).TurnStateOverview(ctx)
		if err == nil {
			t.Fatal("expected unavailable")
		}
	})
}

func TestTurnStateBoundsAndState(t *testing.T) {
	fixture, err := os.ReadFile("testdata/turn_state_overview.json")
	if err != nil {
		t.Fatal(err)
	}
	var snapshot TurnStateOverview
	if err = json.Unmarshal(fixture, &snapshot); err != nil {
		t.Fatal(err)
	}
	snapshot.Sessions[0].Active = &TurnStateSummary{Usable: true, Length: 184, Blocks: 10, Fingerprint: "abcdef012345", IssuedAt: "2026-09-22T00:00:00Z", ExpiresAt: "2026-09-22T01:00:00Z", Version: 1}
	for _, tc := range []struct {
		name   string
		mutate func(*TurnStateOverview)
		valid  bool
	}{
		{"state", func(*TurnStateOverview) {}, true},
		{"fingerprint token", func(s *TurnStateOverview) { s.Sessions[0].Active.Fingerprint = "raw-token" }, false},
		{"timestamp", func(s *TurnStateOverview) { s.ServerTime = "not-time" }, false},
		{"events cap", func(s *TurnStateOverview) { s.Events = make([]TurnStateEvent, 201) }, false},
		{"session cap", func(s *TurnStateOverview) { s.Sessions = make([]TurnStateSession, 1001) }, false},
		{"negative", func(s *TurnStateOverview) { s.Summary.InjectionCount = -1 }, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			data, _ := json.Marshal(snapshot)
			var copied TurnStateOverview
			_ = json.Unmarshal(data, &copied)
			tc.mutate(&copied)
			data, _ = json.Marshal(copied)
			if validateTurnState(data, reflect.TypeOf(TurnStateOverview{}), "") != tc.valid {
				t.Fatal("unexpected validation result")
			}
		})
	}
}
func TestTurnStateTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() }))
	defer server.Close()
	_, err := NewClient(server.URL, "", 10*time.Millisecond).TurnStateOverview(context.Background())
	if err == nil {
		t.Fatal("expected timeout")
	}
}
