package api

import (
	"context"
	"cpa-usage-keeper/internal/codexproxy"
	"github.com/gin-gonic/gin"
	"net/http"
)

type TurnStateProvider interface {
	TurnStateOverview(context.Context) (*codexproxy.TurnStateOverview, error)
}

func registerTurnStateRoutes(group *gin.RouterGroup, provider TurnStateProvider) {
	group.GET("/turn-state/overview", func(c *gin.Context) {
		c.Header("Cache-Control", "no-store")
		if provider != nil {
			snapshot, err := provider.TurnStateOverview(c.Request.Context())
			if err == nil && snapshot != nil {
				c.JSON(http.StatusOK, snapshot)
				return
			}
		}
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "turn_state_unavailable"})
	})
}
