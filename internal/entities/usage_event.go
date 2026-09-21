package entities

import "time"

// UsageEvent 是落库后的单条 usage 请求事件实体。
type UsageEvent struct {
	ID                  int64 `gorm:"primaryKey;index:idx_usage_events_timestamp_id,sort:desc,priority:2;index:idx_usage_events_auth_type_auth_index_id,priority:3;index:idx_usage_events_auth_index_timestamp_id,priority:3"`
	EventKey            string
	APIGroupKey         string  `gorm:"index:idx_usage_events_api_group_key_timestamp,priority:1"`
	Provider            string  `gorm:"column:provider"`
	Endpoint            string  `gorm:"column:endpoint"`
	AuthType            string  `gorm:"column:auth_type;index:idx_usage_events_auth_type_auth_index_id,priority:1"`
	RequestID           string  `gorm:"column:request_id"`
	SessionID           string  `gorm:"column:session_id"`
	ParentSessionID     string  `gorm:"column:parent_session_id"`
	ClientIP            *string `gorm:"column:client_ip"`
	XForwardedFor       *string `gorm:"column:x_forwarded_for"`
	UserAgent           *string `gorm:"column:user_agent"`
	Model               string  `gorm:"index:idx_usage_events_model"`
	ModelAlias          *string `gorm:"column:model_alias"`
	ResponseModel       string  `gorm:"column:response_model;not null;default:''"`
	ReasoningEffort     string  `gorm:"column:reasoning_effort;not null;default:''"`
	ServiceTier         string  `gorm:"column:service_tier;not null;default:''"`
	ResponseServiceTier string  `gorm:"column:response_service_tier;not null;default:''"`
	ExecutorType        string  `gorm:"column:executor_type;not null;default:''"`
	// UpstreamModel 是上游真实响应模型；空值表示未观察到，不等于与请求模型一致。
	UpstreamModel string `gorm:"column:upstream_model;not null;default:''"`
	// StateCheck 保存 Codex turn-state 结构判定码；空值表示未上报，未知码原样保留。
	StateCheck string `gorm:"column:state_check;not null;default:''"`
	// StateCheckReason 是首个失败规则码；空值表示判定为 ok 或 no_state。
	StateCheckReason string `gorm:"column:state_check_reason;not null;default:''"`
	// StateCheckObservedBlocks/ExpectedBlocks 仅在 block_mismatch 时上报，NULL 区分“未上报”与真实 0。
	StateCheckObservedBlocks *int64    `gorm:"column:state_check_observed_blocks"`
	StateCheckExpectedBlocks *int64    `gorm:"column:state_check_expected_blocks"`
	Timestamp                time.Time `gorm:"serializer:storageTime;index:idx_usage_events_timestamp_id,sort:desc,priority:1;index:idx_usage_events_auth_index_timestamp_id,priority:2;index:idx_usage_events_api_group_key_timestamp,priority:2"`
	Source                   string
	AuthIndex                string `gorm:"index:idx_usage_events_auth_index;index:idx_usage_events_auth_type_auth_index_id,priority:2;index:idx_usage_events_auth_index_timestamp_id,priority:1"`
	Failed                   bool
	StatusCode               *int  `gorm:"column:status_code"`
	Stream                   *bool `gorm:"column:stream"`
	Generate                 *bool `gorm:"column:generate;not null;default:true"`
	LatencyMS                int64
	TTFTMS                   *int64 `gorm:"column:ttft_ms"`
	InputTokens              int64
	OutputTokens             int64
	ReasoningTokens          int64
	CachedTokens             int64
	CacheReadTokens          int64 `gorm:"not null;default:0"`
	CacheReadPresent         bool  `gorm:"-" json:"-"` // 仅在 Redis 入库归一化期间区分 CPA canonical zero 与旧 payload。
	CacheCreationTokens      int64 `gorm:"not null;default:0"`
	TotalTokens              int64
	CreatedAt                time.Time `gorm:"serializer:storageTime"`
}
