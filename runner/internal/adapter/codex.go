package adapter

import (
	"fmt"
	"strings"
	"time"
)

// CodexUsageURL 可在测试中覆盖。
var CodexUsageURL = "https://chatgpt.com/backend-api/wham/usage"

// codex 适配器：Codex 订阅额度（chatgpt.com/backend-api/wham/usage，非官方）。
// 凭证：~/.codex/auth.json 的 tokens.access_token（ChatGPT 订阅 OAuth token，有效期约一周，过期需重新粘贴）。
// 可选 cred["base_url"]：正向转发地址，替换默认的 https://chatgpt.com/backend-api。
// 注意：实测必须带 codex CLI 风格的 User-Agent，否则被拦返回 403 HTML 错误页（不是 401）。
// 刻意不做 refresh_token 自动续期：refresh token 是一次性轮换的，刷新会使本机 Codex CLI 登录态作废。
type codexAdapter struct{}

func (codexAdapter) Provider() string { return "codex" }

type codexWindow struct {
	UsedPercent        *float64 `json:"used_percent"`
	LimitWindowSeconds float64  `json:"limit_window_seconds"`
	ResetAt            *float64 `json:"reset_at"` // unix 秒
}

type codexPayload struct {
	PlanType  string `json:"plan_type"`
	RateLimit *struct {
		Primary   *codexWindow `json:"primary_window"`
		Secondary *codexWindow `json:"secondary_window"`
	} `json:"rate_limit"`
	Credits *struct {
		HasCredits bool `json:"has_credits"`
		Balance    any  `json:"balance"` // 字符串或数字
	} `json:"credits"`
}

func (codexAdapter) Fetch(cred map[string]string) ([]Row, error) {
	token := cred["access_token"]
	if token == "" {
		token = cred["token"]
	}
	if token == "" {
		return nil, fmt.Errorf("missing credential: access_token（~/.codex/auth.json 的 tokens.access_token）")
	}
	headers := map[string]string{
		"Authorization": "Bearer " + token,
		"Accept":        "application/json",
		"originator":    "codex_cli_rs",
		"User-Agent":    "codex_cli_rs/0.40.0",
	}
	if id := cred["account_id"]; id != "" {
		headers["ChatGPT-Account-Id"] = id
	}
	var payload codexPayload
	url := CodexUsageURL
	if base := cred["base_url"]; base != "" {
		url = strings.TrimRight(base, "/") + "/wham/usage"
	}
	if err := getJSON(url, headers, &payload); err != nil {
		return nil, fmt.Errorf("codex usage（access_token 可能已过期，需重新粘贴）: %w", err)
	}

	var primary, secondary *codexWindow
	if payload.RateLimit != nil {
		primary, secondary = payload.RateLimit.Primary, payload.RateLimit.Secondary
	}
	if primary == nil && secondary == nil {
		return nil, fmt.Errorf("codex: no rate_limit window in response")
	}

	// 窗口身份靠 limit_window_seconds 判断（部分套餐周限额在 primary_window），
	// 缺时长时按 primary=5 小时 / secondary=周 兜底
	var rows []Row
	for _, w := range []struct {
		win      *codexWindow
		fallback string
	}{
		{primary, "session_used_pct"},
		{secondary, "weekly_used_pct"},
	} {
		if w.win == nil || w.win.UsedPercent == nil {
			continue
		}
		metric := w.fallback
		if secs := w.win.LimitWindowSeconds; secs >= 86400 {
			metric = "weekly_used_pct"
		} else if secs > 0 {
			metric = "session_used_pct"
		}
		rows = append(rows, Row{
			Provider:   "codex",
			Metric:     metric,
			Value:      *w.win.UsedPercent,
			Unit:       strptr("percent"),
			LimitValue: fptr(100),
			ResetAt:    unixISO(w.win.ResetAt),
		})
	}

	// 充值余额（可选字段，balance 可能是字符串）
	if c := payload.Credits; c != nil && c.HasCredits && c.Balance != nil {
		rows = append(rows, Row{
			Provider: "codex",
			Metric:   "credits_usd",
			Value:    num(c.Balance),
			Unit:     strptr("usd"),
		})
	}
	return rows, nil
}

// unixISO 把 unix 秒转 ISO 字符串；nil 返回 nil。
func unixISO(ts *float64) *string {
	if ts == nil {
		return nil
	}
	s := time.Unix(int64(*ts), 0).UTC().Format(time.RFC3339)
	return &s
}
