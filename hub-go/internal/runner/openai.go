package runner

import (
	"errors"
	"fmt"
	"math"
	"time"
)

// openaiAdapter: organization costs + balance（Admin API Key 或组织 key）。
type openaiAdapter struct{}

func (openaiAdapter) Provider() string { return "openai" }

func (openaiAdapter) Fetch(cred map[string]string) ([]Row, error) {
	apiKey := cred["api_key"]
	if apiKey == "" {
		return nil, errors.New("missing credential: api_key (Admin API Key 或组织 key)")
	}
	// 当月起始/结束的 unix 秒（UTC）
	now := time.Now().UTC()
	start := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	end := start.AddDate(0, 1, 0)
	endISO := end.Format(time.RFC3339)

	headers := map[string]string{"Authorization": "Bearer " + apiKey}
	var costJSON struct {
		Data any `json:"data"`
	}
	costsURL := fmt.Sprintf("https://api.openai.com/v1/organization/costs?start_time=%d&end_time=%d&bucket_width=1d",
		start.Unix(), end.Unix())
	if err := getJSON(costsURL, headers, &costJSON); err != nil {
		return nil, fmt.Errorf("openai costs: %w", err)
	}
	var amounts []amount
	collectAmounts(costJSON.Data, &amounts)
	monthCost := 0.0
	for _, a := range amounts {
		monthCost += num(a.value)
	}
	rows := []Row{{
		Provider: "openai",
		Metric:   "month_cost_usd",
		Value:    math.Round(monthCost*100) / 100,
		Unit:     strptr("usd"),
		ResetAt:  strptr(endISO),
	}}

	// 余额不是所有账户都有（多数按量后付费），尽力尝试 balance 接口，失败不阻塞
	var bal struct {
		CurrentBalance *float64 `json:"current_balance"`
	}
	if err := getJSON("https://api.openai.com/v1/organization/usage/balance", headers, &bal); err == nil && bal.CurrentBalance != nil {
		rows = append(rows, Row{
			Provider: "openai",
			Metric:   "balance_usd",
			Value:    *bal.CurrentBalance,
			Unit:     strptr("usd"),
		})
	}
	return rows, nil
}

type amount struct {
	value    any
	currency string
}

// collectAmounts recursively gathers every nested "amount" object, mirroring
// the TS collectAmounts walk over the costs response tree.
func collectAmounts(node any, out *[]amount) {
	switch t := node.(type) {
	case []any:
		for _, item := range t {
			collectAmounts(item, out)
		}
	case map[string]any:
		if a, ok := t["amount"].(map[string]any); ok {
			*out = append(*out, amount{value: a["value"], currency: fmt.Sprint(a["currency"])})
		}
		for _, v := range t {
			collectAmounts(v, out)
		}
	}
}
