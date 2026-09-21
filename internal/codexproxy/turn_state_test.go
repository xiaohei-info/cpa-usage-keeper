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

func TestTurnStateOverviewKeepsAdditiveContractFields(t *testing.T) {
	fixture, err := os.ReadFile("testdata/turn_state_overview.json")
	if err != nil {
		t.Fatal(err)
	}
	// A current proxy emits the §8.2/§8.3 fields; the whitelist decoder used to drop
	// them silently, which made every Keeper status/failure path unreachable.
	sessionAdditive := `"excluded": false, "last_upstream_model": "gpt-5.6-luna", "model_mismatch": true, ` +
		`"last_result": "block_mismatch", "ws_connection_reused": 30, "plan_provenance": "account", ` +
		`"last_failure": {"code": "block_mismatch", "reason": "block_mismatch", "verdict": "shape_mismatch", ` +
		`"observed_blocks": 11, "expected_blocks": 10}, `
	eventAdditive := `"reason": "block_mismatch", "observed_blocks": 11, "expected_blocks": 10, ` +
		`"upstream_model": "gpt-5.6-luna", "verdict": "shape_mismatch", `
	// Anchor inside the session/event objects only: `account_mode` also exists in config.
	body := strings.Replace(string(fixture), `"entry_id": "entry-1",`, sessionAdditive+`"entry_id": "entry-1",`, 1)
	body = strings.Replace(body, `"source":`, eventAdditive+`"source":`, 1)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(body))
	}))
	defer server.Close()

	got, err := NewClient(server.URL, "test-token", time.Second).TurnStateOverview(context.Background())
	if err != nil {
		t.Fatalf("additive snapshot rejected: %v", err)
	}
	session := got.Sessions[0]
	if session.Excluded == nil || *session.Excluded {
		t.Fatalf("excluded not decoded: %#v", session.Excluded)
	}
	if session.LastUpstreamModel == nil || *session.LastUpstreamModel != "gpt-5.6-luna" {
		t.Fatalf("last_upstream_model not decoded: %#v", session.LastUpstreamModel)
	}
	if session.ModelMismatch == nil || !*session.ModelMismatch {
		t.Fatalf("model_mismatch not decoded: %#v", session.ModelMismatch)
	}
	if session.LastResult == nil || *session.LastResult != "block_mismatch" {
		t.Fatalf("last_result not decoded: %#v", session.LastResult)
	}
	if session.WsConnectionReused == nil || *session.WsConnectionReused != 30 {
		t.Fatalf("ws_connection_reused not decoded: %#v", session.WsConnectionReused)
	}
	if session.PlanProvenance == nil || *session.PlanProvenance != "account" {
		t.Fatalf("plan_provenance not decoded: %#v", session.PlanProvenance)
	}
	if session.LastFailure == nil || session.LastFailure.ObservedBlocks == nil || *session.LastFailure.ObservedBlocks != 11 {
		t.Fatalf("last_failure not decoded: %#v", session.LastFailure)
	}
	event := got.Events[0]
	if event.Reason == nil || *event.Reason != "block_mismatch" || event.UpstreamModel == nil || *event.UpstreamModel != "gpt-5.6-luna" || event.Verdict == nil {
		t.Fatalf("event additive fields not decoded: %#v", event)
	}

	// The re-serialized snapshot (what /api/v1/turn-state/overview serves) must keep them.
	data, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"last_failure", "last_upstream_model", "model_mismatch", "last_result", "excluded", "plan_provenance", "upstream_model", "verdict"} {
		if !strings.Contains(string(data), `"`+key+`"`) {
			t.Fatalf("%s dropped on re-serialization", key)
		}
	}
}

func TestTurnStateOverviewAcceptsOlderSnapshotWithoutAdditiveFields(t *testing.T) {
	fixture, err := os.ReadFile("testdata/turn_state_overview.json")
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(fixture)
	}))
	defer server.Close()
	got, err := NewClient(server.URL, "test-token", time.Second).TurnStateOverview(context.Background())
	if err != nil {
		t.Fatalf("older snapshot rejected: %v", err)
	}
	if got.Sessions[0].LastFailure != nil || got.Sessions[0].Excluded != nil {
		t.Fatal("absent additive field must stay nil, not become a value")
	}
}

func TestTurnStateOverviewRejectsInvalidAdditiveValues(t *testing.T) {
	fixture, err := os.ReadFile("testdata/turn_state_overview.json")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ name, body string }{
		{"bad verdict", strings.Replace(string(fixture), `"entry_id": "entry-1",`, `"last_result": "Not A Code", "entry_id": "entry-1",`, 1)},
		{"bad plan provenance", strings.Replace(string(fixture), `"entry_id": "entry-1",`, `"plan_provenance": "guessed", "entry_id": "entry-1",`, 1)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			if _, err := NewClient(server.URL, "test-token", time.Second).TurnStateOverview(context.Background()); err == nil {
				t.Fatal("invalid additive value must reject the snapshot")
			}
		})
	}
}

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
