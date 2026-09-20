package repository

import (
	"path/filepath"
	"testing"
	"time"

	"cpa-usage-keeper/internal/config"
	"cpa-usage-keeper/internal/entities"
)

// credentialHealthMatchPercent 复现凭证健康一致率的展示取值，供边界断言使用。
func credentialHealthMatchPercent(stats UpstreamModelMatchStats) (float64, bool) {
	return stats.MatchPercent()
}

func TestCredentialHealthUpstreamModelMatchStats(t *testing.T) {
	withRepositoryTestLocation(t, "Asia/Shanghai")
	db, err := OpenDatabase(config.Config{SQLitePath: filepath.Join(t.TempDir(), "credential-health-match.db")})
	if err != nil {
		t.Fatalf("OpenDatabase returned error: %v", err)
	}
	closeTestDatabase(t, db)

	now := time.Date(2026, 9, 21, 12, 0, 0, 0, time.FixedZone("CST", 8*60*60))
	events := []entities.UsageEvent{
		// 一致：请求模型与上游模型相同。
		{EventKey: "match-1", AuthType: "apikey", AuthIndex: "provider-1", Timestamp: now.Add(-10 * time.Minute), Model: "gpt-5", UpstreamModel: "gpt-5"},
		{EventKey: "match-2", AuthType: "apikey", AuthIndex: "provider-1", Timestamp: now.Add(-11 * time.Minute), Model: "gpt-5", UpstreamModel: "gpt-5"},
		// 不一致：上游返回了别的模型。
		{EventKey: "mismatch-1", AuthType: "apikey", AuthIndex: "provider-1", Timestamp: now.Add(-12 * time.Minute), Model: "gpt-5", UpstreamModel: "gpt-5-mini"},
		// CPA 事件没有 upstream_model，必须完全排除，不能拉低一致率。
		{EventKey: "unobserved-1", AuthType: "apikey", AuthIndex: "provider-1", Timestamp: now.Add(-13 * time.Minute), Model: "gpt-5"},
		{EventKey: "unobserved-2", AuthType: "apikey", AuthIndex: "provider-1", Timestamp: now.Add(-14 * time.Minute), Model: "gpt-5", UpstreamModel: "   "},
		// 窗口外样本不得计入。
		{EventKey: "too-old", AuthType: "apikey", AuthIndex: "provider-1", Timestamp: now.Add(-6 * time.Hour), Model: "gpt-5", UpstreamModel: "gpt-5-mini"},
		// 其他身份必须隔离。
		{EventKey: "other-identity", AuthType: "apikey", AuthIndex: "provider-2", Timestamp: now.Add(-15 * time.Minute), Model: "gpt-5", UpstreamModel: "gpt-5-mini"},
	}
	if _, _, err := InsertUsageEvents(db, events); err != nil {
		t.Fatalf("InsertUsageEvents returned error: %v", err)
	}

	cache, err := NewUsageRecentEventCache(db, UsageRecentEventCacheOptions{Now: func() time.Time { return now }})
	if err != nil {
		t.Fatalf("NewUsageRecentEventCache returned error: %v", err)
	}
	t.Cleanup(cache.Close)

	health, ok := cache.CredentialHealth("apikey", "provider-1", now)
	if !ok {
		t.Fatal("expected credential health cache to be available")
	}
	// 分母只含 3 条有 upstream_model 的窗口内事件，空值样本与窗口外样本都不参与。
	if health.UpstreamModelMatch.Total != 3 || health.UpstreamModelMatch.Matched != 2 {
		t.Fatalf("unexpected match sample: %+v", health.UpstreamModelMatch)
	}
	if health.UpstreamModelMatch.MismatchCount() != 1 {
		t.Fatalf("expected 1 mismatch, got %d", health.UpstreamModelMatch.MismatchCount())
	}

	isolated, ok := cache.CredentialHealth("apikey", "provider-2", now)
	if !ok {
		t.Fatal("expected second identity health to be available")
	}
	if isolated.UpstreamModelMatch.Total != 1 || isolated.UpstreamModelMatch.Matched != 0 {
		t.Fatalf("expected provider-2 sample to stay isolated, got %+v", isolated.UpstreamModelMatch)
	}

	// 无样本身份必须报告不可用，而不是 0% 的红色。
	quiet, ok := cache.CredentialHealth("apikey", "missing-provider", now)
	if !ok {
		t.Fatal("expected missing credential health to still return an empty placeholder")
	}
	if quiet.UpstreamModelMatch.Total != 0 || quiet.UpstreamModelMatch.Matched != 0 {
		t.Fatalf("expected empty placeholder to carry no sample, got %+v", quiet.UpstreamModelMatch)
	}
	if _, available := credentialHealthMatchPercent(quiet.UpstreamModelMatch); available {
		t.Fatal("expected zero-sample match percent to report unavailable")
	}
}

// TestUpstreamModelMatchPercentBands 覆盖绿色/橙色/红色分界的 90/89/60/59 边界。
func TestUpstreamModelMatchPercentBands(t *testing.T) {
	cases := []struct {
		name      string
		matched   int64
		total     int64
		wantTone  string
		wantValue float64
	}{
		{name: "90 percent is green", matched: 90, total: 100, wantTone: "success", wantValue: 90},
		{name: "89 percent is warning", matched: 89, total: 100, wantTone: "warning", wantValue: 89},
		{name: "60 percent is warning", matched: 60, total: 100, wantTone: "warning", wantValue: 60},
		{name: "59 percent is danger", matched: 59, total: 100, wantTone: "danger", wantValue: 59},
		{name: "perfect sample is green", matched: 100, total: 100, wantTone: "success", wantValue: 100},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			stats := UpstreamModelMatchStats{Total: tc.total, Matched: tc.matched}
			percent, ok := stats.MatchPercent()
			if !ok {
				t.Fatalf("expected sample %+v to be available", stats)
			}
			if percent != tc.wantValue {
				t.Fatalf("expected %v%%, got %v%%", tc.wantValue, percent)
			}
			if tone := upstreamModelMatchToneForTest(percent); tone != tc.wantTone {
				t.Fatalf("expected tone %q for %v%%, got %q", tc.wantTone, percent, tone)
			}
		})
	}
}

// upstreamModelMatchToneForTest 复现前端分界，Go 侧只用于锁定 90/89/60/59 语义。
func upstreamModelMatchToneForTest(percent float64) string {
	switch {
	case percent >= 90:
		return "success"
	case percent >= 60:
		return "warning"
	default:
		return "danger"
	}
}

func TestIsUpstreamModelMatchTreatsMissingValuesAsUnobserved(t *testing.T) {
	for _, tc := range []struct {
		name     string
		request  string
		upstream string
		want     bool
	}{
		{name: "equal models match", request: "gpt-5", upstream: "gpt-5", want: true},
		{name: "different models mismatch", request: "gpt-5", upstream: "gpt-5-mini", want: false},
		{name: "missing upstream is unobserved", request: "gpt-5", upstream: "", want: false},
		{name: "blank upstream is unobserved", request: "gpt-5", upstream: "   ", want: false},
		{name: "missing request is unobserved", request: "", upstream: "gpt-5", want: false},
		{name: "both missing is unobserved", request: "", upstream: "", want: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsUpstreamModelMatch(tc.request, tc.upstream); got != tc.want {
				t.Fatalf("IsUpstreamModelMatch(%q, %q) = %t, want %t", tc.request, tc.upstream, got, tc.want)
			}
		})
	}
}
