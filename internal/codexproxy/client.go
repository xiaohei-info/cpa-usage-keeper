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
	After      int64   `json:"after"`
	NextCursor int64   `json:"next_cursor"`
	HasMore    bool    `json:"has_more"`
	CursorGap  bool    `json:"cursor_gap"`
	Events     []Event `json:"events"`
}

const AccountMetadataSchema = "codex-proxy.keeper-account-metadata.v1"

type AccountMetadata struct {
	AccountEntryID string     `json:"account_entry_id"`
	Email          string     `json:"email"`
	Label          string     `json:"label"`
	AccountID      string     `json:"account_id"`
	OrganizationID string     `json:"organization_id"`
	UserID         string     `json:"user_id"`
	PlanType       string     `json:"plan_type"`
	Status         string     `json:"status"`
	AddedAt        time.Time  `json:"added_at"`
	ExpiresAt      *time.Time `json:"expires_at"`
}

type AccountsPage struct {
	Schema   string            `json:"schema"`
	Accounts []AccountMetadata `json:"accounts"`
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
func (c *Client) Accounts(ctx context.Context) ([]AccountMetadata, error) {
	if c == nil || c.baseURL == "" {
		return nil, fmt.Errorf("codex proxy base URL is required")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/admin/integration/keeper/accounts", nil)
	if err != nil {
		return nil, err
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("codex proxy accounts returned status %d", resp.StatusCode)
	}
	var page AccountsPage
	if err := json.NewDecoder(resp.Body).Decode(&page); err != nil {
		return nil, fmt.Errorf("decode codex proxy accounts: %w", err)
	}
	if page.Schema != AccountMetadataSchema {
		return nil, fmt.Errorf("unsupported codex proxy account schema %q", page.Schema)
	}
	for _, account := range page.Accounts {
		if strings.TrimSpace(account.AccountEntryID) == "" {
			return nil, fmt.Errorf("codex proxy account requires account_entry_id")
		}
	}
	return page.Accounts, nil
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
	if page.Schema != "codex-proxy.keeper-event.v1" {
		return Page{}, fmt.Errorf("unsupported codex proxy event schema %q", page.Schema)
	}
	if page.After != after {
		return Page{}, fmt.Errorf("codex proxy page cursor mismatch: requested %d, got %d", after, page.After)
	}
	for _, event := range page.Events {
		if event.Schema != "codex-proxy.keeper-event.v1" {
			return Page{}, fmt.Errorf("unsupported event schema %q", event.Schema)
		}
		if event.EventType != "request.completed" && event.EventType != "request.failed" {
			return Page{}, fmt.Errorf("unsupported codex proxy event type %q", event.EventType)
		}
		if (event.EventType == "request.failed") != event.Failed {
			return Page{}, fmt.Errorf("codex proxy event type %q is inconsistent with failed=%t", event.EventType, event.Failed)
		}
		if event.EventID == "" || event.RequestID == "" {
			return Page{}, fmt.Errorf("codex proxy event requires event_id and request_id")
		}
	}
	if len(page.Events) > 0 && page.NextCursor <= after {
		return Page{}, fmt.Errorf("codex proxy page made no cursor progress: %d -> %d", after, page.NextCursor)
	}
	if page.NextCursor < after {
		return Page{}, fmt.Errorf("codex proxy cursor moved backwards: %d -> %d", after, page.NextCursor)
	}
	return page, nil
}
