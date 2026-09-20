package api

import (
	"context"
	"net/http"
	"strings"
	"time"

	"cpa-usage-keeper/internal/repository"
	"github.com/gin-gonic/gin"
)

// ModelSubstitutionProvider 是模型替换观测接口的只读聚合来源。
type ModelSubstitutionProvider interface {
	ModelSubstitution(context.Context, string, time.Time) (repository.ModelSubstitutionSnapshot, error)
}

type modelSubstitutionResponse struct {
	Schema        string                          `json:"schema"`
	Range         string                          `json:"range"`
	WindowStart   time.Time                       `json:"window_start"`
	WindowEnd     time.Time                       `json:"window_end"`
	BucketSeconds int64                           `json:"bucket_seconds"`
	Summary       modelSubstitutionSummary        `json:"summary"`
	Series        []modelSubstitutionPoint        `json:"series"`
	Matrix        []modelSubstitutionMatrixRow    `json:"matrix"`
	Substitutions []modelSubstitutionRequestedRow `json:"substitutions"`
	// Truncated 表示矩阵单元格命中上限被截断，前端据此提示样本不完整。
	Truncated bool `json:"truncated"`
}

type modelSubstitutionSummary struct {
	RequestsWithModel int64 `json:"requests_with_model"`
	Matched           int64 `json:"matched"`
	Mismatched        int64 `json:"mismatched"`
	// MatchRate 是 0-100 的百分比；没有带模型信息的样本时为 null，绝不降级为 0%。
	MatchRate *float64 `json:"match_rate"`
	// Empty 显式声明窗口内没有任何带模型信息的请求，避免空数据被读成“全部一致”。
	Empty           bool                      `json:"empty"`
	TopSubstitution *modelSubstitutionTopPair `json:"top_substitution"`
}

type modelSubstitutionTopPair struct {
	From  string `json:"from"`
	To    string `json:"to"`
	Count int64  `json:"count"`
}

type modelSubstitutionPoint struct {
	BucketStart       time.Time `json:"bucket_start"`
	RequestsWithModel int64     `json:"requests_with_model"`
	Mismatched        int64     `json:"mismatched"`
	MatchRate         *float64  `json:"match_rate"`
	// 状态检查失败率与一致率共用同一批桶，但分母是该桶内已上报 state_check 的事件。
	StateCheckObserved    int64    `json:"state_check_observed"`
	StateCheckFailed      int64    `json:"state_check_failed"`
	StateCheckFailureRate *float64 `json:"state_check_failure_rate"`
}

type modelSubstitutionMatrixRow struct {
	RequestedModel string  `json:"requested_model"`
	UpstreamModel  string  `json:"upstream_model"`
	Count          int64   `json:"count"`
	Share          float64 `json:"share"`
	Matched        bool    `json:"matched"`
}

type modelSubstitutionRequestedRow struct {
	RequestedModel    string   `json:"requested_model"`
	RequestsWithModel int64    `json:"requests_with_model"`
	Mismatched        int64    `json:"mismatched"`
	MatchRate         *float64 `json:"match_rate"`
}

// registerModelSubstitutionRoute 挂在 admin group 下；只读，不接受任何变更方法。
func registerModelSubstitutionRoute(router gin.IRoutes, provider ModelSubstitutionProvider) {
	router.GET("/turn-state/model-mismatch", func(c *gin.Context) {
		setNoStoreHeaders(c)
		requestedRange := strings.TrimSpace(c.Query("range"))
		if provider == nil {
			window, err := repository.ParseModelSubstitutionWindow(requestedRange, time.Now())
			if err != nil {
				writeInternalError(c, "build model substitution window failed", err)
				return
			}
			// provider 未配置时仍返回合法空快照，前端无需区分“未配置”和“暂无数据”。
			c.JSON(http.StatusOK, buildModelSubstitutionResponse(repository.EmptyModelSubstitutionSnapshot(window)))
			return
		}
		snapshot, err := provider.ModelSubstitution(c.Request.Context(), requestedRange, time.Now())
		if err != nil {
			writeInternalError(c, "get model substitution snapshot failed", err)
			return
		}
		c.JSON(http.StatusOK, buildModelSubstitutionResponse(snapshot))
	})
}

func buildModelSubstitutionResponse(snapshot repository.ModelSubstitutionSnapshot) modelSubstitutionResponse {
	summary := snapshot.Summary
	response := modelSubstitutionResponse{
		Schema:        repository.ModelSubstitutionSchema,
		Range:         snapshot.Window.Range,
		WindowStart:   snapshot.Window.Start,
		WindowEnd:     snapshot.Window.End,
		BucketSeconds: snapshot.Window.BucketSeconds,
		Summary: modelSubstitutionSummary{
			RequestsWithModel: summary.Total,
			Matched:           summary.Matched,
			Mismatched:        summary.MismatchCount(),
			MatchRate:         modelSubstitutionRate(summary.Matched, summary.Total),
			Empty:             summary.Total == 0,
		},
		Series:        make([]modelSubstitutionPoint, 0, len(snapshot.Buckets)),
		Matrix:        make([]modelSubstitutionMatrixRow, 0, len(snapshot.Matrix)),
		Substitutions: make([]modelSubstitutionRequestedRow, 0, len(snapshot.Models)),
		Truncated:     snapshot.Truncated,
	}
	if snapshot.Top != nil && snapshot.Top.Count > 0 {
		response.Summary.TopSubstitution = &modelSubstitutionTopPair{
			From:  snapshot.Top.From,
			To:    snapshot.Top.To,
			Count: snapshot.Top.Count,
		}
	}
	for _, bucket := range snapshot.Buckets {
		response.Series = append(response.Series, modelSubstitutionPoint{
			BucketStart:           bucket.Start,
			RequestsWithModel:     bucket.Match.Total,
			Mismatched:            bucket.Match.MismatchCount(),
			MatchRate:             modelSubstitutionRate(bucket.Match.Matched, bucket.Match.Total),
			StateCheckObserved:    bucket.StateCheckObserved,
			StateCheckFailed:      bucket.StateCheckFailed,
			StateCheckFailureRate: modelSubstitutionRate(bucket.StateCheckFailed, bucket.StateCheckObserved),
		})
	}
	for _, cell := range snapshot.Matrix {
		response.Matrix = append(response.Matrix, modelSubstitutionMatrixRow{
			RequestedModel: cell.RequestedModel,
			UpstreamModel:  cell.UpstreamModel,
			Count:          cell.Count,
			Share:          cell.Share,
			Matched:        cell.Matched,
		})
	}
	for _, stats := range snapshot.Models {
		response.Substitutions = append(response.Substitutions, modelSubstitutionRequestedRow{
			RequestedModel:    stats.RequestedModel,
			RequestsWithModel: stats.Match.Total,
			Mismatched:        stats.Match.MismatchCount(),
			MatchRate:         modelSubstitutionRate(stats.Match.Matched, stats.Match.Total),
		})
	}
	return response
}

// modelSubstitutionRate 把计数换算成 0-100 百分比；分母为 0 时返回 nil，由前端渲染不可用。
func modelSubstitutionRate(numerator, denominator int64) *float64 {
	if denominator <= 0 {
		return nil
	}
	rate := float64(numerator) / float64(denominator) * 100
	return &rate
}
