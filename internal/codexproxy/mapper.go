package codexproxy

import (
	"cpa-usage-keeper/internal/entities"
	"cpa-usage-keeper/internal/repository"
	"cpa-usage-keeper/internal/service/tokenprocessor"
	"fmt"
	"strings"
	"time"
)

// CodexProxyProbeAPIGroupKey 是主动探测事件在 usage_events.api_group_key 中的独立分组。
//
// 这是探测与业务数据的隔离机制：所有既有聚合查询都按 api_group_key 过滤，业务统计拿的
// 是业务分组，因此探测数据天然被排除，不需要改动任何一处查询。source 两者都是
// codex-proxy，因为探测确实也是这个 producer 产出的。
const CodexProxyProbeAPIGroupKey = "codex-probe"

func (e Event) UsageEvent(fetchedAt time.Time) (entities.UsageEvent, error) {
	if e.EventType != "request.completed" && e.EventType != "request.failed" {
		return entities.UsageEvent{}, fmt.Errorf("unsupported codex proxy event type %q", e.EventType)
	}
	if (e.EventType == "request.failed") != e.Failed {
		return entities.UsageEvent{}, fmt.Errorf("codex proxy event type %q is inconsistent with failed=%t", e.EventType, e.Failed)
	}
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
	// Keeper's existing request column recognizes SSE through the POST prefix.
	// Only annotate bare paths with an explicit producer observation; preserve
	// legacy/unknown transports and already-qualified endpoints verbatim.
	endpoint := e.Endpoint
	if e.DownstreamTransport == "sse" && strings.HasPrefix(endpoint, "/") {
		endpoint = "POST " + endpoint
	}
	// 探测走独立分组，业务与探测的聚合结果因此互不污染；source 两者都是 codex-proxy，
	// 因为探测确实也是这个 producer 产出的。
	apiGroupKey := e.Provider
	if e.Probe != nil && *e.Probe {
		apiGroupKey = repository.CodexProxyProbeAPIGroupKey
	}
	return entities.UsageEvent{EventKey: e.EventID, APIGroupKey: apiGroupKey, Provider: e.Provider, Endpoint: endpoint, AuthType: "oauth", RequestID: e.RequestID, Model: e.Model, ReasoningEffort: e.ReasoningEffort, Timestamp: ts, Source: repository.CodexProxySource, AuthIndex: e.AccountEntryID, ExecutorType: tokenprocessor.CodexExecutor, Failed: e.Failed, Generate: boolPtr(!e.Failed), LatencyMS: valueInt64(e.LatencyMS), TTFTMS: e.TTFTMS, InputTokens: in, OutputTokens: out, ReasoningTokens: reason, CachedTokens: cached, CacheReadTokens: cached, TotalTokens: total, UpstreamModel: optionalString(e.UpstreamModel), StateCheck: optionalString(e.StateCheck), StateCheckReason: optionalString(e.StateCheckReason), StateCheckObservedBlocks: e.StateCheckObservedBlocks, StateCheckExpectedBlocks: e.StateCheckExpectedBlocks, ErrorCode: strings.TrimSpace(e.ErrorCode)}, nil
}

// optionalString 把可空观测字段折叠为空串；空值含义是“未观察到”，不是一致或正常。
func optionalString(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}

func boolPtr(v bool) *bool { return &v }
func valueInt64(v *int64) int64 {
	if v == nil {
		return 0
	}
	return *v
}

func AccountUsageIdentity(account AccountMetadata, now time.Time) entities.UsageIdentity {
	name := account.Email
	if name == "" {
		name = account.Label
	}
	if name == "" {
		name = account.AccountEntryID
	}
	var alias *string
	if account.Label != "" {
		value := account.Label
		alias = &value
	}
	status := account.Status
	disabled := status != "" && status != "active"
	var planType *string
	if account.PlanType != "" {
		value := account.PlanType
		planType = &value
	}
	return entities.UsageIdentity{
		Name:           name,
		Alias:          alias,
		AuthType:       entities.UsageIdentityAuthTypeCodexProxy,
		AuthTypeName:   "codex-proxy",
		Identity:       account.AccountEntryID,
		Type:           "codex-proxy-account",
		Provider:       "Codex Proxy",
		FileName:       nil,
		PlanType:       planType,
		Disabled:       &disabled,
		ActiveUntil:    account.ExpiresAt,
		StatsUpdatedAt: &now,
	}
}
