package codexproxy

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"cpa-usage-keeper/internal/cpa"
)

// RequestLogPreviewMaxBytes mirrors the CPA preview cap so the Keeper request
// log UI applies identical size semantics for both sources.
const RequestLogPreviewMaxBytes int64 = cpa.RequestLogPreviewMaxBytes

// FetchRequestLogByID reads the archived request log for one request id.
// Keeper's request-log service treats a 404 as "not available" rather than an
// error, so the status code is always returned alongside any error.
func (c *Client) FetchRequestLogByID(ctx context.Context, requestID string) (*cpa.RequestLogResult, error) {
	return c.fetchRequestLogByID(ctx, requestID, RequestLogPreviewMaxBytes)
}

// OpenRequestLogByID streams the archived request log for download.
func (c *Client) OpenRequestLogByID(ctx context.Context, requestID string) (*cpa.RequestLogStream, error) {
	return c.openRequestLogByID(ctx, requestID)
}

func (c *Client) newRequestLogRequest(ctx context.Context, requestID string) (*http.Request, error) {
	if c == nil || c.baseURL == "" {
		return nil, fmt.Errorf("codex proxy base URL is required")
	}
	trimmed := strings.TrimSpace(requestID)
	if trimmed == "" {
		return nil, fmt.Errorf("request id is required")
	}
	path := "/admin/integration/keeper/request-log/" + url.PathEscape(trimmed)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+path, nil)
	if err != nil {
		return nil, fmt.Errorf("build codex proxy request log request: %w", err)
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	return req, nil
}

func (c *Client) fetchRequestLogByID(ctx context.Context, requestID string, maxBodyBytes int64) (*cpa.RequestLogResult, error) {
	result := &cpa.RequestLogResult{}
	req, err := c.newRequestLogRequest(ctx, requestID)
	if err != nil {
		return result, err
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return result, fmt.Errorf("request codex proxy request log: %w", err)
	}
	defer resp.Body.Close()

	result.StatusCode = resp.StatusCode
	result.ContentType = strings.TrimSpace(resp.Header.Get("Content-Type"))
	result.Filename = filenameFromContentDisposition(resp.Header.Get("Content-Disposition"))
	result.ContentLength = resp.ContentLength

	reader := io.Reader(resp.Body)
	if maxBodyBytes > 0 {
		reader = io.LimitReader(resp.Body, maxBodyBytes+1)
	}
	body, readErr := io.ReadAll(reader)
	if readErr != nil {
		return result, fmt.Errorf("read codex proxy request log response: %w", readErr)
	}
	if maxBodyBytes > 0 && int64(len(body)) > maxBodyBytes {
		result.BodyTruncated = true
		body = body[:maxBodyBytes]
	}
	result.Body = body
	if result.ContentLength < 0 {
		result.ContentLength = int64(len(body))
	}
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return result, fmt.Errorf("codex proxy request log request returned status %d", resp.StatusCode)
	}
	return result, nil
}

func (c *Client) openRequestLogByID(ctx context.Context, requestID string) (*cpa.RequestLogStream, error) {
	req, err := c.newRequestLogRequest(ctx, requestID)
	if err != nil {
		return &cpa.RequestLogStream{}, err
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return &cpa.RequestLogStream{}, fmt.Errorf("request codex proxy request log: %w", err)
	}
	result := &cpa.RequestLogStream{
		StatusCode:    resp.StatusCode,
		Body:          resp.Body,
		Filename:      filenameFromContentDisposition(resp.Header.Get("Content-Disposition")),
		ContentType:   strings.TrimSpace(resp.Header.Get("Content-Type")),
		ContentLength: resp.ContentLength,
	}
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		resp.Body.Close()
		return result, fmt.Errorf("codex proxy request log request returned status %d", resp.StatusCode)
	}
	return result, nil
}

// filenameFromContentDisposition extracts a filename from a Content-Disposition
// header, falling back to an empty string when absent or unparsable.
func filenameFromContentDisposition(value string) string {
	if value == "" {
		return ""
	}
	for _, part := range strings.Split(value, ";") {
		trimmed := strings.TrimSpace(part)
		if !strings.HasPrefix(strings.ToLower(trimmed), "filename=") {
			continue
		}
		name := strings.TrimSpace(trimmed[len("filename="):])
		name = strings.Trim(name, `"`)
		if decoded, err := url.QueryUnescape(name); err == nil {
			name = decoded
		}
		return strings.TrimSpace(name)
	}
	return ""
}
