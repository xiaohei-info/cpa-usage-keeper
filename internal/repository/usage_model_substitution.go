package repository

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

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

// ModelSubstitutionSnapshot 是模型替换观测接口的完整有界快照。
type ModelSubstitutionSnapshot struct {
	Window ModelSubstitutionWindow
	// Summary.Total 是有 upstream_model 的事件数；为 0 表示窗口内没有可用样本。
	Summary UpstreamModelMatchStats
	Buckets []ModelSubstitutionBucket
	Matrix  []ModelSubstitutionCell
	Models  []ModelSubstitutionModelStats
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
	return ModelSubstitutionSnapshot{Window: window, Buckets: buckets, Matrix: []ModelSubstitutionCell{}, Models: []ModelSubstitutionModelStats{}}
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
	return snapshot, nil
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
