package runner

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
)

// zaiAdapter: Z.ai / GLM Coding Plan。兼容旧版 quota/limit 与 2026 V3 的 usage 路径，
// 以及 TOKENS_LIMIT、CREDIT_LIMIT、TIME_LIMIT 三种额度形态。
type zaiAdapter struct{}

func (zaiAdapter) Provider() string { return "zai" }

type zaiLimit struct {
	Type          string `json:"type"`
	Unit          any    `json:"unit"`
	Number        any    `json:"number"`
	Usage         any    `json:"usage"`
	CurrentValue  any    `json:"currentValue"`
	Remaining     any    `json:"remaining"`
	Percentage    any    `json:"percentage"`
	NextResetTime any    `json:"nextResetTime"`
}

type zaiEnvelope struct {
	Success *bool    `json:"success"`
	Code    *float64 `json:"code"`
	Msg     string   `json:"msg"`
	Data    *struct {
		Limits []zaiLimit `json:"limits"`
	} `json:"data"`
}

func zaiUsedPercent(item zaiLimit) *float64 {
	if p := finite(item.Percentage); p != nil {
		return fptr(math.Round(math.Max(0, math.Min(100, *p))*10) / 10)
	}
	used, total := finite(item.CurrentValue), finite(item.Usage)
	if used == nil || total == nil || *total <= 0 {
		return nil
	}
	return fptr(math.Round(math.Max(0, math.Min(100, *used / *total * 100))*10) / 10)
}

func zaiMetricFor(item zaiLimit) string {
	if unit := finite(item.Unit); unit != nil {
		switch *unit {
		case 3:
			return "session_used_pct" // 5 小时
		case 6:
			return "weekly_used_pct" // 周
		case 5:
			return "monthly_mcp_used_pct"
		}
	}
	if item.Type == "TIME_LIMIT" {
		return "monthly_mcp_used_pct"
	}
	return ""
}

// fetchZaiEnvelope mirrors the TS fetchEnvelope: raw Authorization header (the
// official glm-plan-usage plugin sends the plain API key, not Bearer), with
// envelope-level success/code checks folded into the error string.
func fetchZaiEnvelope(url, apiKey string) (*zaiEnvelope, error) {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", apiKey)
	req.Header.Set("Accept-Language", "en-US,en")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	res, err := HTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("HTTP %d: %s", res.StatusCode, truncate(string(body), 200))
	}
	var env zaiEnvelope
	if err := json.Unmarshal(body, &env); err != nil {
		return nil, err
	}
	if (env.Success != nil && !*env.Success) || (env.Code != nil && *env.Code != 200) {
		code := "API"
		if env.Code != nil {
			code = strconv.FormatInt(int64(*env.Code), 10)
		}
		msg := env.Msg
		if msg == "" {
			msg = "request failed"
		}
		return nil, fmt.Errorf("%s: %s", code, msg)
	}
	return &env, nil
}

func (zaiAdapter) Fetch(cred map[string]string) ([]Row, error) {
	apiKey := cred["api_key"]
	if apiKey == "" {
		apiKey = cred["token"]
	}
	if apiKey == "" {
		return nil, errors.New("missing credential: api_key（Z.ai / GLM Coding Plan Key）")
	}
	defaultBase := "https://api.z.ai"
	if cred["region"] == "cn" {
		defaultBase = "https://open.bigmodel.cn"
	}
	base := defaultBase
	if b := cred["base_url"]; b != "" {
		var err error
		base, err = secureBaseURL("zai", b)
		if err != nil {
			return nil, err
		}
	}

	var errs []string
	var limits []zaiLimit
	for _, path := range []string{"/api/monitor/usage/quota/limit", "/api/monitor/usage"} {
		env, err := fetchZaiEnvelope(base+path, apiKey)
		if err != nil {
			errs = append(errs, fmt.Sprintf("%s: %s", path, err))
			continue
		}
		if env.Data != nil {
			limits = env.Data.Limits
		}
		if len(limits) > 0 {
			break
		}
		errs = append(errs, path+": no limits")
	}

	var rows []Row
	seen := map[string]bool{}
	for _, item := range limits {
		if item.Type != "TOKENS_LIMIT" && item.Type != "CREDIT_LIMIT" && item.Type != "TIME_LIMIT" {
			continue
		}
		metric := zaiMetricFor(item)
		pct := zaiUsedPercent(item)
		if metric == "" || pct == nil || seen[metric] {
			continue
		}
		seen[metric] = true
		rows = append(rows, Row{
			Provider:   "zai",
			Metric:     metric,
			Value:      *pct,
			Unit:       strptr("percent"),
			LimitValue: fptr(100),
			ResetAt:    millisISO(item.NextResetTime),
		})
	}
	if len(rows) == 0 {
		detail := ""
		if len(errs) > 0 {
			detail = " (" + strings.Join(errs, "; ") + ")"
		}
		return nil, fmt.Errorf("zai: no usable Coding Plan quota windows%s", detail)
	}
	return rows, nil
}
