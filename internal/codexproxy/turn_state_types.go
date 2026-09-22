package codexproxy

type TurnStateOverview struct {
	Schema     string             `json:"schema"`
	ServerTime string             `json:"server_time"`
	Epoch      string             `json:"epoch"`
	Config     TurnStateConfig    `json:"config"`
	Summary    TurnStateCounters  `json:"summary"`
	Sessions   []TurnStateSession `json:"sessions"`
	Events     []TurnStateEvent   `json:"events"`
}
type TurnStateConfig struct {
	Enabled              bool   `json:"enabled"`
	PassiveEnabled       bool   `json:"passive_enabled"`
	ActiveEnabled        bool   `json:"active_enabled"`
	Mode                 string `json:"mode"`
	Fallback             string `json:"fallback"`
	AccountMode          string `json:"account_mode"`
	TtlSeconds           int64  `json:"ttl_seconds"`
	RefreshBeforeSeconds int64  `json:"refresh_before_seconds"`
	ProbeTimeoutSeconds  int64  `json:"probe_timeout_seconds"`
	CooldownSeconds      int64  `json:"cooldown_seconds"`
	MaxAttemptsPerRound  int64  `json:"max_attempts_per_round"`
	// Additive config fields from the flattened proxy schema. Pointers keep older
	// proxies valid; nil means the producer did not expose this field.
	HarvestProxyURL    *string `json:"harvest_proxy_url,omitempty"`
	Revalidate         *bool   `json:"revalidate,omitempty"`
	MismatchIsSuccess  *bool   `json:"mismatch_is_success,omitempty"`
	RevokeAfterSignals *int64  `json:"revoke_after_signals,omitempty"`
}
type TurnStateCounters struct {
	Sessions            int64 `json:"sessions"`
	Usable              int64 `json:"usable"`
	Ready               int64 `json:"ready"`
	Collecting          int64 `json:"collecting"`
	Expired             int64 `json:"expired"`
	Blocked             int64 `json:"blocked"`
	InjectionCount      int64 `json:"injection_count"`
	PassiveObservations int64 `json:"passive_observations"`
	// Additive (§8.2-like): passive attempts split by outcome so attempts are never
	// presented as successes. Optional for older proxies.
	PassiveAccepted *int64 `json:"passive_accepted,omitempty"`
	PassiveRejected *int64 `json:"passive_rejected,omitempty"`
	ActiveProbes    int64  `json:"active_probes"`
	AcceptedProbes  int64  `json:"accepted_probes"`
	RejectedProbes  int64  `json:"rejected_probes"`
	// Additive (§3.1 of the observability contract): the merged active-collection
	// counters across the generic probe and ticket-harvest paths, plus the start of the
	// cumulative window. Pointers keep older proxies valid.
	ActiveAttempts *int64  `json:"active_attempts,omitempty"`
	ActiveAccepted *int64  `json:"active_accepted,omitempty"`
	ActiveRejected *int64  `json:"active_rejected,omitempty"`
	Since          *string `json:"since,omitempty"`
	// The rolling dispatch rate, which is what an operator watches to see the current
	// collection pace; the cumulative counters above cannot answer "how fast right now".
	ActiveLastHour *int64 `json:"active_last_hour,omitempty"`
}
type TurnStateSession struct {
	EntryId          string            `json:"entry_id"`
	Model            string            `json:"model"`
	AccountMode      string            `json:"account_mode"`
	Phase            string            `json:"phase"`
	AccountLabel     *string           `json:"account_label"`
	Diagnostic       *string           `json:"diagnostic"`
	LastObservedAt   *string           `json:"last_observed_at"`
	LastInjectedAt   *string           `json:"last_injected_at"`
	NextProbeAt      *string           `json:"next_probe_at"`
	Active           *TurnStateSummary `json:"active"`
	Ready            *TurnStateSummary `json:"ready"`
	InjectionCount   int64             `json:"injection_count"`
	ObservationCount int64             `json:"observation_count"`
	// 被动观测的成功/未通过拆分。与 ObservationCount 同源同生命周期，
	// 满足 passive_accepted + passive_rejected == observation_count；
	// 旧 proxy 不返回时为空，展示层必须中性退化而不是自己相减。
	PassiveAccepted *int64 `json:"passive_accepted,omitempty"`
	PassiveRejected *int64 `json:"passive_rejected,omitempty"`
	ProbeCount       int64             `json:"probe_count"`
	Strikes          int64             `json:"strikes"`
	// Additive contract fields (codex-proxy.turn-state-overview.v1). Optional so a
	// snapshot from an older proxy still decodes.
	Excluded           *bool             `json:"excluded,omitempty"`
	LastUpstreamModel  *string           `json:"last_upstream_model,omitempty"`
	ModelMismatch      *bool             `json:"model_mismatch,omitempty"`
	LastResult         *string           `json:"last_result,omitempty"`
	LastFailure        *TurnStateFailure `json:"last_failure,omitempty"`
	WsConnectionReused *int64            `json:"ws_connection_reused,omitempty"`
	PlanProvenance     *string           `json:"plan_provenance,omitempty"`
	// TicketRoundCount 是该 账号×模型 的主动采集轮数。上一轮加入了 TS 白名单
	// 却漏了这里，于是被后端静默丢弃、前端永远拿不到。
	TicketRoundCount *int64 `json:"ticket_round_count,omitempty"`
}

// TurnStateFailure is the structured reason the most recent probe/observation did
// not pass, so Keeper can explain a rejection without re-deriving it.
type TurnStateFailure struct {
	Code           string  `json:"code"`
	Reason         *string `json:"reason"`
	Verdict        *string `json:"verdict"`
	ObservedBlocks *int64  `json:"observed_blocks"`
	ExpectedBlocks *int64  `json:"expected_blocks"`
}
type TurnStateSummary struct {
	Usable      bool    `json:"usable"`
	Length      int64   `json:"length"`
	Blocks      int64   `json:"blocks"`
	Version     int64   `json:"version"`
	Fingerprint string  `json:"fingerprint"`
	IssuedAt    string  `json:"issued_at"`
	ExpiresAt   string  `json:"expires_at"`
	RouteId     *string `json:"route_id"`
}
type TurnStateEvent struct {
	Id      string          `json:"id"`
	At      string          `json:"at"`
	Source  string          `json:"source"`
	Action  string          `json:"action"`
	Result  string          `json:"result"`
	EntryId *string         `json:"entry_id"`
	Model   *string         `json:"model"`
	RouteId *string         `json:"route_id"`
	Length  *int64          `json:"length"`
	Blocks  *int64          `json:"blocks"`
	Usage   *TurnStateUsage `json:"usage"`
	// Additive contract fields (§8.3); optional for older proxies.
	Reason         *string `json:"reason,omitempty"`
	ObservedBlocks *int64  `json:"observed_blocks,omitempty"`
	ExpectedBlocks *int64  `json:"expected_blocks,omitempty"`
	UpstreamModel  *string `json:"upstream_model,omitempty"`
	Verdict        *string `json:"verdict,omitempty"`
}
type TurnStateUsage struct {
	InputTokens     *int64 `json:"input_tokens"`
	OutputTokens    *int64 `json:"output_tokens"`
	ReasoningTokens *int64 `json:"reasoning_tokens"`
}
