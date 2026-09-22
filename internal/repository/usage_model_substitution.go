package repository

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"cpa-usage-keeper/internal/entities"
	"cpa-usage-keeper/internal/helper"
	"cpa-usage-keeper/internal/timeutil"

	"gorm.io/gorm"
)

const (
	// ModelSubstitutionSchema 是前端校验使用的响应协议版本。
	ModelSubstitutionSchema = "cpa-usage-keeper.turn-state-model-mismatch.v1"
	// DefaultModelSubstitutionRange 是未指定或越界时回退的范围；非法值一律夹紧到它。
	DefaultModelSubstitutionRange = "24h"
	// ModelSubstitutionMaxBuckets 是趋势图分桶上限；白名单里最大的档位是 72，永远低于它。
	ModelSubstitutionMaxBuckets = 120
	// 输出上限：矩阵单元格与按请求模型汇总都必须有界，绝不返回无界数组。
	modelSubstitutionMatrixCellLimit     = 120
	modelSubstitutionRequestedModelLimit = 40
	// 最近观测每个请求模型只保留一行，上限与按模型汇总保持同一量级。
	modelSubstitutionCurrentLimit = 100
)

// ModelSubstitutionWindow 是已经夹紧到白名单的查询窗口与分桶方式。
type ModelSubstitutionWindow struct {
	Range         string
	Start         time.Time
	End           time.Time
	BucketSeconds int64
	// BucketStarts 是升序排列的桶起点；长度固定为 60/72/24/7/30，均在上限内。
	BucketStarts []time.Time
}

// modelSubstitutionRangeSpec 是白名单唯一定义：范围 -> 桶宽 + 桶数。
type modelSubstitutionRangeSpec struct {
	bucketSeconds int64
	bucketCount   int
}

// 分桶刻意保持在 60 个以内，7d/30d 用自然日桶，其余用整分/整时桶。
var modelSubstitutionRangeSpecs = map[string]modelSubstitutionRangeSpec{
	"1h":  {bucketSeconds: 60, bucketCount: 60},
	"6h":  {bucketSeconds: 300, bucketCount: 72},
	"24h": {bucketSeconds: 3600, bucketCount: 24},
	"7d":  {bucketSeconds: 24 * 3600, bucketCount: 7},
	"30d": {bucketSeconds: 24 * 3600, bucketCount: 30},
}

// 状态判定码字面量在这里定义一次，Go 判定与 SQL CASE 都引用它们，避免两套规则各自漂移。
const (
	stateCheckOKCode      = "ok"
	stateCheckNoStateCode = "no_state"
)

// IsStateCheckObserved 是状态检查分母的唯一定义：空值与 no_state 表示上游没有上报可检查的状态，
// 既不计入分子也不计入分母，与 upstream_model 空值的处理保持一致。
func IsStateCheckObserved(stateCheck string) bool {
	code := strings.TrimSpace(stateCheck)
	return code != "" && code != stateCheckNoStateCode
}

// IsStateCheckFailure 是“可能降智”的唯一定义：已观测但判定不是 ok。
// 未知判定码按保守口径算失败，避免未来新增的失败码被静默当成通过。
func IsStateCheckFailure(stateCheck string) bool {
	code := strings.TrimSpace(stateCheck)
	return IsStateCheckObserved(code) && code != stateCheckOKCode
}

// ParseModelSubstitutionWindow 把请求范围夹紧到白名单，并生成固定的对齐桶边界。
// 未知值回退 24h 而不是报错：响应中的 Range 字段始终回显实际生效的范围。
func ParseModelSubstitutionWindow(rangeValue string, now time.Time) (ModelSubstitutionWindow, error) {
	rangeValue = strings.TrimSpace(rangeValue)
	spec, ok := modelSubstitutionRangeSpecs[rangeValue]
	if !ok {
		rangeValue = DefaultModelSubstitutionRange
		spec = modelSubstitutionRangeSpecs[rangeValue]
	}
	if spec.bucketCount > ModelSubstitutionMaxBuckets {
		return ModelSubstitutionWindow{}, fmt.Errorf("model substitution range %q exceeds %d buckets", rangeValue, ModelSubstitutionMaxBuckets)
	}

	normalizedNow := timeutil.NormalizeStorageTime(now)
	var end time.Time
	bucketStarts := make([]time.Time, 0, spec.bucketCount)
	if spec.bucketSeconds >= 24*3600 {
		// 自然日桶必须按时区自然日生成，固定 24 小时累加会在 DST 切换时漂移。
		end = time.Date(normalizedNow.Year(), normalizedNow.Month(), normalizedNow.Day(), 0, 0, 0, 0, normalizedNow.Location())
		if !normalizedNow.Equal(end) {
			end = end.AddDate(0, 0, 1)
		}
		start := end.AddDate(0, 0, -spec.bucketCount)
		for index := range spec.bucketCount {
			bucketStarts = append(bucketStarts, start.AddDate(0, 0, index))
		}
	} else {
		span := time.Duration(spec.bucketSeconds) * time.Second
		// 结尾向上对齐到下一个桶边界，让尚未走完的当前桶也出现在趋势里。
		end = normalizedNow.Truncate(span).Add(span)
		start := end.Add(-time.Duration(spec.bucketCount) * span)
		for index := range spec.bucketCount {
			bucketStarts = append(bucketStarts, start.Add(time.Duration(index)*span))
		}
	}

	return ModelSubstitutionWindow{
		Range:         rangeValue,
		Start:         bucketStarts[0],
		End:           end,
		BucketSeconds: spec.bucketSeconds,
		BucketStarts:  bucketStarts,
	}, nil
}

// ModelSubstitutionBucket 是趋势图单个桶：一致率与状态检查失败率各用自己的分母。
type ModelSubstitutionBucket struct {
	Start time.Time
	// Match 只统计 upstream_model 非空的事件。
	Match UpstreamModelMatchStats
	// StateCheckObserved/Failed 只统计 state_check 已上报的事件。
	StateCheckObserved int64
	StateCheckFailed   int64
}

// ModelSubstitutionCell 是 requested_model x upstream_model 的计数单元。
type ModelSubstitutionCell struct {
	RequestedModel string
	UpstreamModel  string
	Count          int64
	Matched        bool
	// Share 是该组合占同一请求模型全部“带模型信息”请求的比例（0..1）。
	Share float64
}

// ModelSubstitutionModelStats 是单个请求模型的一致率汇总，等价于矩阵最后一列。
type ModelSubstitutionModelStats struct {
	RequestedModel string
	Match          UpstreamModelMatchStats
}

// ModelSubstitutionTopSubstitution 是样本量最大的替换组合。
type ModelSubstitutionTopSubstitution struct {
	From  string
	To    string
	Count int64
}

// ModelSubstitutionCurrentObservation 是单个「账号 x 模型」在窗口内的观测与采集汇总。
// 只携带展示所需字段，绝不含 turn-state 原文、指纹、prompt 或错误正文。
//
// 按账号分组是刻意的：同一请求模型可以在多个账号上被服务成不同的上游模型，
// 只按模型分组会让这些差异互相覆盖。
type ModelSubstitutionCurrentObservation struct {
	RequestedModel string
	UpstreamModel  string
	Matched        bool
	ObservedAt     time.Time
	AccountEntryID string
	// AccountName 是账号显示名（别名 -> 邮箱），空表示未登记，由展示层回退到 id 前缀。
	AccountName string
	// StateCheck/StateCheckReason 空值表示上游未上报；未知码原样保留，由展示层中性呈现。
	StateCheck               string
	StateCheckReason         string
	StateCheckObservedBlocks *int64
	StateCheckExpectedBlocks *int64
	// 以下为本组窗口聚合：请求数、替换数、状态检查分母与失败数。
	RequestCount       int64
	Mismatched         int64
	StateCheckObserved int64
	StateCheckFailed   int64
	// 以下为该组主动探测执行统计（读 api_group_key='codex-probe'）。
	ProbeAttempts int64
	ProbeAccepted int64
	ProbeRejected int64
	ProbeTimeouts int64
}

// ModelSubstitutionSnapshot 是模型替换观测接口的完整有界快照。
type ModelSubstitutionSnapshot struct {
	Window ModelSubstitutionWindow
	// Summary.Total 是有 upstream_model 的事件数；为 0 表示窗口内没有可用样本。
	Summary UpstreamModelMatchStats
	Buckets []ModelSubstitutionBucket
	Matrix  []ModelSubstitutionCell
	Models  []ModelSubstitutionModelStats
	// Current 是每个请求模型最近一次观测；按观测时间降序，长度不超过 modelSubstitutionCurrentLimit。
	Current []ModelSubstitutionCurrentObservation
	Top     *ModelSubstitutionTopSubstitution
	// Truncated 表示矩阵或按模型汇总命中上限被截断，前端据此提示样本不完整。
	Truncated bool
}

// EmptyModelSubstitutionSnapshot 为给定窗口补齐零样本桶，让未配置 provider 的响应与真实空查询同构。
func EmptyModelSubstitutionSnapshot(window ModelSubstitutionWindow) ModelSubstitutionSnapshot {
	buckets := make([]ModelSubstitutionBucket, len(window.BucketStarts))
	for index, start := range window.BucketStarts {
		buckets[index].Start = start
	}
	return ModelSubstitutionSnapshot{Window: window, Buckets: buckets, Matrix: []ModelSubstitutionCell{}, Models: []ModelSubstitutionModelStats{}, Current: []ModelSubstitutionCurrentObservation{}}
}

// ModelSubstitutionProvider 用只读聚合回答“谁被替换成谁”。
type ModelSubstitutionProvider struct {
	db *gorm.DB
}

func NewModelSubstitutionProvider(db *gorm.DB) *ModelSubstitutionProvider {
	return &ModelSubstitutionProvider{db: db}
}

type modelSubstitutionCellKey struct {
	requested string
	upstream  string
}

// ModelSubstitution 一次性聚合时间桶、矩阵与按模型汇总，只读、无写入。
func (p *ModelSubstitutionProvider) ModelSubstitution(ctx context.Context, rangeValue string, now time.Time) (ModelSubstitutionSnapshot, error) {
	window, err := ParseModelSubstitutionWindow(rangeValue, now)
	if err != nil {
		return ModelSubstitutionSnapshot{}, err
	}
	snapshot := EmptyModelSubstitutionSnapshot(window)
	if p == nil || p.db == nil {
		return snapshot, fmt.Errorf("model substitution database is nil")
	}

	rows, err := loadModelSubstitutionRows(ctx, p.db, window)
	if err != nil {
		return ModelSubstitutionSnapshot{}, err
	}

	bucketIndexByKey := modelSubstitutionBucketKeys(window)
	cellCounts := map[modelSubstitutionCellKey]int64{}
	modelMatch := map[string]UpstreamModelMatchStats{}

	for _, row := range rows {
		requested := strings.TrimSpace(row.RequestedModel)
		upstream := strings.TrimSpace(row.UpstreamModel)

		if index, ok := bucketIndexByKey[row.BucketKey]; ok {
			bucket := &snapshot.Buckets[index]
			bucket.StateCheckObserved += row.StateCheckObserved
			bucket.StateCheckFailed += row.StateCheckFailed
			// 没有 upstream_model 的桶行完全不进一致率，既不算一致也不算替换。
			if upstream != "" {
				bucket.Match.Total += row.RequestCount
				if IsUpstreamModelMatch(requested, upstream) {
					bucket.Match.Matched += row.RequestCount
				}
			}
		}
		if upstream == "" {
			continue
		}

		snapshot.Summary.Total += row.RequestCount
		if IsUpstreamModelMatch(requested, upstream) {
			snapshot.Summary.Matched += row.RequestCount
		}
		cellCounts[modelSubstitutionCellKey{requested: requested, upstream: upstream}] += row.RequestCount
		stats := modelMatch[requested]
		stats.Total += row.RequestCount
		if IsUpstreamModelMatch(requested, upstream) {
			stats.Matched += row.RequestCount
		}
		modelMatch[requested] = stats
	}

	matrix, matrixTruncated := buildModelSubstitutionMatrix(cellCounts, modelMatch)
	models, modelsTruncated := buildModelSubstitutionModelStats(modelMatch)
	snapshot.Matrix = matrix
	snapshot.Models = models
	snapshot.Truncated = matrixTruncated || modelsTruncated
	snapshot.Top = topModelSubstitution(snapshot.Matrix)

	current, err := loadModelSubstitutionCurrent(ctx, p.db, window)
	if err != nil {
		return ModelSubstitutionSnapshot{}, err
	}
	// 合并表的行键是账号 x 模型：把观测、业务聚合、探测聚合三份数据按同一个键并起来。
	// 只出现在聚合里的组（例如窗口内有过请求但从没返回过上游模型）也必须出行，
	// 否则用户会在表里“看不到”一个确实在跑的账号。
	aggregates, err := loadModelSubstitutionGroupAggregates(ctx, p.db, window)
	if err != nil {
		return ModelSubstitutionSnapshot{}, err
	}
	probes, err := loadProbeGroupAggregates(ctx, p.db, window)
	if err != nil {
		return ModelSubstitutionSnapshot{}, err
	}
	current, err = mergeModelSubstitutionGroups(ctx, p.db, current, aggregates, probes)
	if err != nil {
		return ModelSubstitutionSnapshot{}, err
	}
	snapshot.Current = current
	return snapshot, nil
}

// mergeModelSubstitutionGroups 把观测行、业务聚合、探测聚合按「账号 x 模型」合成同一批行。
//
// 输出顺序与 SQL 一致（观测时间降序），没有观测的组排在末尾，保证表格稳定且可预测。
func mergeModelSubstitutionGroups(ctx context.Context, db *gorm.DB, observations []ModelSubstitutionCurrentObservation, aggregates map[modelSubstitutionGroupKey]modelSubstitutionGroupAggregate, probes map[modelSubstitutionGroupKey]probeGroupAggregate) ([]ModelSubstitutionCurrentObservation, error) {
	merged := make(map[modelSubstitutionGroupKey]*ModelSubstitutionCurrentObservation, len(observations))
	order := make([]modelSubstitutionGroupKey, 0, len(observations))
	for _, observation := range observations {
		key := modelSubstitutionGroupKey{account: observation.AccountEntryID, model: observation.RequestedModel}
		if _, exists := merged[key]; exists {
			continue
		}
		copy := observation
		merged[key] = &copy
		order = append(order, key)
	}
	// 只出现在聚合里的组：先按业务聚合建行，再补上只有探测数据的组。
	for key := range aggregates {
		if _, exists := merged[key]; exists {
			continue
		}
		merged[key] = &ModelSubstitutionCurrentObservation{RequestedModel: key.model, AccountEntryID: key.account}
		order = append(order, key)
	}
	for key := range probes {
		if _, exists := merged[key]; exists {
			continue
		}
		merged[key] = &ModelSubstitutionCurrentObservation{RequestedModel: key.model, AccountEntryID: key.account}
		order = append(order, key)
	}
	// 账号名只在有值时填充；解析失败不阻断整份快照（表格退化成 id 前缀）。
	authIndexes := make([]string, 0, len(order))
	for _, key := range order {
		if key.account != "" {
			authIndexes = append(authIndexes, key.account)
		}
	}
	names, err := loadCodexProxyAccountNames(ctx, db, authIndexes)
	if err != nil {
		return nil, err
	}
	result := make([]ModelSubstitutionCurrentObservation, 0, len(order))
	for _, key := range order {
		if len(result) >= modelSubstitutionCurrentLimit {
			// 合并后仍必须有界：分组键变细（账号 x 模型）后行数会比按模型分组更多，
			// 上限拿来卡最终输出，保证响应体不会被无界行数撞破。
			break
		}
		row := merged[key]
		row.AccountName = names[key.account]
		if aggregate, ok := aggregates[key]; ok {
			row.RequestCount = aggregate.RequestCount
			row.Mismatched = aggregate.Mismatched
			row.StateCheckObserved = aggregate.StateCheckObserved
			row.StateCheckFailed = aggregate.StateCheckFailed
		}
		if probe, ok := probes[key]; ok {
			row.ProbeAttempts = probe.ProbeAttempts
			row.ProbeAccepted = probe.ProbeAccepted
			row.ProbeRejected = probe.ProbeRejected
			row.ProbeTimeouts = probe.ProbeTimeouts
		}
		result = append(result, *row)
	}
	return result, nil
}

// modelSubstitutionCurrentRow 是观测查询的原始行；timestamp 由 SQL 返回文本，
// 因为 Raw 查询绕过了 storageTime serializer。
type modelSubstitutionCurrentRow struct {
	RequestedModel           string `gorm:"column:requested_model"`
	UpstreamModel            string `gorm:"column:upstream_model"`
	AccountEntryID           string `gorm:"column:account_entry_id"`
	ObservedAt               string `gorm:"column:observed_at"`
	StateCheck               string `gorm:"column:state_check"`
	StateCheckReason         string `gorm:"column:state_check_reason"`
	StateCheckObservedBlocks *int64 `gorm:"column:state_check_observed_blocks"`
	StateCheckExpectedBlocks *int64 `gorm:"column:state_check_expected_blocks"`
}

// modelSubstitutionGroupKey 是合并表的行键：账号 x 模型。
//
// 必须带上账号：同一请求模型会在不同账号上被服务成不同的上游模型（实测 gpt-5.6-sol
// 横跨 3 个账号），只按模型分组会让这些差异互相覆盖。
type modelSubstitutionGroupKey struct {
	account string
	model   string
}

// modelSubstitutionGroupAggregate 是单个账号 x 模型的业务窗口聚合。
type modelSubstitutionGroupAggregate struct {
	RequestCount       int64
	Mismatched         int64
	StateCheckObserved int64
	StateCheckFailed   int64
}

// probeGroupAggregate 是单个账号 x 模型的主动探测聚合（独立 api_group_key）。
type probeGroupAggregate struct {
	ProbeAttempts int64
	ProbeAccepted int64
	ProbeRejected int64
	ProbeTimeouts int64
}

// loadModelSubstitutionCurrent 取每个「账号 x 模型」最近一次观测。
// 用窗口函数在 SQL 内完成“每组取最新”，避免把整个窗口的原始行搬进内存；
// 排序按真实 instant（epoch 秒）而不是带 offset 的文本，再用 id 打破同秒并列。
func loadModelSubstitutionCurrent(ctx context.Context, db *gorm.DB, window ModelSubstitutionWindow) ([]ModelSubstitutionCurrentObservation, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	// 与主查询一致的宽范围预筛：storageTime 文本顺序不等于 instant 顺序，
	// 先用文本索引取宽范围，再用 epoch 精确复核。
	coarseStart := timeutil.FormatStorageTime(window.Start.Add(-24 * time.Hour))
	coarseEnd := timeutil.FormatStorageTime(window.End.Add(24 * time.Hour))
	epochExpression := "CAST(strftime('%s', timestamp) AS INTEGER)"
	query := fmt.Sprintf(`SELECT requested_model, upstream_model, account_entry_id, observed_at,
	state_check, state_check_reason, state_check_observed_blocks, state_check_expected_blocks
FROM (
	SELECT model AS requested_model,
		TRIM(upstream_model) AS upstream_model,
		TRIM(auth_index) AS account_entry_id,
		timestamp AS observed_at,
		TRIM(state_check) AS state_check,
		TRIM(state_check_reason) AS state_check_reason,
		state_check_observed_blocks,
		state_check_expected_blocks,
		%s AS observed_epoch,
		ROW_NUMBER() OVER (PARTITION BY %s, model ORDER BY %s DESC, id DESC) AS row_number
	FROM usage_events
	WHERE TRIM(upstream_model) <> '' AND TRIM(model) <> ''
		AND timestamp >= ? AND timestamp < ? AND %s >= ? AND %s < ?
) WHERE row_number = 1
ORDER BY observed_epoch DESC, account_entry_id, requested_model
LIMIT ?`, epochExpression, modelSubstitutionObservedGroupExpression, epochExpression, epochExpression, epochExpression)

	rows, err := db.WithContext(ctx).Raw(query,
		coarseStart, coarseEnd, window.Start.Unix(), window.End.Unix(), modelSubstitutionCurrentLimit).Rows()
	if err != nil {
		return nil, fmt.Errorf("load model substitution current rows: %w", err)
	}
	defer rows.Close()

	current := make([]ModelSubstitutionCurrentObservation, 0, modelSubstitutionCurrentLimit)
	for rows.Next() {
		var row modelSubstitutionCurrentRow
		if err := db.ScanRows(rows, &row); err != nil {
			return nil, fmt.Errorf("scan model substitution current row: %w", err)
		}
		observedAt, err := timeutil.ParseStorageTime(row.ObservedAt)
		if err != nil {
			return nil, fmt.Errorf("parse model substitution current timestamp: %w", err)
		}
		requested := strings.TrimSpace(row.RequestedModel)
		upstream := strings.TrimSpace(row.UpstreamModel)
		current = append(current, ModelSubstitutionCurrentObservation{
			RequestedModel:           requested,
			UpstreamModel:            upstream,
			Matched:                  IsUpstreamModelMatch(requested, upstream),
			ObservedAt:               observedAt,
			AccountEntryID:           row.AccountEntryID,
			StateCheck:               row.StateCheck,
			StateCheckReason:         row.StateCheckReason,
			StateCheckObservedBlocks: row.StateCheckObservedBlocks,
			StateCheckExpectedBlocks: row.StateCheckExpectedBlocks,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate model substitution current rows: %w", err)
	}
	return current, nil
}

// modelSubstitutionObservedGroupExpression 是业务分组键的唯一写法。
// 与 last/window 聚类保持一致，避免三处各自写一套导致分组结果不同。
const modelSubstitutionObservedGroupExpression = "auth_index"

// loadModelSubstitutionGroupAggregates 按账号 x 模型聚合窗口内的请求数、替换数与状态检查分母。
// 只读 api_group_key = 业务值（探测数据在另一分组，天然不会进到这里）。
func loadModelSubstitutionGroupAggregates(ctx context.Context, db *gorm.DB, window ModelSubstitutionWindow) (map[modelSubstitutionGroupKey]modelSubstitutionGroupAggregate, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	coarseStart := timeutil.FormatStorageTime(window.Start.Add(-24 * time.Hour))
	coarseEnd := timeutil.FormatStorageTime(window.End.Add(24 * time.Hour))
	epochExpression := "CAST(strftime('%s', timestamp) AS INTEGER)"
	stateCheckObservedCase := fmt.Sprintf("TRIM(state_check) <> '' AND TRIM(state_check) <> '%s'", stateCheckNoStateCode)
	stateCheckFailedCase := fmt.Sprintf("%s AND TRIM(state_check) <> '%s'", stateCheckObservedCase, stateCheckOKCode)
	// 替换率的分母只算带上游模型信息的行，与 IsUpstreamModelMatch 同口径：
	// 没有 upstream_model 的请求既不算一致也不算替换。
	mismatchedCase := fmt.Sprintf("TRIM(upstream_model) <> '' AND TRIM(upstream_model) <> TRIM(model)")
	query := fmt.Sprintf(`SELECT
	TRIM(auth_index) AS account_entry_id,
	model AS requested_model,
	COUNT(*) AS request_count,
	SUM(CASE WHEN %s THEN 1 ELSE 0 END) AS mismatched,
	SUM(CASE WHEN %s THEN 1 ELSE 0 END) AS state_check_observed,
	SUM(CASE WHEN %s THEN 1 ELSE 0 END) AS state_check_failed
FROM usage_events
WHERE TRIM(model) <> '' AND timestamp >= ? AND timestamp < ? AND %s >= ? AND %s < ?
GROUP BY account_entry_id, requested_model`, mismatchedCase, stateCheckObservedCase, stateCheckFailedCase, epochExpression, epochExpression)

	rows, err := db.WithContext(ctx).Raw(query, coarseStart, coarseEnd, window.Start.Unix(), window.End.Unix()).Rows()
	if err != nil {
		return nil, fmt.Errorf("load model substitution group aggregates: %w", err)
	}
	defer rows.Close()

	aggregates := make(map[modelSubstitutionGroupKey]modelSubstitutionGroupAggregate)
	for rows.Next() {
		var row struct {
			AccountEntryID     string `gorm:"column:account_entry_id"`
			RequestedModel     string `gorm:"column:requested_model"`
			RequestCount       int64  `gorm:"column:request_count"`
			Mismatched         int64  `gorm:"column:mismatched"`
			StateCheckObserved int64  `gorm:"column:state_check_observed"`
			StateCheckFailed   int64  `gorm:"column:state_check_failed"`
		}
		if err := db.ScanRows(rows, &row); err != nil {
			return nil, fmt.Errorf("scan model substitution group aggregate: %w", err)
		}
		key := modelSubstitutionGroupKey{account: row.AccountEntryID, model: strings.TrimSpace(row.RequestedModel)}
		aggregates[key] = modelSubstitutionGroupAggregate{
			RequestCount:       row.RequestCount,
			Mismatched:         row.Mismatched,
			StateCheckObserved: row.StateCheckObserved,
			StateCheckFailed:   row.StateCheckFailed,
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate model substitution group aggregates: %w", err)
	}
	return aggregates, nil
}

// loadProbeGroupAggregates 按账号 x 模型聚合主动探测执行统计。
//
// 只读 api_group_key = "codex-probe"：这就是探测与业务数据的隔离点，业务聚合拿的是
// 另一个分组，两者不会互相污染。
func loadProbeGroupAggregates(ctx context.Context, db *gorm.DB, window ModelSubstitutionWindow) (map[modelSubstitutionGroupKey]probeGroupAggregate, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	coarseStart := timeutil.FormatStorageTime(window.Start.Add(-24 * time.Hour))
	coarseEnd := timeutil.FormatStorageTime(window.End.Add(24 * time.Hour))
	epochExpression := "CAST(strftime('%s', timestamp) AS INTEGER)"
	stateCheckObservedCase := fmt.Sprintf("TRIM(state_check) <> '' AND TRIM(state_check) <> '%s'", stateCheckNoStateCode)
	stateCheckFailedCase := fmt.Sprintf("%s AND TRIM(state_check) <> '%s'", stateCheckObservedCase, stateCheckOKCode)
	query := fmt.Sprintf(`SELECT
	TRIM(auth_index) AS account_entry_id,
	model AS requested_model,
	COUNT(*) AS probe_attempts,
	SUM(CASE WHEN %s THEN 1 ELSE 0 END) AS probe_rejected,
	SUM(CASE WHEN TRIM(error_code) = '%s' THEN 1 ELSE 0 END) AS probe_timeouts
FROM usage_events
WHERE api_group_key = ? AND TRIM(model) <> ''
	AND timestamp >= ? AND timestamp < ? AND %s >= ? AND %s < ?
GROUP BY account_entry_id, requested_model`, stateCheckFailedCase, probeTimeoutCode, epochExpression, epochExpression)

	rows, err := db.WithContext(ctx).Raw(query, probeAPIGroupKey, coarseStart, coarseEnd, window.Start.Unix(), window.End.Unix()).Rows()
	if err != nil {
		return nil, fmt.Errorf("load probe group aggregates: %w", err)
	}
	defer rows.Close()

	aggregates := make(map[modelSubstitutionGroupKey]probeGroupAggregate)
	for rows.Next() {
		var row struct {
			AccountEntryID string `gorm:"column:account_entry_id"`
			RequestedModel string `gorm:"column:requested_model"`
			ProbeAttempts  int64  `gorm:"column:probe_attempts"`
			ProbeRejected  int64  `gorm:"column:probe_rejected"`
			ProbeTimeouts  int64  `gorm:"column:probe_timeouts"`
		}
		if err := db.ScanRows(rows, &row); err != nil {
			return nil, fmt.Errorf("scan probe group aggregate: %w", err)
		}
		key := modelSubstitutionGroupKey{account: row.AccountEntryID, model: strings.TrimSpace(row.RequestedModel)}
		// 成功 = 尝试 - 已观测且非 ok（no_state 与未上报都不算失败，与状态检查口径同源）。
		attempts := row.ProbeAttempts
		rejected := row.ProbeRejected
		if rejected > attempts {
			rejected = attempts
		}
		aggregates[key] = probeGroupAggregate{
			ProbeAttempts: attempts,
			ProbeAccepted: attempts - rejected,
			ProbeRejected: rejected,
			ProbeTimeouts: row.ProbeTimeouts,
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate probe group aggregates: %w", err)
	}
	return aggregates, nil
}

// CodexProxyProbeAPIGroupKey 是主动探测事件在 usage_events.api_group_key 中的独立分组。
//
// 这是探测与业务数据的隔离机制：所有既有聚合查询都按 api_group_key 过滤，业务统计拿的
// 是业务分组，因此探测数据天然被排除，不需要改动任何一处查询。source 两者都是
// codex-proxy，因为探测确实也是这个 producer 产出的。
const probeAPIGroupKey = CodexProxyProbeAPIGroupKey

// probeTimeoutCode 是 proxy 为“采集超时”定义的独立结果码；与 transport_error 区分开，
// 否则超时会被当成普通网络失败，用户无法从表格里看出到底是超时还是连不上。
const probeTimeoutCode = "probe_timeout"

// loadCodexProxyAccountNames 解析账号显示名：别名（用户设置）优先，其次邮箱，最后留空
// 由展示层回退到 id 前缀。绝不在这里编造一个名字。
func loadCodexProxyAccountNames(ctx context.Context, db *gorm.DB, authIndexes []string) (map[string]string, error) {
	names := make(map[string]string, len(authIndexes))
	if len(authIndexes) == 0 {
		return names, nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	for start := 0; start < len(authIndexes); start += analysisIdentityLookupBatchSize {
		end := min(start+analysisIdentityLookupBatchSize, len(authIndexes))
		var identities []entities.UsageIdentity
		if err := db.WithContext(ctx).Where("identity IN ? AND auth_type = ? AND is_deleted = ?", authIndexes[start:end], entities.UsageIdentityAuthTypeCodexProxy, false).Find(&identities).Error; err != nil {
			return nil, fmt.Errorf("load codex proxy account names: %w", err)
		}
		for _, identity := range identities {
			name := strings.TrimSpace(helper.UsageIdentityDisplayName(identity))
			// 显示名与 id 相同时不算有意义的名字，留空让展示层用它自己的短前缀。
			if name == "" || name == identity.Identity {
				continue
			}
			names[identity.Identity] = name
		}
	}
	return names, nil
}

// modelSubstitutionBucketKeys 把桶起点映射成 SQL 分组键，必须与 modelSubstitutionBucketExpression 一致。
func modelSubstitutionBucketKeys(window ModelSubstitutionWindow) map[string]int {
	keys := make(map[string]int, len(window.BucketStarts))
	for index, start := range window.BucketStarts {
		keys[modelSubstitutionBucketKey(start, window.BucketSeconds)] = index
	}
	return keys
}

// modelSubstitutionBucketKey 整分/整时桶用 epoch 秒 flooring，自然日桶用本地日期。
// storageTime 文本前缀就是项目时区的日期，与 format 结果同构。
func modelSubstitutionBucketKey(bucketStart time.Time, bucketSeconds int64) string {
	if bucketSeconds >= 24*3600 {
		return bucketStart.Format("2006-01-02")
	}
	return strconv.FormatInt(bucketStart.Unix()/bucketSeconds, 10)
}

// modelSubstitutionBucketExpression 与 modelSubstitutionBucketKey 必须产生同一套键。
func modelSubstitutionBucketExpression(bucketSeconds int64) string {
	if bucketSeconds >= 24*3600 {
		return "substr(timestamp, 1, 10)"
	}
	return fmt.Sprintf("CAST(CAST(strftime('%%s', timestamp) AS INTEGER) / %d AS TEXT)", bucketSeconds)
}

type modelSubstitutionLoadRow struct {
	RequestedModel     string `gorm:"column:requested_model"`
	UpstreamModel      string `gorm:"column:upstream_model"`
	BucketKey          string `gorm:"column:bucket_key"`
	RequestCount       int64  `gorm:"column:request_count"`
	StateCheckObserved int64  `gorm:"column:state_check_observed"`
	StateCheckFailed   int64  `gorm:"column:state_check_failed"`
}

// loadModelSubstitutionRows 一次查询完成 triple 分组，行数受“模型对数 x 桶数”约束。
func loadModelSubstitutionRows(ctx context.Context, db *gorm.DB, window ModelSubstitutionWindow) ([]modelSubstitutionLoadRow, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	// storageTime 带项目本地 offset，DST 回拨时文本顺序不等于 instant 顺序：
	// 外层按文本用 timestamp 索引取宽范围，再用 epoch 精确复核真实 instant。
	coarseStart := timeutil.FormatStorageTime(window.Start.Add(-24 * time.Hour))
	coarseEnd := timeutil.FormatStorageTime(window.End.Add(24 * time.Hour))
	epochExpression := "CAST(strftime('%s', timestamp) AS INTEGER)"
	// 判定码字面量来自 Go 侧常量，保证 SQL 与 IsStateCheckObserved/IsStateCheckFailure 同源。
	stateCheckObservedCase := fmt.Sprintf("TRIM(state_check) <> '' AND TRIM(state_check) <> '%s'", stateCheckNoStateCode)
	stateCheckFailedCase := fmt.Sprintf("%s AND TRIM(state_check) <> '%s'", stateCheckObservedCase, stateCheckOKCode)
	query := fmt.Sprintf(`SELECT
	model AS requested_model,
	upstream_model AS upstream_model,
	%s AS bucket_key,
	COUNT(*) AS request_count,
	SUM(CASE WHEN %s THEN 1 ELSE 0 END) AS state_check_observed,
	SUM(CASE WHEN %s THEN 1 ELSE 0 END) AS state_check_failed
FROM usage_events
WHERE timestamp >= ? AND timestamp < ? AND %s >= ? AND %s < ?
GROUP BY requested_model, upstream_model, bucket_key`,
		modelSubstitutionBucketExpression(window.BucketSeconds), stateCheckObservedCase, stateCheckFailedCase, epochExpression, epochExpression)

	rows, err := db.WithContext(ctx).Raw(query, coarseStart, coarseEnd, window.Start.Unix(), window.End.Unix()).Rows()
	if err != nil {
		return nil, fmt.Errorf("load model substitution rows: %w", err)
	}
	defer rows.Close()

	loaded := make([]modelSubstitutionLoadRow, 0)
	for rows.Next() {
		var row modelSubstitutionLoadRow
		if err := db.ScanRows(rows, &row); err != nil {
			return nil, fmt.Errorf("scan model substitution row: %w", err)
		}
		loaded = append(loaded, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate model substitution rows: %w", err)
	}
	return loaded, nil
}

// buildModelSubstitutionMatrix 按样本量降序输出矩阵并计算占比，超出上限时截断。
func buildModelSubstitutionMatrix(cellCounts map[modelSubstitutionCellKey]int64, modelMatch map[string]UpstreamModelMatchStats) ([]ModelSubstitutionCell, bool) {
	cells := make([]ModelSubstitutionCell, 0, len(cellCounts))
	for key, count := range cellCounts {
		cell := ModelSubstitutionCell{
			RequestedModel: key.requested,
			UpstreamModel:  key.upstream,
			Count:          count,
			Matched:        IsUpstreamModelMatch(key.requested, key.upstream),
		}
		if total := modelMatch[key.requested].Total; total > 0 {
			cell.Share = float64(count) / float64(total)
		}
		cells = append(cells, cell)
	}
	sort.Slice(cells, func(i, j int) bool {
		if cells[i].Count != cells[j].Count {
			return cells[i].Count > cells[j].Count
		}
		if cells[i].RequestedModel != cells[j].RequestedModel {
			return cells[i].RequestedModel < cells[j].RequestedModel
		}
		return cells[i].UpstreamModel < cells[j].UpstreamModel
	})
	truncated := false
	if len(cells) > modelSubstitutionMatrixCellLimit {
		cells = cells[:modelSubstitutionMatrixCellLimit]
		truncated = true
	}
	return cells, truncated
}

func buildModelSubstitutionModelStats(modelMatch map[string]UpstreamModelMatchStats) ([]ModelSubstitutionModelStats, bool) {
	stats := make([]ModelSubstitutionModelStats, 0, len(modelMatch))
	for model, match := range modelMatch {
		stats = append(stats, ModelSubstitutionModelStats{RequestedModel: model, Match: match})
	}
	sort.Slice(stats, func(i, j int) bool {
		if stats[i].Match.Total != stats[j].Match.Total {
			return stats[i].Match.Total > stats[j].Match.Total
		}
		return stats[i].RequestedModel < stats[j].RequestedModel
	})
	truncated := false
	if len(stats) > modelSubstitutionRequestedModelLimit {
		stats = stats[:modelSubstitutionRequestedModelLimit]
		truncated = true
	}
	return stats, truncated
}

// topModelSubstitution 从矩阵里取样本量最大的替换组合；没有替换时返回 nil，由调用方渲染“无”。
func topModelSubstitution(cells []ModelSubstitutionCell) *ModelSubstitutionTopSubstitution {
	for _, cell := range cells {
		if cell.Matched {
			continue
		}
		return &ModelSubstitutionTopSubstitution{From: cell.RequestedModel, To: cell.UpstreamModel, Count: cell.Count}
	}
	return nil
}
