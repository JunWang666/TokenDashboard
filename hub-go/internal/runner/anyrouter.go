package runner

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
)

// anyrouterAdapter: AnyRouter credits API——查询 workspace 的余额与消费概况。
type anyrouterAdapter struct{}

func (anyrouterAdapter) Provider() string { return "anyrouter" }

type anyrouterCredits struct {
	Balance        any    `json:"balance"`
	MonthlyBalance any    `json:"monthly_balance"`
	TopupBalance   any    `json:"topup_balance"`
	Used           any    `json:"used"`
	TodayCost      any    `json:"today_cost"`
	Currency       string `json:"currency"`
}

var (
	authPrefixRe   = regexp.MustCompile(`(?i)^authorization\s*:\s*`)
	bearerPrefixRe = regexp.MustCompile(`(?i)^bearer\s+`)
)

// apiKeyFromCredential accepts a key pasted as either the raw secret or an
// Authorization header value.
func apiKeyFromCredential(cred map[string]string) string {
	raw := cred["api_key"]
	if raw == "" {
		raw = cred["token"]
	}
	if raw == "" {
		raw = cred["value"]
	}
	if raw == "" {
		return ""
	}
	value := strings.TrimSpace(raw)
	value = bearerPrefixRe.ReplaceAllString(authPrefixRe.ReplaceAllString(value, ""), "")
	value = strings.TrimSpace(value)
	return value
}

func (anyrouterAdapter) Fetch(cred map[string]string) ([]Row, error) {
	apiKey := apiKeyFromCredential(cred)
	if apiKey == "" {
		return nil, errors.New("missing credential: api_key（AnyRouter LLM Key 或 Management Key）")
	}

	base := "https://anyrouter.dev/api/v1"
	if b := strings.TrimSpace(cred["base_url"]); b != "" {
		var err error
		base, err = secureBaseURL("anyrouter", b)
		if err != nil {
			return nil, err
		}
	}
	req, err := http.NewRequest(http.MethodGet, base+"/credits", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Accept", "application/json")
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
		detail := truncate(string(body), 200)
		switch res.StatusCode {
		case 401:
			msg := "anyrouter credits: HTTP 401：API key 无效、已过期、已撤销或复制不完整；请在 AnyRouter 控制台重新创建/轮换 sk-ar-v1-... key。"
			if detail != "" {
				msg += " 原始响应: " + detail
			}
			return nil, errors.New(msg)
		case 403:
			msg := "anyrouter credits: HTTP 403：当前 key 没有 /api/v1/credits 权限；请开启 Management/credits 权限，或使用带 read:credits 的 ak_ 管理 key。"
			if detail != "" {
				msg += " 原始响应: " + detail
			}
			return nil, errors.New(msg)
		default:
			return nil, fmt.Errorf("anyrouter credits: HTTP %d: %s", res.StatusCode, detail)
		}
	}

	var credits anyrouterCredits
	if err := json.Unmarshal(body, &credits); err != nil {
		return nil, err
	}
	currency := strings.ToLower(credits.Currency)
	if currency == "" {
		currency = "usd"
	}
	if currency != "usd" {
		return nil, fmt.Errorf("anyrouter: unsupported currency %s", credits.Currency)
	}

	var rows []Row
	for _, kv := range []struct {
		metric string
		raw    any
	}{
		{"balance_usd", credits.Balance},
		{"monthly_balance_usd", credits.MonthlyBalance},
		{"topup_balance_usd", credits.TopupBalance},
		{"used_usd", credits.Used},
		{"today_cost_usd", credits.TodayCost},
	} {
		value := finite(kv.raw)
		if value == nil {
			continue
		}
		rows = append(rows, Row{
			Provider: "anyrouter",
			Metric:   kv.metric,
			Value:    *value,
			Unit:     strptr("usd"),
		})
	}
	if len(rows) == 0 {
		return nil, errors.New("anyrouter: no usable credits fields in response")
	}
	return rows, nil
}
