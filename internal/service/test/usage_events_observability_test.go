package test

import (
	"context"
	"testing"
	"time"

	"cpa-usage-keeper/internal/entities"
	"cpa-usage-keeper/internal/repository"
	"cpa-usage-keeper/internal/service"
	servicedto "cpa-usage-keeper/internal/service/dto"
)

// TestUsageServicePreservesObservabilityFields 覆盖 repository 投影 → DTO → 服务层，
// 并证明 CPA 风格的空值原样保留，不会被推断成一致或正常。
func TestUsageServicePreservesObservabilityFields(t *testing.T) {
	db := openUsageServiceTestDatabase(t)
	observedBlocks := int64(11)
	expectedBlocks := int64(10)
	if _, _, err := repository.InsertUsageEvents(db, []entities.UsageEvent{
		{
			EventKey:                 "observability-observed",
			APIGroupKey:              "provider-a",
			Model:                    "gpt-5",
			UpstreamModel:            "gpt-5-mini",
			StateCheck:               "shape_mismatch",
			StateCheckReason:         "block_mismatch",
			StateCheckObservedBlocks: &observedBlocks,
			StateCheckExpectedBlocks: &expectedBlocks,
			Timestamp:                time.Date(2026, 9, 21, 10, 0, 0, 0, time.UTC),
			TotalTokens:              10,
		},
		{
			// CPA 事件没有这些字段；空值必须保持为空而不是推断出“一致/正常”。
			EventKey:    "observability-cpa",
			APIGroupKey: "provider-a",
			Model:       "claude-sonnet",
			Timestamp:   time.Date(2026, 9, 21, 9, 0, 0, 0, time.UTC),
			TotalTokens: 10,
		},
	}); err != nil {
		t.Fatalf("InsertUsageEvents returned error: %v", err)
	}

	provider := service.NewUsageService(db, emptyPricingCatalogForTest())
	page, err := provider.ListUsageEvents(context.Background(), servicedto.UsageFilter{Page: 1, PageSize: 10, Limit: 10})
	if err != nil {
		t.Fatalf("ListUsageEvents returned error: %v", err)
	}
	if len(page.Events) != 2 {
		t.Fatalf("expected 2 events, got %d", len(page.Events))
	}

	byKey := map[string]servicedto.UsageEventRecord{}
	for _, event := range page.Events {
		// 列表按 timestamp 倒序返回；用模型区分两条事件。
		byKey[event.Model] = event
	}
	observed, ok := byKey["gpt-5"]
	if !ok {
		t.Fatal("expected observed event in list result")
	}
	if observed.UpstreamModel != "gpt-5-mini" || observed.StateCheck != "shape_mismatch" || observed.StateCheckReason != "block_mismatch" {
		t.Fatalf("expected observability fields preserved, got %+v", observed)
	}
	// 块数必须原样保留，0 与缺值不能互换。
	if observed.StateCheckObservedBlocks == nil || *observed.StateCheckObservedBlocks != observedBlocks {
		t.Fatalf("expected observed blocks 11, got %+v", observed.StateCheckObservedBlocks)
	}
	if observed.StateCheckExpectedBlocks == nil || *observed.StateCheckExpectedBlocks != expectedBlocks {
		t.Fatalf("expected expected blocks 10, got %+v", observed.StateCheckExpectedBlocks)
	}

	cpa, ok := byKey["claude-sonnet"]
	if !ok {
		t.Fatal("expected CPA event in list result")
	}
	if cpa.UpstreamModel != "" || cpa.StateCheck != "" || cpa.StateCheckReason != "" {
		t.Fatalf("expected empty observability fields for CPA data, got %+v", cpa)
	}
	if cpa.StateCheckObservedBlocks != nil || cpa.StateCheckExpectedBlocks != nil {
		t.Fatalf("expected NULL block counts for CPA data, got %+v", cpa)
	}

	// 导出路径复用同一投影，必须同样保留字段。
	var streamed []servicedto.UsageEventRecord
	if err := provider.StreamUsageEvents(context.Background(), servicedto.UsageFilter{}, func(event servicedto.UsageEventRecord) error {
		streamed = append(streamed, event)
		return nil
	}); err != nil {
		t.Fatalf("StreamUsageEvents returned error: %v", err)
	}
	if len(streamed) != 2 {
		t.Fatalf("expected 2 streamed events, got %d", len(streamed))
	}
	var streamedObserved servicedto.UsageEventRecord
	for _, event := range streamed {
		if event.Model == "gpt-5" {
			streamedObserved = event
		}
	}
	if streamedObserved.UpstreamModel != "gpt-5-mini" || streamedObserved.StateCheck != "shape_mismatch" || streamedObserved.StateCheckReason != "block_mismatch" {
		t.Fatalf("expected stream to preserve observability fields, got %+v", streamedObserved)
	}
}
