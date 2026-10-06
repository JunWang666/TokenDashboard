package runner

import (
	"errors"
	"fmt"
	"math"
	"time"
)

// minimaxAdapter: MiniMax Token Plan（官方只读额度接口）。
// 凭证必须是 Token Plan Subscription Key，不是普通按量付费 API Key。
// region=cn 使用中国站；也可用 base_url 覆盖到兼容的 HTTPS 转发地址。
type minimaxAdapter struct{}

func (minimaxAdapter) Provider() string { return "minimax" }

type minimaxRemain struct {
	ModelName                       string `json:"model_name"`
	EndTime                         any    `json:"end_time"`
	WeeklyEndTime                   any    `json:"weekly_end_time"`
	RemainsTime                     any    `json:"remains_time"`
	WeeklyRemainsTime               any    `json:"weekly_remains_time"`
	CurrentIntervalTotalCount       any    `json:"current_interval_total_count"`
	CurrentIntervalUsageCount       any    `json:"current_interval_usage_count"`
	CurrentIntervalRemainingPercent any    `json:"current_interval_remaining_percent"`
	CurrentWeeklyTotalCount         any    `json:"current_weekly_total_count"`
	CurrentWeeklyUsageCount         any    `json:"current_weekly_usage_count"`
	CurrentWeeklyRemainingPercent   any    `json:"current_weekly_remaining_percent"`
}

// minimax usedPercent：usage_count 字段虽名为"已使用"实为剩余量；优先用
// remaining_percent，旧版回退 total - remaining 计算已用量。
func minimaxUsedPercent(totalValue, remainingValue, remainingPctValue any) *float64 {
	if p := finite(remainingPctValue); p != nil {
		return fptr(roundPct(100 - *p))
	}
	total, remaining := finite(totalValue), finite(remainingValue)
	if total != nil && remaining != nil && *total > 0 {
		return fptr(roundPct((*total - *remaining) / *total * 100))
	}
	return nil
}

func roundPct(v float64) float64 {
	return math.Round(math.Max(0, math.Min(100, v))*10) / 10
}

// resetISO mirrors the TS resetISO: explicit epoch (s or ms) wins, otherwise
// now + remains milliseconds.
func resetISO(explicit, remainsMs any, now time.Time) *string {
	if raw := finite(explicit); raw != nil && *raw > 0 {
		ms := *raw
		if ms < 1_000_000_000_000 {
			ms *= 1000
		}
		s := time.UnixMilli(int64(ms)).UTC().Format(time.RFC3339)
		return &s
	}
	if left := finite(remainsMs); left != nil && *left > 0 {
		s := now.Add(time.Duration(int64(*left)) * time.Millisecond).UTC().Format(time.RFC3339)
		return &s
	}
	return nil
}

// metricSuffix: 多模型时在指标名后加 _model 后缀（"general" 不加）。
func metricSuffix(model string, multiple bool) string {
	if !multiple || model == "" || model == "general" {
		return ""
	}
	return "_" + sanitize(model)
}

func (minimaxAdapter) Fetch(cred map[string]string) ([]Row, error) {
	apiKey := cred["api_key"]
	if apiKey == "" {
		apiKey = cred["token"]
	}
	if apiKey == "" {
		return nil, errors.New("missing credential: api_key（MiniMax Token Plan Subscription Key）")
	}
	defaultBase := "https://api.minimax.io/v1"
	if cred["region"] == "cn" {
		defaultBase = "https://api.minimaxi.com/v1"
	}
	base := defaultBase
	if b := cred["base_url"]; b != "" {
		var err error
		base, err = secureBaseURL("minimax", b)
		if err != nil {
			return nil, err
		}
	}
	var json struct {
		ModelRemains []minimaxRemain `json:"model_remains"`
		BaseResp     *struct {
			StatusCode int    `json:"status_code"`
			StatusMsg  string `json:"status_msg"`
		} `json:"base_resp"`
	}
	if err := getJSON(base+"/token_plan/remains", map[string]string{
		"Authorization": "Bearer " + apiKey,
		"Accept":        "application/json",
	}, &json); err != nil {
		return nil, fmt.Errorf("minimax token plan remains: %w", err)
	}
	if json.BaseResp != nil && json.BaseResp.StatusCode != 0 {
		return nil, fmt.Errorf("minimax: %d %s", json.BaseResp.StatusCode, json.BaseResp.StatusMsg)
	}
	remains := json.ModelRemains
	multiple := len(remains) > 1
	now := time.Now()
	var rows []Row
	for _, item := range remains {
		suffix := metricSuffix(item.ModelName, multiple)
		if session := minimaxUsedPercent(
			item.CurrentIntervalTotalCount,
			item.CurrentIntervalUsageCount,
			item.CurrentIntervalRemainingPercent,
		); session != nil {
			rows = append(rows, Row{
				Provider:   "minimax",
				Metric:     "session_used_pct" + suffix,
				Value:      *session,
				Unit:       strptr("percent"),
				LimitValue: fptr(100),
				ResetAt:    resetISO(item.EndTime, item.RemainsTime, now),
			})
		}
		if weekly := minimaxUsedPercent(
			item.CurrentWeeklyTotalCount,
			item.CurrentWeeklyUsageCount,
			item.CurrentWeeklyRemainingPercent,
		); weekly != nil {
			rows = append(rows, Row{
				Provider:   "minimax",
				Metric:     "weekly_used_pct" + suffix,
				Value:      *weekly,
				Unit:       strptr("percent"),
				LimitValue: fptr(100),
				ResetAt:    resetISO(item.WeeklyEndTime, item.WeeklyRemainsTime, now),
			})
		}
	}
	if len(rows) == 0 {
		return nil, errors.New("minimax: no usable quota windows in response")
	}
	return rows, nil
}
