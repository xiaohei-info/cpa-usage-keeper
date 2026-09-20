package api

import (
	"context"
	"cpa-usage-keeper/internal/auth"
	"cpa-usage-keeper/internal/codexproxy"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

type turnStateStub struct{ fail bool }

func (s turnStateStub) TurnStateOverview(context.Context) (*codexproxy.TurnStateOverview, error) {
	if s.fail {
		return nil, errors.New("secret upstream")
	}
	return &codexproxy.TurnStateOverview{Schema: codexproxy.TurnStateSchema}, nil
}
func TestTurnStateAdminReadOnly(t *testing.T) {
	sessions := auth.NewSessionManager(time.Hour)
	admin, _, err := sessions.Create()
	if err != nil {
		t.Fatal(err)
	}
	viewer, _, err := sessions.CreateAPIKeyViewer(42)
	if err != nil {
		t.Fatal(err)
	}
	cfg := AuthConfig{Enabled: true, LoginPassword: "test", SessionTTL: time.Hour}
	for _, tc := range []struct {
		name, token, method string
		provider            TurnStateProvider
		status              int
	}{
		{"admin", admin, "GET", turnStateStub{}, 200}, {"anonymous", "", "GET", turnStateStub{}, 401}, {"viewer", viewer, "GET", turnStateStub{}, 403},
		{"unconfigured", admin, "GET", nil, 503}, {"failure", admin, "GET", turnStateStub{true}, 503},
		{"post", admin, "POST", turnStateStub{}, 404}, {"put", admin, "PUT", turnStateStub{}, 404}, {"patch", admin, "PATCH", turnStateStub{}, 404}, {"delete", admin, "DELETE", turnStateStub{}, 404},
	} {
		t.Run(tc.name, func(t *testing.T) {
			router := NewRouter(nil, nil, nil, nil, cfg, NewAuthHandler(cfg, sessions), "/keeper", OptionalProviders{TurnState: tc.provider})
			req := httptest.NewRequest(tc.method, "/keeper/api/v1/turn-state/overview", nil)
			req.Header.Set("X-CPA-Usage-Keeper-Request", "fetch")
			if tc.token != "" {
				req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: tc.token})
			}
			resp := httptest.NewRecorder()
			router.ServeHTTP(resp, req)
			if resp.Code != tc.status {
				t.Fatalf("got %d: %s", resp.Code, resp.Body.String())
			}
			if tc.method == "GET" && (tc.status == 200 || tc.status == 503) && resp.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("missing no-store")
			}
			if tc.status == 503 && resp.Body.String() != "{\"error\":\"turn_state_unavailable\"}" {
				t.Fatal("unsanitized error")
			}
		})
	}
}
