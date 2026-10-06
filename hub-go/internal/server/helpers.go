package server

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// bad writes a 400 in the TS hub's error shape: {"error":"bad_request","detail":msg}.
func bad(w http.ResponseWriter, msg string) {
	writeErr(w, http.StatusBadRequest, "bad_request", msg)
}

func badf(w http.ResponseWriter, format string, args ...any) {
	bad(w, fmt.Sprintf(format, args...))
}

// writeErr writes {"error":code,"detail":msg} with the given status, matching
// the error responses of cloudflare-hub.
func writeErr(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": code, "detail": msg})
}

// decodeBody parses the request body as a JSON object. Like the TS handlers
// (c.req.json().catch(() => null)), a parse failure yields a nil map and no error.
func decodeBody(r *http.Request) (map[string]any, error) {
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		return nil, err
	}
	return body, nil
}

// queryPtr returns a pointer to the query parameter value, or nil when absent
// (TS uses null for missing from/to, which serializes to JSON null).
func queryPtr(r *http.Request, name string) *string {
	if v, ok := r.URL.Query()[name]; ok && len(v) > 0 {
		return &v[0]
	}
	return nil
}

// tsfmt renders a decoded JSON value the way a JS template literal would,
// for reproducing TS validation messages like `bad provider: ${r.provider}`.
func tsfmt(v any) string {
	switch t := v.(type) {
	case nil:
		return "undefined"
	case string:
		return t
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(t)
	default:
		return fmt.Sprint(v)
	}
}

// numOrZero mirrors the TS num() helper: finite numbers >= 0 pass through,
// everything else becomes 0.
func numOrZero(v any) float64 {
	f, ok := v.(float64)
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) || f < 0 {
		return 0
	}
	return f
}

// numOrNil mirrors TS Number(v) for nullable numeric fields: null stays nil,
// numbers pass through, strings are coerced, anything else becomes nil (Go has
// no NaN to bind; the TS side would fail the D1 bind for uncoercible values).
func numOrNil(v any) *float64 {
	switch t := v.(type) {
	case nil:
		return nil
	case float64:
		if math.IsNaN(t) || math.IsInf(t, 0) {
			return nil
		}
		return &t
	case string:
		if f, err := strconv.ParseFloat(strings.TrimSpace(t), 64); err == nil {
			return &f
		}
		return nil
	case bool:
		f := 0.0
		if t {
			f = 1
		}
		return &f
	default:
		return nil
	}
}

// strOrNil mirrors TS `v == null ? null : String(v)` for nullable text fields.
func strOrNil(v any) *string {
	if v == nil {
		return nil
	}
	s := tsfmt(v)
	return &s
}

// trim50 truncates s to 50 bytes, matching the TS .slice(0, 50) on account and
// credential names (ASCII in practice; TS slices by UTF-16 code unit).
func trim50(s string) string {
	if len(s) > 50 {
		return s[:50]
	}
	return s
}

// longestStringValue extracts the longest string value of a decoded JSON
// object, mirroring crypto.ts extractSecret (stable sort, like JS).
func longestStringValue(m map[string]any) string {
	vals := make([]string, 0, len(m))
	for _, v := range m {
		if s, ok := v.(string); ok {
			vals = append(vals, s)
		}
	}
	if len(vals) == 0 {
		return ""
	}
	sort.SliceStable(vals, func(i, j int) bool { return len(vals[i]) > len(vals[j]) })
	return vals[0]
}

// credentialHintValue mirrors crypto.ts credentialHint: the payload string
// itself for string payloads, the longest string value for objects (falling
// back to the JSON text when there are no string values), last 4 characters
// prefixed with "...".
func credentialHintValue(payload any) string {
	var secret string
	switch t := payload.(type) {
	case string:
		secret = t
	case map[string]any:
		secret = longestStringValue(t)
		if secret == "" {
			if b, err := json.Marshal(t); err == nil {
				secret = string(b)
			}
		}
	default:
		if b, err := json.Marshal(payload); err == nil {
			secret = string(b)
		}
	}
	if len(secret) > 4 {
		secret = secret[len(secret)-4:]
	}
	return "..." + secret
}

var httpURLRe = regexp.MustCompile(`^https?://`)
