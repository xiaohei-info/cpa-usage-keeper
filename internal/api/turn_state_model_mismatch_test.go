package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"cpa-usage-keeper/internal/auth"
	"cpa-usage-keeper/internal/repository"
)

type modelSubstitutionStub struct {
	rangeSeen string
	snapshot  repository.ModelSubstitutionSnapshot
	fail      bool
}

func (s *modelSubstitutionStub) ModelSubstitution(_ context.Context, rangeValue string, now time.Time) (repository.ModelSubstitutionSnapshot, error) {
	s.rangeSeen = rangeValue
	if s.fail {
		return repository.ModelSubstitutionSnapshot{}, context.DeadlineExceeded
	}
	if s.snapshot.Window.Range != "" {
		return s.snapshot, nil
	}
	window, err := repository.ParseModelSubstitutionWindow(rangeValue, now)
	if err != nil {
		return repository.ModelSubstitutionSnapshot{}, err
	}
	return repository.EmptyModelSubstitutionSnapshot(window), nil
}

func modelSubstitutionTestRouter(t *testing.T, provider ModelSubstitutionProvider) (*auth.SessionManager, AuthConfig, http.Handler) {
	t.Helper()
	sessions := auth.NewSessionManager(time.Hour)
	cfg := AuthConfig{Enabled: true, LoginPassword: "test", SessionTTL: time.Hour}
	router := NewRouter(nil, nil, nil, nil, cfg, NewAuthHandler(cfg, sessions), "/keeper", OptionalProviders{ModelSubstitution: provider})
	return sessions, cfg, router
}

func TestModelSubstitutionRequiresAdminAndRejectsMutations(t *testing.T) {
	sessions, _, router := modelSubstitutionTestRouter(t, &modelSubstitutionStub{})
	admin, _, err := sessions.Create()
	if err != nil {
		t.Fatal(err)
	}
	viewer, _, err := sessions.CreateAPIKeyViewer(42)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name   string
		token  string
		method string
		path   string
		status int
	}{
		{name: "admin", token: admin, method: http.MethodGet, path: "/keeper/api/v1/turn-state/model-mismatch", status: http.StatusOK},
		{name: "anonymous", method: http.MethodGet, path: "/keeper/api/v1/turn-state/model-mismatch", status: http.StatusUnauthorized},
		{name: "key viewer denied", token: viewer, method: http.MethodGet, path: "/keeper/api/v1/turn-state/model-mismatch", status: http.StatusForbidden},
		{name: "post rejected", token: admin, method: http.MethodPost, path: "/keeper/api/v1/turn-state/model-mismatch", status: http.StatusNotFound},
		{name: "delete rejected", token: admin, method: http.MethodDelete, path: "/keeper/api/v1/turn-state/model-mismatch", status: http.StatusNotFound},
		{name: "put rejected", token: admin, method: http.MethodPut, path: "/keeper/api/v1/turn-state/model-mismatch", status: http.StatusNotFound},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, tc.path, nil)
			if tc.token != "" {
				req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: tc.token})
			}
			resp := httptest.NewRecorder()
			router.ServeHTTP(resp, req)
			if resp.Code != tc.status {
				t.Fatalf("got %d want %d: %s", resp.Code, tc.status, resp.Body.String())
			}
			if tc.status == http.StatusOK && resp.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("missing no-store")
			}
		})
	}
}

func TestModelSubstitutionEmptyPayloadIsExplicit(t *testing.T) {
	sessions, _, router := modelSubstitutionTestRouter(t, &modelSubstitutionStub{})
	admin, _, err := sessions.Create()
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/keeper/api/v1/turn-state/model-mismatch?range=24h", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: admin})
	resp := httptest.NewRecorder()
	router.ServeHTTP(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("got %d: %s", resp.Code, resp.Body.String())
	}

	var payload modelSubstitutionResponse
	if err := json.Unmarshal(resp.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if payload.Schema != repository.ModelSubstitutionSchema || payload.Range != "24h" {
		t.Fatalf("unexpected envelope: %+v", payload)
	}
	// 空窗口必须显式声明 empty，且一致率是 null 而不是 0%，否则会被读成“全部一致”。
	if !payload.Summary.Empty || payload.Summary.MatchRate != nil || payload.Summary.RequestsWithModel != 0 {
		t.Fatalf("expected explicit empty summary: %+v", payload.Summary)
	}
	if payload.Summary.Mismatched != 0 || payload.Summary.Matched != 0 || payload.Summary.TopSubstitution != nil {
		t.Fatalf("expected zero counts and no top substitution: %+v", payload.Summary)
	}
	if len(payload.Series) != 24 || len(payload.Matrix) != 0 || len(payload.Substitutions) != 0 {
		t.Fatalf("expected 24 aligned empty buckets and no rows: %+v", payload)
	}
	for _, point := range payload.Series {
		if point.MatchRate != nil || point.StateCheckFailureRate != nil {
			t.Fatalf("empty bucket must not report a rate: %+v", point)
		}
	}
	// 非白名单范围必须回显实际生效的范围，而不是原样透传。
	unknown := httptest.NewRequest(http.MethodGet, "/keeper/api/v1/turn-state/model-mismatch?range=99d", nil)
	unknown.AddCookie(&http.Cookie{Name: sessionCookieName, Value: admin})
	unknownResp := httptest.NewRecorder()
	router.ServeHTTP(unknownResp, unknown)
	var clamped modelSubstitutionResponse
	if err := json.Unmarshal(unknownResp.Body.Bytes(), &clamped); err != nil {
		t.Fatalf("decode clamped payload: %v", err)
	}
	if clamped.Range != repository.DefaultModelSubstitutionRange || len(clamped.Series) != 24 {
		t.Fatalf("expected clamping to the default range, got %+v", clamped)
	}
}

func TestModelSubstitutionSerialisesBothSeriesAndMatrix(t *testing.T) {
	now := time.Date(2026, 9, 21, 12, 30, 0, 0, time.Local)
	window, err := repository.ParseModelSubstitutionWindow("1h", now)
	if err != nil {
		t.Fatal(err)
	}
	provider := &modelSubstitutionStub{snapshot: repository.ModelSubstitutionSnapshot{
		Window:  window,
		Summary: repository.UpstreamModelMatchStats{Total: 4, Matched: 1},
		Buckets: []repository.ModelSubstitutionBucket{
			{Start: window.BucketStarts[0], Match: repository.UpstreamModelMatchStats{Total: 4, Matched: 1}, StateCheckObserved: 3, StateCheckFailed: 2},
			{Start: window.BucketStarts[1]},
		},
		Matrix: []repository.ModelSubstitutionCell{
			{RequestedModel: "gpt-6-astra", UpstreamModel: "gpt-5.6-luna", Count: 3, Share: 0.75, Matched: false},
			{RequestedModel: "gpt-6-astra", UpstreamModel: "gpt-6-astra", Count: 1, Share: 0.25, Matched: true},
		},
		Models: []repository.ModelSubstitutionModelStats{
			{RequestedModel: "gpt-6-astra", Match: repository.UpstreamModelMatchStats{Total: 4, Matched: 1}},
		},
		Top: &repository.ModelSubstitutionTopSubstitution{From: "gpt-6-astra", To: "gpt-5.6-luna", Count: 3},
	}}
	sessions, _, router := modelSubstitutionTestRouter(t, provider)
	admin, _, err := sessions.Create()
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/keeper/api/v1/turn-state/model-mismatch?range=1h", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: admin})
	resp := httptest.NewRecorder()
	router.ServeHTTP(resp, req)

	var payload modelSubstitutionResponse
	if err := json.Unmarshal(resp.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if payload.Summary.Mismatched != 3 || payload.Summary.MatchRate == nil || *payload.Summary.MatchRate != 25 {
		t.Fatalf("unexpected summary: %+v", payload.Summary)
	}
	if payload.Summary.TopSubstitution == nil || payload.Summary.TopSubstitution.Count != 3 {
		t.Fatalf("unexpected top substitution: %+v", payload.Summary.TopSubstitution)
	}
	first := payload.Series[0]
	if first.MatchRate == nil || *first.MatchRate != 25 || first.Mismatched != 3 {
		t.Fatalf("unexpected match series point: %+v", first)
	}
	// 两条曲线共用桶但各有自己的分母。
	if first.StateCheckFailureRate == nil || *first.StateCheckFailureRate < 66.6 || *first.StateCheckFailureRate > 66.7 {
		t.Fatalf("unexpected state-check rate: %+v", first)
	}
	if payload.Series[1].StateCheckFailureRate != nil {
		t.Fatalf("expected missing state-check sample to stay null: %+v", payload.Series[1])
	}
	if len(payload.Matrix) != 2 || payload.Matrix[0].Matched || payload.Matrix[0].Share != 0.75 {
		t.Fatalf("unexpected matrix: %+v", payload.Matrix)
	}
	if len(payload.Substitutions) != 1 || payload.Substitutions[0].Mismatched != 3 {
		t.Fatalf("unexpected substitutions: %+v", payload.Substitutions)
	}
	if provider.rangeSeen != "1h" {
		t.Fatalf("expected the requested range to reach the provider, got %q", provider.rangeSeen)
	}
}

func TestModelSubstitutionUnconfiguredProviderStillReturnsEmptySnapshot(t *testing.T) {
	sessions, _, router := modelSubstitutionTestRouter(t, nil)
	admin, _, err := sessions.Create()
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/keeper/api/v1/turn-state/model-mismatch", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: admin})
	resp := httptest.NewRecorder()
	router.ServeHTTP(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("got %d: %s", resp.Code, resp.Body.String())
	}
	var payload modelSubstitutionResponse
	if err := json.Unmarshal(resp.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if !payload.Summary.Empty || payload.Range != repository.DefaultModelSubstitutionRange {
		t.Fatalf("unexpected unconfigured payload: %+v", payload)
	}
}
