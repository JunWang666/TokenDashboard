package runner

import (
	"errors"
	"fmt"
	"strings"
)

// deepseekAdapter: GET api.deepseek.com/user/balance。
type deepseekAdapter struct{}

func (deepseekAdapter) Provider() string { return "deepseek" }

func (deepseekAdapter) Fetch(cred map[string]string) ([]Row, error) {
	apiKey := cred["api_key"]
	if apiKey == "" {
		return nil, errors.New("missing credential: api_key")
	}
	var json struct {
		BalanceInfos []struct {
			Currency     string `json:"currency"`
			TotalBalance any    `json:"total_balance"`
		} `json:"balance_infos"`
	}
	if err := getJSON("https://api.deepseek.com/user/balance",
		map[string]string{"Authorization": "Bearer " + apiKey}, &json); err != nil {
		return nil, fmt.Errorf("deepseek balance: %w", err)
	}
	if len(json.BalanceInfos) == 0 {
		return nil, errors.New("deepseek: no balance_infos in response")
	}
	var rows []Row
	for _, i := range json.BalanceInfos {
		currency := strings.ToLower(i.Currency)
		rows = append(rows, Row{
			Provider: "deepseek",
			Metric:   "balance_" + currency,
			Value:    num(i.TotalBalance),
			Unit:     strptr(currency),
		})
	}
	return rows, nil
}
