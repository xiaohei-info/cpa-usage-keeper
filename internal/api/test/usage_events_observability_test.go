package test

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	. "cpa-usage-keeper/internal/api"
	servicedto "cpa-usage-keeper/internal/service/dto"
)

// TestUsageEventsReturnsObservabilityFields 覆盖旧版代理事件缺失字段时 JSON 省略、
// 有值事件完整透传，以及块数 0 与缺值的区别。
func TestUsageEventsReturnsObservabilityFields(t *testing.T) {
	observedBlocks := int64(11)
	expectedBlocks := int64(10)
	zeroBlocks := int64(0)
	provider := &usageEventsStub{events: []servicedto.UsageEventRecord{
		{
			ID:                       60,
			Timestamp:                time.Date(2026, 9, 21, 10, 0, 0, 0, time.UTC),
			Model:                    "gpt-5",
			UpstreamModel:            "gpt-5-mini",
			StateCheck:               "shape_mismatch",
			StateCheckReason:         "block_mismatch",
			StateCheckObservedBlocks: &observedBlocks,
			StateCheckExpectedBlocks: &expectedBlocks,
			TotalTokens:              10,
		},
		{
			ID:                       61,
			Timestamp:                time.Date(2026, 9, 21, 9, 0, 0, 0, time.UTC),
			Model:                    "gpt-5",
			StateCheck:               "no_state",
			StateCheckObservedBlocks: &zeroBlocks,
			TotalTokens:              10,
		},
		{
			// CPA 数据没有这些字段；空值必须省略，让前端渲染未观察到。
			ID:          62,
			Timestamp:   time.Date(2026, 9, 21, 8, 0, 0, 0, time.UTC),
			Model:       "claude-sonnet",
			TotalTokens: 10,
		},
	}}
	router := NewRouter(nil, nil, provider, nil, AuthConfig{}, nil, "")
	req := httptest.NewRequest(http.MethodGet, "/api/v1/usage/events?range=24h", nil)
	resp := httptest.NewRecorder()

	router.ServeHTTP(resp, req)

	body := resp.Body.String()
	if resp.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d: %s", resp.Code, body)
	}
	if !contains(body, `"upstream_model":"gpt-5-mini"`) || !contains(body, `"state_check":"shape_mismatch"`) || !contains(body, `"state_check_reason":"block_mismatch"`) {
		t.Fatalf("expected observability fields in response body: %s", body)
	}
	if !contains(body, `"state_check_observed_blocks":11`) || !contains(body, `"state_check_expected_blocks":10`) {
		t.Fatalf("expected block counts in response body: %s", body)
	}
	// no_state 事件必须保留判定码，且真实 0 块不能被省略掉。
	if !contains(body, `"state_check":"no_state"`) || !contains(body, `"state_check_observed_blocks":0`) {
		t.Fatalf("expected no_state verdict and real zero block count: %s", body)
	}
	// CPA 行没有任何观测字段，序列化后不应出现伪造值。
	if contains(body, `"upstream_model":""`) || contains(body, `"state_check":""`) || contains(body, `"state_check_reason":""`) {
		t.Fatalf("expected empty observability fields to stay omitted: %s", body)
	}
	if contains(body, `"state_check_expected_blocks":0`) {
		t.Fatalf("expected missing expected blocks to stay omitted rather than becoming 0: %s", body)
	}
}
