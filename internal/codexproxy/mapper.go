package codexproxy

import (
	"cpa-usage-keeper/internal/entities"
	"fmt"
	"time"
)

func (e Event) UsageEvent(fetchedAt time.Time) (entities.UsageEvent, error) {
	if e.EventID == "" || e.RequestID == "" {
		return entities.UsageEvent{}, fmt.Errorf("event id and request id are required")
	}
	ts := e.OccurredAt
	if ts.IsZero() {
		ts = fetchedAt
	}
	u := e.Usage
	var in, out, cached, reason, total int64
	if u != nil {
		in, out, cached, reason = u.InputTokens, u.OutputTokens, u.CachedTokens, u.ReasoningTokens
		// Codex input/output are inclusive totals; cached is a subset of input
		// and reasoning is a separate breakdown of output. Keep TotalTokens as
		// input+output to match Keeper's CPA usage semantics and avoid double-counting.
		total = in + out
	}
	if total == 0 {
		total = in + out + reason
	}
	return entities.UsageEvent{EventKey: e.EventID, APIGroupKey: e.Provider, Provider: e.Provider, Endpoint: e.Endpoint, AuthType: "oauth", RequestID: e.RequestID, Model: e.Model, Timestamp: ts, Source: "codex-proxy", AuthIndex: e.AccountEntryID, Failed: e.Failed, Generate: boolPtr(!e.Failed), LatencyMS: valueInt64(e.LatencyMS), TTFTMS: e.TTFTMS, InputTokens: in, OutputTokens: out, ReasoningTokens: reason, CachedTokens: cached, TotalTokens: total}, nil
}
func boolPtr(v bool) *bool { return &v }
func valueInt64(v *int64) int64 {
	if v == nil {
		return 0
	}
	return *v
}
