package codexproxy

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"reflect"
	"regexp"
	"strings"
	"time"
)

const TurnStateSchema = "codex-proxy.turn-state-overview.v1"

var errTurnStateUnavailable = errors.New("turn-state overview unavailable")
var turnStateCode = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)
var turnStateFingerprint = regexp.MustCompile(`^[a-f0-9]{8,32}$`)

// Validate every required field before decoding; pointers represent explicit unknowns,
// not missing fields. Only typed whitelist fields are returned to Keeper callers.
func validateTurnState(raw json.RawMessage, typ reflect.Type, field string) bool {
	if typ.Kind() == reflect.Pointer {
		if string(raw) == "null" {
			return true
		}
		return validateTurnState(raw, typ.Elem(), field)
	}
	if string(raw) == "null" {
		return false
	}
	switch typ.Kind() {
	case reflect.Struct:
		var obj map[string]json.RawMessage
		if json.Unmarshal(raw, &obj) != nil {
			return false
		}
		for i := 0; i < typ.NumField(); i++ {
			f := typ.Field(i)
			tag := f.Tag.Get("json")
			key, optional := tag, false
			// `,omitempty` marks an additive contract field: an older producer may
			// omit it entirely, but a present value must still validate.
			if idx := strings.Index(tag, ","); idx >= 0 {
				key = tag[:idx]
				for _, opt := range strings.Split(tag[idx+1:], ",") {
					if opt == "omitempty" {
						optional = true
					}
				}
			}
			value, ok := obj[key]
			if !ok {
				if optional {
					continue
				}
				return false
			}
			if !validateTurnState(value, f.Type, key) {
				return false
			}
		}
	case reflect.Slice:
		var a []json.RawMessage
		if json.Unmarshal(raw, &a) != nil || a == nil {
			return false
		}
		limit := 1000
		if field == "events" {
			limit = 200
		}
		if len(a) > limit {
			return false
		}
		for _, v := range a {
			if !validateTurnState(v, typ.Elem(), field) {
				return false
			}
		}
	case reflect.String:
		var s string
		if json.Unmarshal(raw, &s) != nil || len(s) > 256 || strings.ContainsAny(s, "\r\n\x00") {
			return false
		}
		switch field {
		case "schema":
			return s == TurnStateSchema
		case "mode":
			return s == "off" || s == "observe" || s == "replace" || s == "always"
		case "fallback":
			return s == "passthrough" || s == "strict"
		case "source":
			return s == "passive" || s == "active" || s == "injection" || s == "lifecycle" || s == "ticket"
		case "account_mode":
			return s == "auto" || s == "personal" || s == "team"
		case "phase", "diagnostic", "action", "result", "verdict", "code", "last_result":
			return turnStateCode.MatchString(s)
		case "plan_provenance":
			return s == "account" || s == "override" || s == "assumed_personal"
		case "fingerprint":
			return turnStateFingerprint.MatchString(s)
		case "server_time", "at", "issued_at", "expires_at", "last_observed_at", "last_injected_at", "next_probe_at":
			_, err := time.Parse(time.RFC3339Nano, s)
			return err == nil && strings.HasSuffix(s, "Z")
		default:
			return s != "" || field == "account_label"
		}
	case reflect.Int64:
		var n int64
		return json.Unmarshal(raw, &n) == nil && n >= 0 && n <= 9007199254740991
	case reflect.Bool:
		var b bool
		return json.Unmarshal(raw, &b) == nil
	default:
		return false
	}
	return true
}

func (c *Client) TurnStateOverview(ctx context.Context) (*TurnStateOverview, error) {
	if c == nil || c.baseURL == "" {
		return nil, errTurnStateUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/admin/integration/keeper/turn-state/overview", nil)
	if err != nil {
		return nil, errTurnStateUnavailable
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, errTurnStateUnavailable
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, errTurnStateUnavailable
	}
	const maxBytes = 2 << 20
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxBytes+1))
	if err != nil || len(data) > maxBytes || !validateTurnState(data, reflect.TypeOf(TurnStateOverview{}), "") {
		return nil, errTurnStateUnavailable
	}
	var result TurnStateOverview
	if json.Unmarshal(data, &result) != nil {
		return nil, errTurnStateUnavailable
	}
	return &result, nil
}
