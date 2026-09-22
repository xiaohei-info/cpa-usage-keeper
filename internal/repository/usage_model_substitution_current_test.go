package repository

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"cpa-usage-keeper/internal/config"
	"cpa-usage-keeper/internal/entities"
)

// modelSubstitutionCurrentEvents 覆盖“每组取最新”的典型形态：同一请求模型多行取最新、
// 同秒并列按 id 决出、空 upstream_model 排除、窗口外样本排除、未知判定码原样保留。
func modelSubstitutionCurrentEvents(now time.Time) []entities.UsageEvent {
	return []entities.UsageEvent{
		// 同一请求模型三行：只有最近一行应出现在 current 中。
		{EventKey: "c-old", Model: "gpt-6-astra", UpstreamModel: "gpt-6-astra", Timestamp: now.Add(-50 * time.Minute), StateCheck: "ok"},
		{EventKey: "c-mid", Model: "gpt-6-astra", UpstreamModel: "gpt-5.6-luna", Timestamp: now.Add(-30 * time.Minute), StateCheck: "expired", StateCheckReason: "expired"},
		{
			EventKey: "c-new", Model: "gpt-6-astra", UpstreamModel: "gpt-5.6-luna", Timestamp: now.Add(-5 * time.Minute),
			StateCheck: "shape_mismatch", StateCheckReason: "block_mismatch",
			StateCheckObservedBlocks: int64Ptr(11), StateCheckExpectedBlocks: int64Ptr(10),
			AuthIndex: "acct-1",
		},
		// 第二个请求模型：一致，且判定为 ok。
		{EventKey: "d-new", Model: "gpt-5.6-sol", UpstreamModel: "gpt-5.6-sol", Timestamp: now.Add(-2 * time.Minute), StateCheck: "ok"},
		// 空/空白 upstream_model 不得成为一行。
		{EventKey: "e-empty", Model: "gpt-5.6-terra", Timestamp: now.Add(-1 * time.Minute), StateCheck: "ok"},
		{EventKey: "e-blank", Model: "gpt-5.6-terra", UpstreamModel: "   ", Timestamp: now.Add(-1 * time.Minute)},
		// 空 model 的兜底行必须跳过，避免无标题行。
		{EventKey: "f-nomodel", Model: "", UpstreamModel: "gpt-5.6-luna", Timestamp: now.Add(-1 * time.Minute)},
		// 窗口外不得计入。
		{EventKey: "g-old", Model: "gpt-6-astra", UpstreamModel: "gpt-5.5", Timestamp: now.Add(-30 * time.Hour)},
	}
}

func int64Ptr(value int64) *int64 { return &value }

func openModelSubstitutionCurrentProvider(t *testing.T, now time.Time, events []entities.UsageEvent) *ModelSubstitutionProvider {
	t.Helper()
	withRepositoryTestLocation(t, "Asia/Shanghai")
	db, err := OpenDatabase(config.Config{SQLitePath: filepath.Join(t.TempDir(), "model-substitution-current.db")})
	if err != nil {
		t.Fatalf("OpenDatabase returned error: %v", err)
	}
	closeTestDatabase(t, db)
	if _, _, err := InsertUsageEvents(db, events); err != nil {
		t.Fatalf("InsertUsageEvents returned error: %v", err)
	}
	return NewModelSubstitutionProvider(db)
}

func TestModelSubstitutionCurrentKeepsLatestRowPerRequestedModel(t *testing.T) {
	now := time.Date(2026, 9, 21, 12, 30, 0, 0, time.FixedZone("CST", 8*60*60))
	provider := openModelSubstitutionCurrentProvider(t, now, modelSubstitutionCurrentEvents(now))

	snapshot, err := provider.ModelSubstitution(context.Background(), "24h", now)
	if err != nil {
		t.Fatalf("ModelSubstitution returned error: %v", err)
	}

	// 合并表的行键是「账号 x 模型」，且只要该组在窗口内有业务数据（请求/状态检查）就出行，
	// 即使从没观测到 upstream_model——否则一个确实在跑的账号会从表里“消失”。
	// 本数据集：sol 1 行；astra 分两行（acct-1 与空账号，同模型不合并）；terra 1 行
	// （只有请求与状态检查，上游模型未观测）。
	if len(snapshot.Current) != 4 {
		t.Fatalf("expected 4 account-model rows, got %d: %+v", len(snapshot.Current), snapshot.Current)
	}

	// 同一个请求模型在不同账号下必须分开成行，而不是互相覆盖。
	type accountModelKey struct{ account, model string }
	byKey := map[accountModelKey]ModelSubstitutionCurrentObservation{}
	for _, row := range snapshot.Current {
		byKey[accountModelKey{account: row.AccountEntryID, model: row.RequestedModel}] = row
	}

	astra, ok := byKey[accountModelKey{account: "acct-1", model: "gpt-6-astra"}]
	if !ok {
		t.Fatalf("missing acct-1 gpt-6-astra current row: %+v", snapshot.Current)
	}
	// 必须是最近的那行（-5min），不是 -30min 或 -50min。
	if astra.UpstreamModel != "gpt-5.6-luna" || astra.Matched {
		t.Fatalf("expected the newest mismatched row, got %+v", astra)
	}
	if !astra.ObservedAt.Equal(now.Add(-5 * time.Minute)) {
		t.Fatalf("expected newest observed_at, got %s", astra.ObservedAt.Format(time.RFC3339))
	}
	// 判定与块数细节必须随行带出，供前端展示“可能降智 · 块数不符”。
	if astra.StateCheck != "shape_mismatch" || astra.StateCheckReason != "block_mismatch" {
		t.Fatalf("unexpected state check: %+v", astra)
	}
	if astra.StateCheckObservedBlocks == nil || *astra.StateCheckObservedBlocks != 11 {
		t.Fatalf("expected observed blocks 11, got %+v", astra.StateCheckObservedBlocks)
	}
	if astra.StateCheckExpectedBlocks == nil || *astra.StateCheckExpectedBlocks != 10 {
		t.Fatalf("expected expected blocks 10, got %+v", astra.StateCheckExpectedBlocks)
	}
	if astra.AccountEntryID != "acct-1" {
		t.Fatalf("expected account entry id, got %q", astra.AccountEntryID)
	}

	sol, ok := byKey[accountModelKey{account: "", model: "gpt-5.6-sol"}]
	if !ok {
		t.Fatalf("missing gpt-5.6-sol current row: %+v", snapshot.Current)
	}
	if !sol.Matched || sol.StateCheck != "ok" {
		t.Fatalf("expected matching ok row, got %+v", sol)
	}

	// 无上游模型观测的组不得携带编造的上游模型与匹配结论。
	terra, ok := byKey[accountModelKey{account: "", model: "gpt-5.6-terra"}]
	if !ok {
		t.Fatalf("missing gpt-5.6-terra aggregate row: %+v", snapshot.Current)
	}
	if terra.UpstreamModel != "" || terra.Matched || !terra.ObservedAt.IsZero() {
		t.Fatalf("an unobserved group must not carry an upstream model: %+v", terra)
	}
	// 但它确实有业务数据：请求数与状态检查分母必须照常带上。
	if terra.RequestCount != 2 || terra.StateCheckObserved != 1 {
		t.Fatalf("unexpected terra aggregates: %+v", terra)
	}

	// 空 model 的兜底行必须跳过，避免无标题行。
	for _, row := range snapshot.Current {
		if row.RequestedModel == "" {
			t.Fatalf("an empty requested model leaked into current: %+v", snapshot.Current)
		}
	}

	// 窗口外样本不得覆盖窗口内的最近观测。
	if astra.UpstreamModel == "gpt-5.5" {
		t.Fatalf("out-of-window row leaked into current: %+v", astra)
	}
}

func TestModelSubstitutionCurrentBreaksSameTimestampTiesByID(t *testing.T) {
	now := time.Date(2026, 9, 21, 12, 30, 0, 0, time.FixedZone("CST", 8*60*60))
	// 同秒两行：后插入的 id 更大，必须是最终选中的“最新”观测。
	sameInstant := now.Add(-3 * time.Minute)
	provider := openModelSubstitutionCurrentProvider(t, now, []entities.UsageEvent{
		{EventKey: "tie-first", Model: "gpt-6-astra", UpstreamModel: "gpt-6-astra", Timestamp: sameInstant, StateCheck: "ok"},
		{EventKey: "tie-second", Model: "gpt-6-astra", UpstreamModel: "gpt-5.6-luna", Timestamp: sameInstant, StateCheck: "shape_mismatch", StateCheckReason: "block_mismatch"},
	})

	snapshot, err := provider.ModelSubstitution(context.Background(), "24h", now)
	if err != nil {
		t.Fatalf("ModelSubstitution returned error: %v", err)
	}
	if len(snapshot.Current) != 1 {
		t.Fatalf("expected a single current row for one requested model, got %+v", snapshot.Current)
	}
	// 同一时刻按 id 降序，因此后插入的那行胜出；结果必须可复现。
	if snapshot.Current[0].UpstreamModel != "gpt-5.6-luna" {
		t.Fatalf("expected the higher id to win the tie, got %+v", snapshot.Current[0])
	}
}

func TestModelSubstitutionCurrentRespectsRangeBoundary(t *testing.T) {
	now := time.Date(2026, 9, 21, 12, 30, 0, 0, time.FixedZone("CST", 8*60*60))
	provider := openModelSubstitutionCurrentProvider(t, now, []entities.UsageEvent{
		// 2 小时前：落在 1h 之外、24h 之内。
		{EventKey: "in-24h", Model: "gpt-6-astra", UpstreamModel: "gpt-5.6-luna", Timestamp: now.Add(-2 * time.Hour), StateCheck: "shape_mismatch", StateCheckReason: "block_mismatch"},
	})

	short, err := provider.ModelSubstitution(context.Background(), "1h", now)
	if err != nil {
		t.Fatalf("1h ModelSubstitution returned error: %v", err)
	}
	if len(short.Current) != 0 {
		t.Fatalf("1h window must not include a 2h-old observation: %+v", short.Current)
	}

	long, err := provider.ModelSubstitution(context.Background(), "24h", now)
	if err != nil {
		t.Fatalf("24h ModelSubstitution returned error: %v", err)
	}
	if len(long.Current) != 1 {
		t.Fatalf("24h window must include the 2h-old observation: %+v", long.Current)
	}
}

func TestModelSubstitutionCurrentIsBounded(t *testing.T) {
	now := time.Date(2026, 9, 21, 12, 30, 0, 0, time.FixedZone("CST", 8*60*60))
	events := make([]entities.UsageEvent, 0, modelSubstitutionCurrentLimit+20)
	for index := range modelSubstitutionCurrentLimit + 20 {
		events = append(events, entities.UsageEvent{
			EventKey:      "many-" + string(rune('a'+index%26)) + string(rune('0'+index/26)),
			Model:         "requested-" + string(rune('a'+index%26)) + string(rune('0'+index/26)),
			UpstreamModel: "upstream-model",
			Timestamp:     now.Add(-time.Duration(index+1) * time.Minute),
		})
	}
	provider := openModelSubstitutionCurrentProvider(t, now, events)

	snapshot, err := provider.ModelSubstitution(context.Background(), "24h", now)
	if err != nil {
		t.Fatalf("ModelSubstitution returned error: %v", err)
	}
	if len(snapshot.Current) > modelSubstitutionCurrentLimit {
		t.Fatalf("current rows %d exceed cap %d", len(snapshot.Current), modelSubstitutionCurrentLimit)
	}
	if len(snapshot.Current) != modelSubstitutionCurrentLimit {
		t.Fatalf("expected the cap to be reached (%d), got %d", modelSubstitutionCurrentLimit, len(snapshot.Current))
	}
}

func TestEmptyModelSubstitutionSnapshotHasNoCurrentRows(t *testing.T) {
	window, err := ParseModelSubstitutionWindow("24h", time.Date(2026, 9, 21, 12, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("ParseModelSubstitutionWindow returned error: %v", err)
	}
	snapshot := EmptyModelSubstitutionSnapshot(window)
	// 空快照必须返回空切片而不是 nil，前端才能直接迭代。
	if snapshot.Current == nil || len(snapshot.Current) != 0 {
		t.Fatalf("expected an empty non-nil current slice, got %#v", snapshot.Current)
	}
}

// 同一请求模型在两个账号上必须各自保留自己的“最近一次观测”，而不是被合并成
// 全局最新的一行——否则一个账号的真实状态会被另一个账号的观测顶掉。
func TestModelSubstitutionCurrentKeepsPerAccountLatestObservation(t *testing.T) {
	now := time.Date(2026, 9, 21, 12, 30, 0, 0, time.FixedZone("CST", 8*60*60))
	provider := openModelSubstitutionCurrentProvider(t, now, []entities.UsageEvent{
		// 账号 A：最近一次仍是原模型。
		{EventKey: "a-old", Model: "gpt-5.6-sol", UpstreamModel: "gpt-5.6-luna", Timestamp: now.Add(-40 * time.Minute), AuthIndex: "acct-a"},
		{EventKey: "a-new", Model: "gpt-5.6-sol", UpstreamModel: "gpt-5.6-sol", Timestamp: now.Add(-20 * time.Minute), AuthIndex: "acct-a"},
		// 账号 B：最近一次被替换；它比 A 的最新观测更早，绝不能被丢掉。
		{EventKey: "b-new", Model: "gpt-5.6-sol", UpstreamModel: "gpt-5.6-luna", Timestamp: now.Add(-30 * time.Minute), AuthIndex: "acct-b"},
	})

	snapshot, err := provider.ModelSubstitution(context.Background(), "24h", now)
	if err != nil {
		t.Fatalf("ModelSubstitution returned error: %v", err)
	}
	byAccount := map[string]ModelSubstitutionCurrentObservation{}
	for _, row := range snapshot.Current {
		byAccount[row.AccountEntryID] = row
	}
	if len(byAccount) != 2 {
		t.Fatalf("expected one row per account, got %+v", snapshot.Current)
	}
	if got := byAccount["acct-a"].UpstreamModel; got != "gpt-5.6-sol" {
		t.Fatalf("acct-a latest observation = %q, want gpt-5.6-sol", got)
	}
	if got := byAccount["acct-b"].UpstreamModel; got != "gpt-5.6-luna" {
		t.Fatalf("acct-b latest observation = %q, want gpt-5.6-luna", got)
	}
}
