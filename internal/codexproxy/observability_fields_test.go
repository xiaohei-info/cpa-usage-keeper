package codexproxy

import (
	"encoding/json"
	"testing"
	"time"
)

// TestUsageEventMapsObservabilityFields 固定跨仓库 JSON key，避免 Part A 与 Keeper 字段名漂移。
func TestUsageEventMapsObservabilityFields(t *testing.T) {
	observedBlocks := int64(11)
	expectedBlocks := int64(10)
	payload := `{
		"event_id":"fixture","request_id":"request","event_type":"request.completed","endpoint":"/codex/responses",
		"model":"gpt-5",
		"upstream_model":"gpt-5-mini",
		"state_check":"shape_mismatch",
		"state_check_reason":"block_mismatch",
		"state_check_observed_blocks":11,
		"state_check_expected_blocks":10
	}`
	var event Event
	if err := json.Unmarshal([]byte(payload), &event); err != nil {
		t.Fatal(err)
	}
	got, err := event.UsageEvent(time.Now())
	if err != nil {
		t.Fatalf("map event: %v", err)
	}
	if got.UpstreamModel != "gpt-5-mini" || got.StateCheck != "shape_mismatch" || got.StateCheckReason != "block_mismatch" {
		t.Fatalf("unexpected observability fields: %+v", got)
	}
	if got.StateCheckObservedBlocks == nil || *got.StateCheckObservedBlocks != observedBlocks {
		t.Fatalf("expected observed blocks 11, got %+v", got.StateCheckObservedBlocks)
	}
	if got.StateCheckExpectedBlocks == nil || *got.StateCheckExpectedBlocks != expectedBlocks {
		t.Fatalf("expected expected blocks 10, got %+v", got.StateCheckExpectedBlocks)
	}
}

// TestUsageEventMapsMissingObservabilityFieldsAsEmpty 保证旧版 proxy 事件（或 null）不报错，
// 且空值表达“未观察到”，不是一致或正常。
func TestUsageEventMapsMissingObservabilityFieldsAsEmpty(t *testing.T) {
	for _, payload := range []string{
		`{"event_id":"fixture","request_id":"request","event_type":"request.completed","endpoint":"/codex/responses"}`,
		`{"event_id":"fixture","request_id":"request","event_type":"request.completed","endpoint":"/codex/responses","upstream_model":null,"state_check":null,"state_check_reason":null,"state_check_observed_blocks":null,"state_check_expected_blocks":null}`,
	} {
		var event Event
		if err := json.Unmarshal([]byte(payload), &event); err != nil {
			t.Fatal(err)
		}
		got, err := event.UsageEvent(time.Now())
		if err != nil {
			t.Fatalf("map event: %v", err)
		}
		if got.UpstreamModel != "" || got.StateCheck != "" || got.StateCheckReason != "" {
			t.Fatalf("expected empty observability fields, got %+v", got)
		}
		if got.StateCheckObservedBlocks != nil || got.StateCheckExpectedBlocks != nil {
			t.Fatalf("expected NULL block counts, got %+v", got)
		}
	}
}

// TestUsageEventKeepsUnknownStateCheckCodeVerbatim 验证未知判定码不会被丢弃或改写，
// 展示层据此渲染中性状态而不是绿色正常。
func TestUsageEventKeepsUnknownStateCheckCodeVerbatim(t *testing.T) {
	var event Event
	if err := json.Unmarshal([]byte(`{"event_id":"fixture","request_id":"request","event_type":"request.completed","endpoint":"/codex/responses","state_check":"future_verdict"}`), &event); err != nil {
		t.Fatal(err)
	}
	got, err := event.UsageEvent(time.Now())
	if err != nil {
		t.Fatalf("map event: %v", err)
	}
	if got.StateCheck != "future_verdict" {
		t.Fatalf("expected unknown verdict persisted verbatim, got %q", got.StateCheck)
	}
}
