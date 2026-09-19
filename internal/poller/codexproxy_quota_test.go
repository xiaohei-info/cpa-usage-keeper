package poller

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"cpa-usage-keeper/internal/codexproxy"
	"cpa-usage-keeper/internal/entities"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestCodexQuotaSnapshotLifecycle(t *testing.T) {
	body := `{"schema":"codex-proxy.keeper-account-metadata.v1","accounts":[{"account_entry_id":"acct","status":"active","quota":{"rate_limit":{"used_percent":0,"remaining_percent":100,"reset_at":null}},"quota_fetched_at":"2026-09-19T00:00:00Z","quota_verify_required":false}]}`
	status := 200
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(status); _, _ = w.Write([]byte(body)) }))
	defer server.Close()
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "quota.sqlite")), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	defer sqlDB.Close()
	if err := db.AutoMigrate(&entities.UsageIdentity{}); err != nil {
		t.Fatal(err)
	}
	runner := NewCodexProxyRunner(db, codexproxy.NewClient(server.URL, "", time.Second), time.Second, 10)
	sync := func() error { runner.lastAccountSync = time.Time{}; return runner.syncAccounts(context.Background()) }
	if _, ok := runner.CodexQuota("acct"); ok {
		t.Fatal("invented initial snapshot")
	}
	if err := sync(); err != nil {
		t.Fatal(err)
	}
	snapshot, ok := runner.CodexQuota("acct")
	if !ok || snapshot.Quota == nil || snapshot.Quota.Primary.UsedPercent == nil || *snapshot.Quota.Primary.UsedPercent != 0 || snapshot.Quota.Primary.ResetAt != nil || snapshot.VerifyRequired == nil || *snapshot.VerifyRequired || snapshot.Stale {
		t.Fatalf("lost zero/null semantics: %+v", snapshot)
	}
	observed := *snapshot.FetchedAt
	status = 503
	if sync() == nil {
		t.Fatal("accepted failed upstream")
	}
	snapshot, _ = runner.CodexQuota("acct")
	if !snapshot.Stale || !snapshot.FetchedAt.Equal(observed) {
		t.Fatal("failure changed observation freshness")
	}
	status = 200
	body = `{"schema":"codex-proxy.keeper-account-metadata.v1","accounts":[{"account_entry_id":"acct","status":"disabled"}]}`
	if err := sync(); err != nil {
		t.Fatal(err)
	}
	snapshot, _ = runner.CodexQuota("acct")
	if snapshot.Quota != nil || snapshot.FetchedAt != nil || snapshot.VerifyRequired != nil || snapshot.Stale || snapshot.Status != "disabled" {
		t.Fatal("absent update retained old quota")
	}
	body = `{"schema":"codex-proxy.keeper-account-metadata.v1","accounts":[]}`
	if err := sync(); err != nil {
		t.Fatal(err)
	}
	if _, ok := runner.CodexQuota("acct"); ok {
		t.Fatal("healthy empty retained quota")
	}
}
