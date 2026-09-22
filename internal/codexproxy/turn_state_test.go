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

func TestTurnStateOverviewKeepsFlattenedProxyConfig(t *testing.T) {
	fixture, err := os.ReadFile("testdata/turn_state_overview.json")
	if err != nil {
		t.Fatal(err)
	}
	body := strings.Replace(string(fixture), `"max_attempts_per_round": 0
  }`, `"max_attempts_per_round": 0,
    "harvest_proxy_url": null,
    "revalidate": true,
    "mismatch_is_success": false,
    "revoke_after_signals": 2
  }`, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(body))
	}))
	defer server.Close()

	got, err := NewClient(server.URL, "test-token", time.Second).TurnStateOverview(context.Background())
	if err != nil {
		t.Fatalf("flattened config snapshot rejected: %v", err)
	}
	if got.Config.HarvestProxyURL != nil {
		t.Fatalf("null harvest proxy should remain nil: %#v", got.Config.HarvestProxyURL)
	}
	if got.Config.Revalidate == nil || !*got.Config.Revalidate {
		t.Fatalf("revalidate not decoded: %#v", got.Config.Revalidate)
	}
	if got.Config.MismatchIsSuccess == nil || *got.Config.MismatchIsSuccess {
		t.Fatalf("mismatch_is_success not decoded: %#v", got.Config.MismatchIsSuccess)
	}
	if got.Config.RevokeAfterSignals == nil || *got.Config.RevokeAfterSignals != 2 {
		t.Fatalf("revoke_after_signals not decoded: %#v", got.Config.RevokeAfterSignals)
	}

	data, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"revalidate", "mismatch_is_success", "revoke_after_signals"} {
		if !strings.Contains(string(data), `"`+key+`"`) {
			t.Fatalf("%s dropped on re-serialization", key)
		}
	}
}

// The proxy's ticket layer emits source:"ticket" (codex-proxy 4b74a74). Before it was
// whitelisted, a single ticket event made validateTurnState reject the WHOLE overview, so
// turning ticket mode on silently took the Keeper status page down (P0-1).
func TestTurnStateOverviewAcceptsTicketSource(t *testing.T) {
	fixture, err := os.ReadFile("testdata/turn_state_overview.json")
	if err != nil {
		t.Fatal(err)
	}
	body := strings.Replace(string(fixture), `"source": "active"`, `"source": "ticket"`, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(body))
	}))
	defer server.Close()

	got, err := NewClient(server.URL, "test-token", time.Second).TurnStateOverview(context.Background())
	if err != nil {
		t.Fatalf("ticket-source snapshot rejected: %v", err)
	}
	if got.Events[0].Source != "ticket" {
		t.Fatalf("ticket source not decoded: %#v", got.Events[0].Source)
	}
}

// The 200-event cap stays fail-closed: an over-emitting producer is fixed at the source
// (the proxy truncates the merged list), never tolerated here.
func TestTurnStateOverviewRejectsEventsOverCap(t *testing.T) {
	fixture, err := os.ReadFile("testdata/turn_state_overview.json")
	if err != nil {
		t.Fatal(err)
	}
	var snapshot TurnStateOverview
	if err = json.Unmarshal(fixture, &snapshot); err != nil {
		t.Fatal(err)
	}
	snapshot.Events = make([]TurnStateEvent, 201)
	data, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if validateTurnState(data, reflect.TypeOf(TurnStateOverview{}), "") {
		t.Fatal("201 events must be rejected: the cap is a fail-closed contract, not a tolerance")
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

// The merged active-collection counters (§3.1 of the observability contract) plus the
// cumulative window start must survive the whitelist decode and re-serialization; without
// them Keeper shows only the generic-probe numbers and reports 0 on a personal account
// whose collection runs entirely through the ticket path.
func TestTurnStateOverviewKeepsActiveAttemptMetrics(t *testing.T) {
	fixture, err := os.ReadFile("testdata/turn_state_overview.json")
	if err != nil {
		t.Fatal(err)
	}
	body := strings.Replace(string(fixture),
		`"active_probes": 0,`,
		`"active_probes": 0, "active_attempts": 13, "active_accepted": 1, "active_rejected": 12, "since": "2026-09-21T00:00:00Z",`, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(body))
	}))
	defer server.Close()

	got, err := NewClient(server.URL, "test-token", time.Second).TurnStateOverview(context.Background())
	if err != nil {
		t.Fatalf("active-attempt metrics snapshot rejected: %v", err)
	}
	if got.Summary.ActiveAttempts == nil || *got.Summary.ActiveAttempts != 13 {
		t.Fatalf("active_attempts not decoded: %#v", got.Summary.ActiveAttempts)
	}
	if got.Summary.ActiveAccepted == nil || *got.Summary.ActiveAccepted != 1 {
		t.Fatalf("active_accepted not decoded: %#v", got.Summary.ActiveAccepted)
	}
	if got.Summary.ActiveRejected == nil || *got.Summary.ActiveRejected != 12 {
		t.Fatalf("active_rejected not decoded: %#v", got.Summary.ActiveRejected)
	}
	if got.Summary.Since == nil || *got.Summary.Since != "2026-09-21T00:00:00Z" {
		t.Fatalf("since not decoded: %#v", got.Summary.Since)
	}

	data, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"active_attempts", "active_accepted", "active_rejected", "since"} {
		if !strings.Contains(string(data), `"`+key+`"`) {
			t.Fatalf("%s dropped on re-serialization", key)
		}
	}

	// The older-proxy fixture (no merged counters) must still be accepted and must not
	// invent zero values for fields the producer never sent.
	older := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(fixture)
	}))
	defer older.Close()
	legacy, err := NewClient(older.URL, "test-token", time.Second).TurnStateOverview(context.Background())
	if err != nil {
		t.Fatalf("older snapshot rejected: %v", err)
	}
	if legacy.Summary.ActiveAttempts != nil || legacy.Summary.Since != nil {
		t.Fatal("absent merged metric must stay nil, not become a value")
	}
}

// `since` is a timestamp: a non-ISO value must be rejected exactly like server_time.
func TestTurnStateOverviewRejectsInvalidSince(t *testing.T) {
	fixture, err := os.ReadFile("testdata/turn_state_overview.json")
	if err != nil {
		t.Fatal(err)
	}
	body := strings.Replace(string(fixture),
		`"active_probes": 0,`,
		`"active_probes": 0, "since": "not-a-time",`, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(body))
	}))
	defer server.Close()
	if _, err := NewClient(server.URL, "test-token", time.Second).TurnStateOverview(context.Background()); err == nil {
		t.Fatal("non-ISO since must reject the snapshot")
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
