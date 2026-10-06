package runner

import (
	"errors"
	"fmt"
	"strings"
)

// glmAdapter: POST open.bigmodel.cn/api/paas/v4/balance/invoke。
type glmAdapter struct{}

func (glmAdapter) Provider() string { return "glm" }

func (glmAdapter) Fetch(cred map[string]string) ([]Row, error) {
	apiKey := cred["api_key"]
	if apiKey == "" {
		return nil, errors.New("missing credential: api_key")
	}
	var json struct {
		Code    *int    `json:"code"`
		Message *string `json:"message"`
		Data    *struct {
			BalanceInfos []struct {
				Currency         string `json:"currency"`
				TotalBalance     any    `json:"total_balance"`
				AvailableBalance any    `json:"available_balance"`
			} `json:"balance_infos"`
		} `json:"data"`
	}
	if err := postJSON("https://open.bigmodel.cn/api/paas/v4/balance/invoke",
		map[string]string{"Authorization": "Bearer " + apiKey}, map[string]string{}, &json); err != nil {
		return nil, fmt.Errorf("glm balance: %w", err)
	}
	if json.Code != nil && *json.Code != 200 {
		return nil, fmt.Errorf("glm: %d %s", *json.Code, strOrEmpty(json.Message))
	}
	var infos []struct {
		Currency         string `json:"currency"`
		TotalBalance     any    `json:"total_balance"`
		AvailableBalance any    `json:"available_balance"`
	}
	if json.Data != nil {
		infos = json.Data.BalanceInfos
	}
	if len(infos) == 0 {
		return nil, errors.New("glm: no balance_infos in response")
	}
	var rows []Row
	for _, i := range infos {
		currency := strings.ToLower(i.Currency)
		row := Row{
			Provider: "glm",
			Metric:   "balance_" + currency,
			Value:    num(i.TotalBalance),
			Unit:     strptr(currency),
		}
		if v := finite(i.AvailableBalance); v != nil {
			row.LimitValue = v
		}
		rows = append(rows, row)
	}
	return rows, nil
}

func strOrEmpty(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
