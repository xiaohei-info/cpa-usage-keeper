package test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	. "cpa-usage-keeper/internal/api"
	"cpa-usage-keeper/internal/config"
	"cpa-usage-keeper/internal/entities"
	"cpa-usage-keeper/internal/repository"
)

type modelSubstitutionPayload struct {
	Schema  string `json:"schema"`
	Range   string `json:"range"`
	Summary struct {
		RequestsWithModel int64    `json:"requests_with_model"`
		Matched           int64    `json:"matched"`
		Mismatched        int64    `json:"mismatched"`
		MatchRate         *float64 `json:"match_rate"`
		Empty             bool     `json:"empty"`
		TopSubstitution   *struct {
			From  string `json:"from"`
			To    string `json:"to"`
			Count int64  `json:"count"`
		} `json:"top_substitution"`
	} `json:"summary"`
	Series []struct {
		RequestsWithModel     int64    `json:"requests_with_model"`
		MatchRate             *float64 `json:"match_rate"`
		StateCheckObserved    int64    `json:"state_check_observed"`
		StateCheckFailed      int64    `json:"state_check_failed"`
		StateCheckFailureRate *float64 `json:"state_check_failure_rate"`
	} `json:"series"`
	Matrix []struct {
		RequestedModel string  `json:"requested_model"`
		UpstreamModel  string  `json:"upstream_model"`
		Count          int64   `json:"count"`
		Share          float64 `json:"share"`
		Matched        bool    `json:"matched"`
	} `json:"matrix"`
	Substitutions []struct {
		RequestedModel    string   `json:"requested_model"`
		RequestsWithModel int64    `json:"requests_with_model"`
		Mismatched        int64    `json:"mismatched"`
		MatchRate         *float64 `json:"match_rate"`
	} `json:"substitutions"`
}

// TestModelSubstitutionRouteReadsSeededUsageEvents 走真实路由 + 真实仓储，
// 确认 HTTP 契约字段与数据库聚合口径一起成立，而不是只测桩。
func TestModelSubstitutionRouteReadsSeededUsageEvents(t *testing.T) {
	db, err := repository.OpenDatabase(config.Config{SQLitePath: filepath.Join(t.TempDir(), "model-substitution-route.db")})
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatalf("resolve database: %v", err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })

	now := time.Now()
	if _, _, err := repository.InsertUsageEvents(db, []entities.UsageEvent{
		{EventKey: "route-match", APIGroupKey: repository.CodexProxyAPIGroupKey, Model: "gpt-6-astra", UpstreamModel: "gpt-6-astra", Timestamp: now.Add(-40 * time.Minute), StateCheck: "ok"},
		{EventKey: "route-sub-1", APIGroupKey: repository.CodexProxyAPIGroupKey, Model: "gpt-6-astra", UpstreamModel: "gpt-5.6-luna", Timestamp: now.Add(-35 * time.Minute), StateCheck: "shape_mismatch", StateCheckReason: "block_mismatch"},
		{EventKey: "route-sub-2", APIGroupKey: repository.CodexProxyAPIGroupKey, Model: "gpt-6-astra", UpstreamModel: "gpt-5.6-luna", Timestamp: now.Add(-30 * time.Minute), StateCheck: "expired", StateCheckReason: "expired"},
		{EventKey: "route-unobserved", APIGroupKey: repository.CodexProxyAPIGroupKey, Model: "gpt-6-astra", Timestamp: now.Add(-20 * time.Minute), StateCheck: "no_state"},
		// 非 Codex Proxy 分组（如 openrouter）绝不能进模型质量页。
		{EventKey: "route-openrouter", APIGroupKey: "openrouter", Model: "openrouter/free", UpstreamModel: "openrouter/free", Timestamp: now.Add(-20 * time.Minute), StateCheck: "ok"},
	}); err != nil {
		t.Fatalf("seed usage events: %v", err)
	}

	router := NewRouter(nil, nil, nil, nil, AuthConfig{}, nil, "", OptionalProviders{
		ModelSubstitution: repository.NewModelSubstitutionProvider(db),
	})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/turn-state/model-mismatch?range=24h", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}

	var payload modelSubstitutionPayload
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if payload.Schema != repository.ModelSubstitutionSchema || payload.Range != "24h" {
		t.Fatalf("unexpected envelope: %+v", payload)
	}
	// 空 upstream_model 的行完全排除；分母只含 3 条有模型信息的事件。
	if payload.Summary.RequestsWithModel != 3 || payload.Summary.Matched != 1 || payload.Summary.Mismatched != 2 {
		t.Fatalf("unexpected summary: %+v", payload.Summary)
	}
	if payload.Summary.Empty || payload.Summary.MatchRate == nil || *payload.Summary.MatchRate < 33.2 || *payload.Summary.MatchRate > 33.4 {
		t.Fatalf("unexpected match rate: %+v", payload.Summary)
	}
	if payload.Summary.TopSubstitution == nil || payload.Summary.TopSubstitution.From != "gpt-6-astra" ||
		payload.Summary.TopSubstitution.To != "gpt-5.6-luna" || payload.Summary.TopSubstitution.Count != 2 {
		t.Fatalf("unexpected top substitution: %+v", payload.Summary.TopSubstitution)
	}
	if len(payload.Matrix) != 2 {
		t.Fatalf("expected one matched and one substituted cell, got %+v", payload.Matrix)
	}
	if len(payload.Substitutions) != 1 || payload.Substitutions[0].Mismatched != 2 {
		t.Fatalf("unexpected per-model stats: %+v", payload.Substitutions)
	}
	if len(payload.Series) != 24 {
		t.Fatalf("expected 24 hourly buckets, got %d", len(payload.Series))
	}

	// 状态检查分母只含已上报事件：3 条中 2 条失败；no_state 既不算通过也不算失败。
	var observed, failed int64
	for _, point := range payload.Series {
		observed += point.StateCheckObserved
		failed += point.StateCheckFailed
	}
	if observed != 3 || failed != 2 {
		t.Fatalf("unexpected state-check totals: observed=%d failed=%d", observed, failed)
	}
}
