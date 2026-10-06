// Package runner implements the built-in quota collector adapters, a Go port
// of cloudflare-hub/src/runner/adapters.ts + adapters/. The collector (in the
// server package) feeds decrypted credential fields through Run, which returns
// normalized quota rows (a scrape_error row on total failure, mirroring
// runAdapter).
package runner

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Row is a normalized quota snapshot row, corresponding to the hub's
// quota_snapshots table (and the TS QuotaRow type).
type Row struct {
	Provider   string   `json:"provider"`
	Metric     string   `json:"metric"`
	Account    string   `json:"account,omitempty"` // 凭证名（多 key 场景）
	Value      float64  `json:"value"`
	LimitValue *float64 `json:"limit_value"`
	Unit       *string  `json:"unit"`
	ResetAt    *string  `json:"reset_at"`
}

// Adapter fetches one provider's quota snapshot. cred holds that credential's
// decrypted fields (openai/deepseek/glm/minimax/anyrouter/zai: api_key,
// anyrouter_top: session + api_user, copilot: token, claude: session_key,
// cursor: session, codex: access_token(+account_id), kimi: api_key).
type Adapter interface {
	Provider() string
	Fetch(cred map[string]string) ([]Row, error)
}

var registry = map[string]Adapter{
	"openai":        openaiAdapter{},
	"deepseek":      deepseekAdapter{},
	"glm":           glmAdapter{},
	"copilot":       copilotAdapter{},
	"claude":        claudeAdapter{},
	"cursor":        cursorAdapter{},
	"codex":         codexAdapter{},
	"kimi":          kimiAdapter{},
	"minimax":       minimaxAdapter{},
	"zai":           zaiAdapter{},
	"anyrouter":     anyrouterAdapter{},
	"anyrouter_top": anyrouterTopAdapter{},
}

// Lookup returns the adapter for provider, or nil when unimplemented.
func Lookup(provider string) Adapter { return registry[provider] }

// Providers returns the list of implemented providers.
func Providers() []string {
	out := make([]string, 0, len(registry))
	for p := range registry {
		out = append(out, p)
	}
	sort.Strings(out)
	return out
}

// Run executes a single adapter; a total failure becomes a scrape_error row
// (web 端整卡报红), and a panic is recovered the same way. Partial failures
// should come back as success rows + a scrape_warn row (see the kimi adapter)
// instead of an error.
func Run(provider string, cred map[string]string) (rows []Row) {
	a := registry[provider]
	if a == nil {
		return nil
	}
	defer func() {
		if r := recover(); r != nil {
			rows = []Row{{
				Provider: provider,
				Metric:   "scrape_error",
				Value:    1,
				Unit:     strptr("error"),
				ResetAt:  strptr(truncate(fmt.Sprint(r), 500)),
			}}
		}
	}()
	rows, err := a.Fetch(cred)
	if err != nil {
		return []Row{{
			Provider: provider,
			Metric:   "scrape_error",
			Value:    1,
			Unit:     strptr("error"),
			ResetAt:  strptr(truncate(err.Error(), 500)),
		}}
	}
	return rows
}

// HTTPClient is the shared adapter HTTP client (30s timeout, like the TS fetch).
var HTTPClient = &http.Client{Timeout: 30 * time.Second}

// getJSON issues a GET and decodes the JSON response; a non-2xx status yields
// an error carrying a response-body fragment (helps diagnose WAF blocks).
func getJSON(u string, headers map[string]string, out any) error {
	req, err := http.NewRequest(http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	return doJSON(req, headers, out)
}

// postJSON issues a POST with a JSON body and decodes the JSON response.
func postJSON(u string, headers map[string]string, body any, out any) error {
	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, u, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	if headers == nil {
		headers = map[string]string{}
	}
	headers["Content-Type"] = "application/json"
	return doJSON(req, headers, out)
}

func doJSON(req *http.Request, headers map[string]string, out any) error {
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := HTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("HTTP %d: %s", res.StatusCode, truncate(string(body), 200))
	}
	return json.Unmarshal(body, out)
}

// num loosely parses numbers that may arrive as JSON strings or numbers.
func num(v any) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case string:
		n, _ := strconv.ParseFloat(strings.TrimSpace(t), 64)
		return n
	default:
		return 0
	}
}

// finite mirrors the TS finite helper: nil/empty/non-finite → nil.
func finite(v any) *float64 {
	switch t := v.(type) {
	case nil:
		return nil
	case string:
		if strings.TrimSpace(t) == "" {
			return nil
		}
		n, err := strconv.ParseFloat(strings.TrimSpace(t), 64)
		if err != nil {
			return nil
		}
		return &n
	case float64:
		if mathIsNaNInf(t) {
			return nil
		}
		return &t
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

func mathIsNaNInf(f float64) bool { return math.IsNaN(f) || math.IsInf(f, 0) }

// secureBaseURL mirrors the per-adapter secureBaseURL in the TS adapters: the
// override must be a plain HTTPS URL without credentials, query, or fragment.
func secureBaseURL(provider, raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return "", fmt.Errorf("%s: base_url must be a valid HTTPS URL", provider)
	}
	if u.Scheme != "https" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("%s: base_url must be HTTPS without credentials, query, or fragment", provider)
	}
	return strings.TrimRight(raw, "/"), nil
}

// sanitize mirrors the TS sanitize: non [a-zA-Z0-9_.-] characters become "_",
// truncated to 40 chars (metric-name suffix for multi-model providers).
func sanitize(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_', r == '.', r == '-':
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
	}
	out := b.String()
	if len(out) > 40 {
		out = out[:40]
	}
	return out
}

// unixISO converts unix seconds to an ISO string; nil in → nil out.
func unixISO(ts *float64) *string {
	if ts == nil {
		return nil
	}
	s := time.Unix(int64(*ts), 0).UTC().Format(time.RFC3339)
	return &s
}

// millisISO converts a millisecond-or-second epoch (auto-detected like the TS
// `raw < 1e12 ? raw*1000 : raw`) to an ISO string; nil for non-positive input.
func millisISO(raw any) *string {
	n := finite(raw)
	if n == nil || *n <= 0 {
		return nil
	}
	ms := *n
	if ms < 1_000_000_000_000 {
		ms *= 1000
	}
	s := time.UnixMilli(int64(ms)).UTC().Format(time.RFC3339)
	return &s
}

func strptr(s string) *string { return &s }

func strptrOrNil(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func fptr(f float64) *float64 { return &f }

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
