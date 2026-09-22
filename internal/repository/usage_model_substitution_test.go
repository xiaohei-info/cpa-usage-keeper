package repository

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"cpa-usage-keeper/internal/config"
	"cpa-usage-keeper/internal/entities"
)

// modelSubstitutionTestEvents 覆盖一致、替换、未观测、状态检查失败与窗口外样本。
func modelSubstitutionTestEvents(now time.Time) []entities.UsageEvent {
	return []entities.UsageEvent{
		// 一致：请求模型与上游模型相同。
		{EventKey: "m1", Model: "gpt-6-astra", UpstreamModel: "gpt-6-astra", Timestamp: now.Add(-70 * time.Minute), StateCheck: "ok"},
		{EventKey: "m2", Model: "gpt-6-astra", UpstreamModel: "gpt-6-astra", Timestamp: now.Add(-40 * time.Minute), StateCheck: "ok"},
		// 替换：上游换成了别的模型。
		{EventKey: "s1", Model: "gpt-6-astra", UpstreamModel: "gpt-5.6-luna", Timestamp: now.Add(-35 * time.Minute), StateCheck: "shape_mismatch", StateCheckReason: "block_mismatch"},
		{EventKey: "s2", Model: "gpt-6-astra", UpstreamModel: "gpt-5.6-luna", Timestamp: now.Add(-30 * time.Minute), StateCheck: "expired", StateCheckReason: "expired"},
		{EventKey: "s3", Model: "o5-code", UpstreamModel: "o5-mini", Timestamp: now.Add(-20 * time.Minute), StateCheck: "no_state"},
		// 没有 upstream_model：必须完全排除在分子和分母之外。
		{EventKey: "u1", Model: "gpt-6-astra", Timestamp: now.Add(-15 * time.Minute), StateCheck: "invalid", StateCheckReason: "encoding_base64"},
		{EventKey: "u2", Model: "gpt-6-astra", UpstreamModel: "   ", Timestamp: now.Add(-10 * time.Minute)},
		// 窗口外样本不得计入。
		{EventKey: "old", Model: "gpt-6-astra", UpstreamModel: "gpt-5.6-luna", Timestamp: now.Add(-30 * time.Hour)},
	}
}

func openModelSubstitutionTestProvider(t *testing.T, now time.Time, events []entities.UsageEvent) *ModelSubstitutionProvider {
	t.Helper()
	for index := range events {
		if events[index].APIGroupKey == "" {
			events[index].APIGroupKey = CodexProxyAPIGroupKey
		}
	}
	withRepositoryTestLocation(t, "Asia/Shanghai")
	db, err := OpenDatabase(config.Config{SQLitePath: filepath.Join(t.TempDir(), "model-substitution.db")})
	if err != nil {
		t.Fatalf("OpenDatabase returned error: %v", err)
	}
	closeTestDatabase(t, db)
	if _, _, err := InsertUsageEvents(db, events); err != nil {
		t.Fatalf("InsertUsageEvents returned error: %v", err)
	}
	return NewModelSubstitutionProvider(db)
}

func TestModelSubstitutionAggregationExcludesUnobservedRows(t *testing.T) {
	now := time.Date(2026, 9, 21, 12, 30, 0, 0, time.FixedZone("CST", 8*60*60))
	provider := openModelSubstitutionTestProvider(t, now, modelSubstitutionTestEvents(now))

	snapshot, err := provider.ModelSubstitution(context.Background(), "24h", now)
	if err != nil {
		t.Fatalf("ModelSubstitution returned error: %v", err)
	}
	// 分母只含 5 条有 upstream_model 的窗口内事件；两条空值样本与窗口外样本都不参与。
	if snapshot.Summary.Total != 5 || snapshot.Summary.Matched != 2 {
		t.Fatalf("unexpected summary: %+v", snapshot.Summary)
	}
	if snapshot.Summary.MismatchCount() != 3 {
		t.Fatalf("expected 3 mismatches, got %d", snapshot.Summary.MismatchCount())
	}

	// 被替换的请求模型必须保留自己的分母，而不是全局分母。
	byModel := map[string]UpstreamModelMatchStats{}
	for _, stats := range snapshot.Models {
		byModel[stats.RequestedModel] = stats.Match
	}
	if byModel["gpt-6-astra"] != (UpstreamModelMatchStats{Total: 4, Matched: 2}) {
		t.Fatalf("unexpected gpt-6-astra stats: %+v", byModel["gpt-6-astra"])
	}
	if byModel["o5-code"] != (UpstreamModelMatchStats{Total: 1, Matched: 0}) {
		t.Fatalf("unexpected o5-code stats: %+v", byModel["o5-code"])
	}

	// 空 upstream_model 的行不得进入矩阵，也不得被算成一致。
	if len(snapshot.Matrix) != 3 {
		t.Fatalf("expected 3 matrix cells, got %+v", snapshot.Matrix)
	}
	for _, cell := range snapshot.Matrix {
		if cell.UpstreamModel == "" {
			t.Fatalf("empty upstream model leaked into the matrix: %+v", cell)
		}
		if cell.Matched != (cell.RequestedModel == cell.UpstreamModel) {
			t.Fatalf("matched flag disagrees with model equality: %+v", cell)
		}
	}

	// 最大替换组合：gpt-6-astra -> gpt-5.6-luna 2 次，占比 2/4。
	if snapshot.Top == nil || snapshot.Top.From != "gpt-6-astra" || snapshot.Top.To != "gpt-5.6-luna" || snapshot.Top.Count != 2 {
		t.Fatalf("unexpected top substitution: %+v", snapshot.Top)
	}
	for _, cell := range snapshot.Matrix {
		if cell.RequestedModel == "gpt-6-astra" && cell.UpstreamModel == "gpt-5.6-luna" && cell.Share != 0.5 {
			t.Fatalf("expected 0.5 share, got %v", cell.Share)
		}
	}
}

func TestModelSubstitutionBucketsAlignAndCarryBothSeries(t *testing.T) {
	now := time.Date(2026, 9, 21, 12, 30, 0, 0, time.FixedZone("CST", 8*60*60))
	provider := openModelSubstitutionTestProvider(t, now, modelSubstitutionTestEvents(now))

	snapshot, err := provider.ModelSubstitution(context.Background(), "24h", now)
	if err != nil {
		t.Fatalf("ModelSubstitution returned error: %v", err)
	}
	// 24h -> 24 个整点桶，窗口结尾对齐到下一个整点。
	if snapshot.Window.BucketSeconds != 3600 || len(snapshot.Buckets) != 24 {
		t.Fatalf("unexpected window shape: %+v", snapshot.Window)
	}
	if !snapshot.Window.End.Equal(time.Date(2026, 9, 21, 13, 0, 0, 0, now.Location())) {
		t.Fatalf("unexpected window end: %v", snapshot.Window.End)
	}
	if !snapshot.Window.Start.Equal(snapshot.Window.End.Add(-24 * time.Hour)) {
		t.Fatalf("unexpected window start: %v", snapshot.Window.Start)
	}
	for index, bucket := range snapshot.Buckets {
		want := snapshot.Window.Start.Add(time.Duration(index) * time.Hour)
		if !bucket.Start.Equal(want) {
			t.Fatalf("bucket %d misaligned: got %v want %v", index, bucket.Start, want)
		}
	}

	// 按时间查找桶：窗口起点是前一天 13:00，桶 index = 从起点起的小时数。
	at := func(hour int) ModelSubstitutionBucket {
		target := time.Date(2026, 9, 21, hour, 0, 0, 0, now.Location())
		for _, bucket := range snapshot.Buckets {
			if bucket.Start.Equal(target) {
				return bucket
			}
		}
		t.Fatalf("bucket %v missing from series", target)
		return ModelSubstitutionBucket{}
	}
	// -70/-40/-35m 落在 11:00 桶（2 一致 + 1 替换）；-30/-20/-15/-10m 落在 12:00 桶。
	if at(11).Match != (UpstreamModelMatchStats{Total: 3, Matched: 2}) {
		t.Fatalf("unexpected 11:00 match bucket: %+v", at(11).Match)
	}
	if at(12).Match != (UpstreamModelMatchStats{Total: 2, Matched: 0}) {
		t.Fatalf("unexpected 12:00 match bucket: %+v", at(12).Match)
	}
	// 状态检查分母只含已上报事件：11:00 桶 3 条上报、1 条失败（shape_mismatch），
	// 12:00 桶 2 条上报（expired + invalid）、2 条失败，no_state 与空值都不进分母。
	if at(11).StateCheckObserved != 3 || at(11).StateCheckFailed != 1 {
		t.Fatalf("unexpected 11:00 state-check bucket: %+v", at(11))
	}
	if at(12).StateCheckObserved != 2 || at(12).StateCheckFailed != 2 {
		t.Fatalf("unexpected 12:00 state-check bucket: %+v", at(12))
	}
}

func TestModelSubstitutionRangeClampingAndBucketCaps(t *testing.T) {
	now := time.Date(2026, 9, 21, 12, 30, 0, 0, time.FixedZone("CST", 8*60*60))
	for _, tc := range []struct {
		request     string
		wantRange   string
		wantBucket  int64
		wantBuckets int
	}{
		{request: "1h", wantRange: "1h", wantBucket: 60, wantBuckets: 60},
		{request: "6h", wantRange: "6h", wantBucket: 300, wantBuckets: 72},
		{request: "24h", wantRange: "24h", wantBucket: 3600, wantBuckets: 24},
		{request: "7d", wantRange: "7d", wantBucket: 24 * 3600, wantBuckets: 7},
		{request: "30d", wantRange: "30d", wantBucket: 24 * 3600, wantBuckets: 30},
		// 白名单之外一律夹紧到默认 24h，不报错、也不返回无界窗口。
		{request: "", wantRange: "24h", wantBucket: 3600, wantBuckets: 24},
		{request: "99d", wantRange: "24h", wantBucket: 3600, wantBuckets: 24},
		{request: "1y", wantRange: "24h", wantBucket: 3600, wantBuckets: 24},
		{request: "'; DROP TABLE usage_events; --", wantRange: "24h", wantBucket: 3600, wantBuckets: 24},
	} {
		t.Run(tc.request, func(t *testing.T) {
			window, err := ParseModelSubstitutionWindow(tc.request, now)
			if err != nil {
				t.Fatalf("ParseModelSubstitutionWindow returned error: %v", err)
			}
			if window.Range != tc.wantRange || window.BucketSeconds != tc.wantBucket || len(window.BucketStarts) != tc.wantBuckets {
				t.Fatalf("unexpected window for %q: %+v", tc.request, window)
			}
			if len(window.BucketStarts) > ModelSubstitutionMaxBuckets {
				t.Fatalf("bucket count %d exceeds cap %d", len(window.BucketStarts), ModelSubstitutionMaxBuckets)
			}
		})
	}
}

func TestModelSubstitutionEmptyWindowReportsNoSample(t *testing.T) {
	now := time.Date(2026, 9, 21, 12, 30, 0, 0, time.FixedZone("CST", 8*60*60))
	// 只有没有 upstream_model 的行：结果必须是“无样本”，而不是 0% 或 100%。
	provider := openModelSubstitutionTestProvider(t, now, []entities.UsageEvent{
		{EventKey: "no-model", Model: "gpt-6-astra", Timestamp: now.Add(-10 * time.Minute), StateCheck: "ok"},
	})

	snapshot, err := provider.ModelSubstitution(context.Background(), "24h", now)
	if err != nil {
		t.Fatalf("ModelSubstitution returned error: %v", err)
	}
	if snapshot.Summary.Total != 0 || snapshot.Summary.Matched != 0 {
		t.Fatalf("expected no sample, got %+v", snapshot.Summary)
	}
	if _, ok := snapshot.Summary.MatchPercent(); ok {
		t.Fatal("expected zero-sample match percent to be unavailable")
	}
	if len(snapshot.Matrix) != 0 || len(snapshot.Models) != 0 || snapshot.Top != nil {
		t.Fatalf("expected empty matrix/summary, got %+v", snapshot)
	}
	// 状态检查仍然有样本：它有自己的分母，不受 upstream_model 缺失影响。
	var observed, failed int64
	for _, bucket := range snapshot.Buckets {
		observed += bucket.StateCheckObserved
		failed += bucket.StateCheckFailed
	}
	if observed != 1 || failed != 0 {
		t.Fatalf("unexpected state-check totals: observed=%d failed=%d", observed, failed)
	}
}

func TestModelSubstitutionMatrixIsBounded(t *testing.T) {
	now := time.Date(2026, 9, 21, 12, 30, 0, 0, time.FixedZone("CST", 8*60*60))
	var events []entities.UsageEvent
	// 40 个请求模型 x 10 个上游模型 = 400 个组合，必须被矩阵上限截断。
	for requested := range 40 {
		for upstream := range 10 {
			events = append(events, entities.UsageEvent{
				EventKey:      "pair-" + string(rune('a'+requested%26)) + string(rune('0'+upstream)),
				Model:         "requested-" + string(rune('a'+requested%26)) + string(rune('0'+requested/26)),
				UpstreamModel: "upstream-" + string(rune('0'+upstream)),
				Timestamp:     now.Add(-time.Duration(requested*upstream+1) * time.Minute),
			})
		}
	}
	provider := openModelSubstitutionTestProvider(t, now, events)

	snapshot, err := provider.ModelSubstitution(context.Background(), "24h", now)
	if err != nil {
		t.Fatalf("ModelSubstitution returned error: %v", err)
	}
	if len(snapshot.Matrix) > modelSubstitutionMatrixCellLimit {
		t.Fatalf("matrix cells %d exceed cap %d", len(snapshot.Matrix), modelSubstitutionMatrixCellLimit)
	}
	if len(snapshot.Models) > modelSubstitutionRequestedModelLimit {
		t.Fatalf("requested models %d exceed cap %d", len(snapshot.Models), modelSubstitutionRequestedModelLimit)
	}
}

func TestIsStateCheckObservedTreatsMissingAndNoStateAsUnobserved(t *testing.T) {
	for _, tc := range []struct {
		code         string
		wantObserved bool
		wantFailure  bool
	}{
		{code: "", wantObserved: false, wantFailure: false},
		{code: "   ", wantObserved: false, wantFailure: false},
		{code: "no_state", wantObserved: false, wantFailure: false},
		{code: "ok", wantObserved: true, wantFailure: false},
		{code: "shape_mismatch", wantObserved: true, wantFailure: true},
		{code: "expired", wantObserved: true, wantFailure: true},
		{code: "invalid", wantObserved: true, wantFailure: true},
		// 未来新增的未知判定码按保守口径算失败，不能被静默当成通过。
		{code: "future_verdict", wantObserved: true, wantFailure: true},
	} {
		t.Run(tc.code, func(t *testing.T) {
			if got := IsStateCheckObserved(tc.code); got != tc.wantObserved {
				t.Fatalf("IsStateCheckObserved(%q) = %t, want %t", tc.code, got, tc.wantObserved)
			}
			if got := IsStateCheckFailure(tc.code); got != tc.wantFailure {
				t.Fatalf("IsStateCheckFailure(%q) = %t, want %t", tc.code, got, tc.wantFailure)
			}
		})
	}
}
