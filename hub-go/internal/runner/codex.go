package runner

import (
	"errors"
	"fmt"
	"strings"
)

// codexAdapter: chatgpt.com/backend-api/wham/usage（Codex 订阅额度，非官方）。
// 凭证：~/.codex/auth.json 的 tokens.access_token（ChatGPT 订阅 OAuth token，有效期约一周，过期需重新粘贴）。
// 可选 cred["base_url"]：正向转发地址（替换 https://chatgpt.com/backend-api，用于绕开对端 WAF 对出口的拦截）。
// 注意：必须带 codex CLI 风格的 User-Agent——实测默认 UA 被拦返回 403 HTML 错误页（不是 401）。
// 刻意不做 refresh_token 自动续期：refresh token 是一次性轮换的，runner 刷新会使本机 Codex CLI 登录态作废。
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
		return nil, errors.New("missing credential: access_token（~/.codex/auth.json 的 tokens.access_token）")
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
	base := "https://chatgpt.com/backend-api"
	if b := cred["base_url"]; b != "" {
		base = strings.TrimRight(b, "/")
	}
	var payload codexPayload
	if err := getJSON(base+"/wham/usage", headers, &payload); err != nil {
		return nil, fmt.Errorf("codex usage（access_token 可能已过期，需重新粘贴）: %w", err)
	}

	var primary, secondary *codexWindow
	if payload.RateLimit != nil {
		primary, secondary = payload.RateLimit.Primary, payload.RateLimit.Secondary
	}
	if primary == nil && secondary == nil {
		return nil, errors.New("codex: no rate_limit window in response")
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
