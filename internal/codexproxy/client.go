package codexproxy

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type Usage struct {
	InputTokens     int64 `json:"input_tokens"`
	OutputTokens    int64 `json:"output_tokens"`
	CachedTokens    int64 `json:"cached_tokens"`
	ReasoningTokens int64 `json:"reasoning_tokens"`
}
type Event struct {
	Schema         string    `json:"schema"`
	EventID        string    `json:"event_id"`
	EventType      string    `json:"event_type"`
	OccurredAt     time.Time `json:"occurred_at"`
	RequestID      string    `json:"request_id"`
	AttemptID      string    `json:"attempt_id"`
	AccountEntryID string    `json:"account_entry_id"`
	Provider       string    `json:"provider"`
	Endpoint       string    `json:"endpoint"`
	Model          string    `json:"model"`
	StatusCode     *int      `json:"status_code"`
	Failed         bool      `json:"failed"`
	Fallback       bool      `json:"fallback"`
	LatencyMS      *int64    `json:"latency_ms"`
	TTFTMS         *int64    `json:"ttft_ms"`
	Usage          *Usage    `json:"usage"`
	ErrorCode      string    `json:"error_code"`
	ErrorMessage   string    `json:"error_message"`
}
type Page struct {
	Schema     string  `json:"schema"`
	Cursor     int64   `json:"cursor"`
	NextCursor int64   `json:"next_cursor"`
	HasMore    bool    `json:"has_more"`
	CursorGap  bool    `json:"cursor_gap"`
	Events     []Event `json:"events"`
}
type Client struct {
	baseURL, token string
	httpClient     *http.Client
}

func NewClient(baseURL, token string, timeout time.Duration) *Client {
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	return &Client{baseURL: strings.TrimRight(strings.TrimSpace(baseURL), "/"), token: strings.TrimSpace(token), httpClient: &http.Client{Timeout: timeout}}
}
func (c *Client) Pull(ctx context.Context, after int64, limit int) (Page, error) {
	if c == nil || c.baseURL == "" {
		return Page{}, fmt.Errorf("codex proxy base URL is required")
	}
	if limit < 1 || limit > 500 {
		return Page{}, fmt.Errorf("limit must be between 1 and 500")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/admin/integration/keeper/events?after="+strconv.FormatInt(after, 10)+"&limit="+strconv.Itoa(limit), nil)
	if err != nil {
		return Page{}, err
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return Page{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return Page{}, fmt.Errorf("codex proxy returned status %d", resp.StatusCode)
	}
	var page Page
	if err = json.NewDecoder(resp.Body).Decode(&page); err != nil {
		return Page{}, fmt.Errorf("decode codex proxy events: %w", err)
	}
	if page.Schema != "codex-proxy.keeper-events.v1" {
		return Page{}, fmt.Errorf("unsupported codex proxy event schema %q", page.Schema)
	}
	return page, nil
}
