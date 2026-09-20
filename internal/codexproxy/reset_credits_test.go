package codexproxy

import (
	"encoding/json"
	"testing"
)

func TestObservedResetCreditsSurviveSnapshotJSON(t *testing.T) {
	for _, tc := range []struct{ name, quota, want string }{
		{"positive", `{"reset_credits_available":2}`, "2"},
		{"zero", `{"reset_credits_available":0}`, "0"},
		{"null", `{"reset_credits_available":null}`, "null"},
		{"missing", `{}`, "null"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var account AccountMetadata
			if err := json.Unmarshal([]byte(`{"quota":`+tc.quota+`}`), &account); err != nil {
				t.Fatal(err)
			}
			data, err := json.Marshal(QuotaSnapshot{Quota: account.Quota})
			if err != nil {
				t.Fatal(err)
			}
			var snapshot struct {
				Quota map[string]json.RawMessage `json:"quota"`
			}
			if err := json.Unmarshal(data, &snapshot); err != nil {
				t.Fatal(err)
			}
			if got := string(snapshot.Quota["reset_credits_available"]); got != tc.want {
				t.Fatalf("got %s, want %s", got, tc.want)
			}
		})
	}
}
