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

func TestModelSubstitutionSerialisesCurrentObservations(t *testing.T) {
	now := time.Date(2026, 9, 21, 12, 30, 0, 0, time.Local)
	window, err := repository.ParseModelSubstitutionWindow("1h", now)
	if err != nil {
		t.Fatal(err)
	}
	observedBlocks := int64(11)
	expectedBlocks := int64(10)
	provider := &modelSubstitutionStub{snapshot: repository.ModelSubstitutionSnapshot{
		Window:  window,
		Summary: repository.UpstreamModelMatchStats{Total: 2, Matched: 1},
		Buckets: []repository.ModelSubstitutionBucket{{Start: window.BucketStarts[0]}},
		// 最近观测：一行被替换并带判定细节，一行一致且判定 ok，一行未上报 state。
		Current: []repository.ModelSubstitutionCurrentObservation{
			{
				RequestedModel: "gpt-6-astra", UpstreamModel: "gpt-5.6-luna", Matched: false,
				ObservedAt: now.Add(-5 * time.Minute), AccountEntryID: "acct-1",
				StateCheck: "shape_mismatch", StateCheckReason: "block_mismatch",
				StateCheckObservedBlocks: &observedBlocks, StateCheckExpectedBlocks: &expectedBlocks,
			},
			{
				RequestedModel: "gpt-5.6-sol", UpstreamModel: "gpt-5.6-sol", Matched: true,
				ObservedAt: now.Add(-2 * time.Minute), StateCheck: "ok",
			},
			{
				// 未上报 state：字段必须是 null，而不是空串被读成正常。
				RequestedModel: "gpt-5.6-terra", UpstreamModel: "gpt-5.6-luna", Matched: false,
				ObservedAt: now.Add(-1 * time.Minute),
			},
		},
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

	// 用原始 JSON 断言 null 语义：结构体反序列化无法区分 null 与空串。
	var raw struct {
		Current []map[string]any `json:"current"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &raw); err != nil {
		t.Fatalf("decode raw payload: %v", err)
	}
	if len(raw.Current) != 3 {
		t.Fatalf("expected 3 current rows, got %d: %+v", len(raw.Current), raw.Current)
	}

	first := raw.Current[0]
	if first["requested_model"] != "gpt-6-astra" || first["upstream_model"] != "gpt-5.6-luna" || first["matched"] != false {
		t.Fatalf("unexpected first current row: %+v", first)
	}
	if first["state_check"] != "shape_mismatch" || first["state_check_reason"] != "block_mismatch" {
		t.Fatalf("state check not carried: %+v", first)
	}
	if first["state_check_observed_blocks"] != float64(11) || first["state_check_expected_blocks"] != float64(10) {
		t.Fatalf("block detail not carried: %+v", first)
	}
	if first["account_entry_id"] != "acct-1" {
		t.Fatalf("account entry id not carried: %+v", first)
	}
	// age_seconds 由服务端相对 now 计算，必须是非负整数而不是字符串。
	age, ok := first["age_seconds"].(float64)
	if !ok || age < 0 {
		t.Fatalf("expected a non-negative numeric age, got %#v", first["age_seconds"])
	}
	if observed, ok := first["observed_at"].(string); !ok || observed == "" {
		t.Fatalf("expected an observed_at string, got %#v", first["observed_at"])
	}

	// 未上报 state 的行必须是显式 null。
	third := raw.Current[2]
	if value, present := third["state_check"]; !present || value != nil {
		t.Fatalf("expected a null state_check for an unreported row, got %#v", value)
	}
	if value, present := third["state_check_reason"]; !present || value != nil {
		t.Fatalf("expected a null state_check_reason for an unreported row, got %#v", value)
	}
	if value, present := third["account_entry_id"]; !present || value != nil {
		t.Fatalf("expected a null account_entry_id when unset, got %#v", value)
	}
}

func TestModelSubstitutionEmptySnapshotReturnsEmptyCurrentArray(t *testing.T) {
	provider := &modelSubstitutionStub{}
	sessions, _, router := modelSubstitutionTestRouter(t, provider)
	admin, _, err := sessions.Create()
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/keeper/api/v1/turn-state/model-mismatch?range=24h", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: admin})
	resp := httptest.NewRecorder()
	router.ServeHTTP(resp, req)

	var payload modelSubstitutionResponse
	if err := json.Unmarshal(resp.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	// 必须是空数组而不是 null，前端才能直接渲染空状态。
	if payload.Current == nil || len(payload.Current) != 0 {
		t.Fatalf("expected an empty current array, got %#v", payload.Current)
	}
}

func TestModelSubstitutionAgeSecondsClampsNegativeToZero(t *testing.T) {
	now := time.Date(2026, 9, 21, 12, 30, 0, 0, time.Local)
	// 上游时间戳晚于本机时钟时，年龄必须是 0 而不是负数。
	if got := modelSubstitutionAgeSeconds(now.Add(time.Minute), now); got != 0 {
		t.Fatalf("expected negative age to clamp to 0, got %d", got)
	}
	if got := modelSubstitutionAgeSeconds(now.Add(-90*time.Second), now); got != 90 {
		t.Fatalf("expected 90 seconds, got %d", got)
	}
}
