package runner

import (
	"errors"
	"fmt"
	"math"
)

// cursorAdapter: cursor.com/api/usage-summary（非官方，session cookie；接口变动时记录 scrape_error）。
type cursorAdapter struct{}

func (cursorAdapter) Provider() string { return "cursor" }

func (cursorAdapter) Fetch(cred map[string]string) ([]Row, error) {
	cookie := cred["session"]
	if cookie == "" {
		cookie = cred["session_key"]
	}
	if cookie == "" {
		cookie = cred["sessionKey"]
	}
	if cookie == "" {
		return nil, errors.New("missing credential: session (完整 cookie 串)")
	}
	var json struct {
		BillingCycleEnd string `json:"billingCycleEnd"`
		IndividualUsage *struct {
			Plan *struct {
				Used             any      `json:"used"`
				Limit            *float64 `json:"limit"`
				Remaining        *float64 `json:"remaining"`
				AutoPercentUsed  *float64 `json:"autoPercentUsed"`
				ApiPercentUsed   *float64 `json:"apiPercentUsed"`
				TotalPercentUsed *float64 `json:"totalPercentUsed"`
			} `json:"plan"`
		} `json:"individualUsage"`
	}
	if err := getJSON("https://cursor.com/api/usage-summary", map[string]string{
		"Cookie": cookie,
		"Accept": "application/json",
	}, &json); err != nil {
		return nil, fmt.Errorf("cursor usage-summary: %w", err)
	}
	plan := json.IndividualUsage.Plan
	if json.IndividualUsage == nil || plan == nil || plan.Used == nil {
		return nil, errors.New("cursor: no individualUsage.plan in response")
	}
	var resetAt *string
	if json.BillingCycleEnd != "" {
		// TS: billingCycleEnd ? billingCycleEnd.slice(0, 10) : null
		v := json.BillingCycleEnd
		if len(v) > 10 {
			v = v[:10]
		}
		resetAt = &v
	}

	var rows []Row
	// 分项池：对应 cursor.com 仪表盘两条柱（Cursor Models / Other Models）
	for _, kv := range []struct {
		metric string
		v      *float64
	}{
		{"auto_used_pct", plan.AutoPercentUsed},
		{"api_used_pct", plan.ApiPercentUsed},
	} {
		if kv.v == nil {
			continue
		}
		rows = append(rows, Row{
			Provider:   "cursor",
			Metric:     kv.metric,
			Value:      math.Round(*kv.v*10) / 10,
			Unit:       strptr("percent"),
			LimitValue: fptr(100),
			ResetAt:    resetAt,
		})
	}
	// 总占比（按额度加权，含 bonus 额度）；保留作兼容与老数据回退
	if plan.TotalPercentUsed != nil {
		rows = append(rows, Row{
			Provider:   "cursor",
			Metric:     "plan_used_pct",
			Value:      math.Round(*plan.TotalPercentUsed*10) / 10,
			Unit:       strptr("percent"),
			LimitValue: fptr(100),
			ResetAt:    resetAt,
		})
	}
	rows = append(rows, Row{
		Provider:   "cursor",
		Metric:     "requests_used",
		Value:      num(plan.Used),
		Unit:       strptr("usd_cents"),
		LimitValue: plan.Limit,
		ResetAt:    resetAt,
	})
	if plan.Remaining != nil && plan.Limit != nil {
		rows = append(rows, Row{
			Provider:   "cursor",
			Metric:     "requests_remaining",
			Value:      *plan.Remaining,
			Unit:       strptr("usd_cents"),
			LimitValue: plan.Limit,
			ResetAt:    resetAt,
		})
	}
	return rows, nil
}
