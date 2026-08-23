package adapter

import (
	"fmt"
	"math"
	"strings"
)

// KimiUsageURL 可在测试中覆盖。
var KimiUsageURL = "https://api.kimi.com/coding/v1/usages"

// kimi 适配器：Kimi Code 订阅额度（api.kimi.com/coding/v1/usages）。
// 凭证：kimi.com/code 控制台创建的 API Key（sk-kimi-*，与开放平台 sk- key 不互通）；
// OAuth access_token 仅 15 分钟有效，不适合定时采集。
// 可选 cred["base_url"]：正向转发地址（如 https://relay.example.com/kimi），替换默认的
// https://api.kimi.com/coding/v1。
// 可选 cred["web_token"]：kimi.com 网页登录态 access_token，用于采集月额度（见 fetchKimiMonthly）。
// 注意：官方声明篡改 User-Agent 视为违规，这里不自定义 UA。
type kimiAdapter struct{}

func (kimiAdapter) Provider() string { return "kimi" }

// kimiQuota 的数值字段兼容字符串/数字两种形态，用 any 承接。
type kimiQuota struct {
	Limit     any    `json:"limit"`
	Used      any    `json:"used"`
	Remaining any    `json:"remaining"`
	ResetTime string `json:"resetTime"`
}

type kimiWindow struct {
	Duration float64 `json:"duration"`
	TimeUnit string  `json:"timeUnit"` // protobuf 风格，如 "TIME_UNIT_MINUTE"
}

type kimiPayload struct {
	Usage  *kimiQuota `json:"usage"` // 周额度（报 remaining，不报 used）
	Limits []struct {
		Window *kimiWindow `json:"window"`
		Detail *kimiQuota  `json:"detail"`
	} `json:"limits"` // 滚动频率窗口
}

// windowSeconds 把 window 时长换算成秒；无法识别返回 0。
func windowSeconds(w *kimiWindow) float64 {
	if w == nil {
		return 0
	}
	switch unit := strings.ToUpper(w.TimeUnit); {
	case strings.HasSuffix(unit, "MINUTE"):
		return w.Duration * 60
	case strings.HasSuffix(unit, "HOUR"):
		return w.Duration * 3600
	case strings.HasSuffix(unit, "SECOND"):
		return w.Duration
	}
	return 0
}

func (kimiAdapter) Fetch(cred map[string]string) ([]Row, error) {
	apiKey := cred["api_key"]
	if apiKey == "" {
		apiKey = cred["access_token"]
	}
	if apiKey == "" {
		return nil, fmt.Errorf("missing credential: api_key（kimi.com/code 控制台的 sk-kimi- key）")
	}
	var payload kimiPayload
	url := KimiUsageURL
	if base := cred["base_url"]; base != "" {
		url = strings.TrimRight(base, "/") + "/usages"
	}
	if err := getJSON(url, map[string]string{
		"Authorization": "Bearer " + apiKey,
		"Accept":        "application/json",
	}, &payload); err != nil {
		return nil, fmt.Errorf("kimi usages: %w", err)
	}

	var rows []Row

	// 周额度：limit/remaining 换算已用百分比
	if u := payload.Usage; u != nil {
		if limit := num(u.Limit); limit > 0 {
			rows = append(rows, Row{
				Provider:   "kimi",
				Metric:     "weekly_used_pct",
				Value:      math.Round((limit-num(u.Remaining))/limit*1000) / 10,
				Unit:       strptr("percent"),
				LimitValue: fptr(100),
				ResetAt:    strptrOrNil(u.ResetTime),
			})
		}
	}

	// 5 小时滚动窗口：按时长识别（duration×timeUnit ≈ 18000 秒），不靠数组下标
	for _, l := range payload.Limits {
		if secs := windowSeconds(l.Window); secs < 3600 || secs >= 86400 {
			continue
		}
		d := l.Detail
		if d == nil {
			continue
		}
		dLimit := num(d.Limit)
		if dLimit <= 0 {
			continue
		}
		used := num(d.Used)
		if d.Used == nil {
			used = dLimit - num(d.Remaining)
		}
		rows = append(rows, Row{
			Provider:   "kimi",
			Metric:     "session_used_pct",
			Value:      math.Round(used/dLimit*1000) / 10,
			Unit:       strptr("percent"),
			LimitValue: fptr(100),
			ResetAt:    strptrOrNil(d.ResetTime),
		})
		break
	}

	if len(rows) == 0 {
		return nil, fmt.Errorf("kimi: no usage/limits in response")
	}

	// 月额度（可选，需要网页登录态 token）
	monthly, err := fetchKimiMonthly(cred)
	if err != nil {
		return nil, err
	}
	rows = append(rows, monthly...)
	return rows, nil
}

// kimiStatsResponse 是 GetSubscriptionStats 的响应。
// 注意：实测服务端返回的是 camelCase（subscriptionBalance/amountUsedRatio），
// 尽管前端 client 配了 useProtoFieldName——两种形态都兼容。
type kimiStatsResponse struct {
	SubscriptionBalance      *kimiBalance `json:"subscriptionBalance"`
	SubscriptionBalanceSnake *kimiBalance `json:"subscription_balance"`
}

type kimiBalance struct {
	Amount               any     `json:"amount"`
	AmountLeft           any     `json:"amountLeft"`
	AmountLeftSnake      any     `json:"amount_left"`
	AmountUsedRatio      float64 `json:"amountUsedRatio"`
	AmountUsedRatioSnake float64 `json:"amount_used_ratio"`
	ExpireTime           string  `json:"expireTime"` // protobuf Timestamp 的 JSON 形态是 RFC3339 字符串
	ExpireTimeSnake      string  `json:"expire_time"`
}

func (b *kimiBalance) left() any {
	if b.AmountLeft != nil {
		return b.AmountLeft
	}
	return b.AmountLeftSnake
}

func (b *kimiBalance) usedRatio() float64 {
	if b.AmountUsedRatio != 0 {
		return b.AmountUsedRatio
	}
	return b.AmountUsedRatioSnake
}

func (b *kimiBalance) expire() string {
	if b.ExpireTime != "" {
		return b.ExpireTime
	}
	return b.ExpireTimeSnake
}

// fetchKimiMonthly 采集月额度：kimi.com 网页版会员接口（connect RPC，proto 定义取自
// kimi.com 前端包 kimi.gateway.membership.v2.MembershipService.GetSubscriptionStats）。
// 月额度不在 coding/v1/usages 里；Kimi Code 的月额度在 DOMAIN_CODE，与主站会员共享时退到 DOMAIN_KIMI。
func fetchKimiMonthly(cred map[string]string) ([]Row, error) {
	webToken := cred["web_token"]
	if webToken == "" {
		return nil, nil
	}
	base := cred["stats_base_url"]
	if base == "" {
		base = "https://www.kimi.com/apiv2"
	}
	url := strings.TrimRight(base, "/") + "/kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats"
	headers := map[string]string{
		"Authorization":            "Bearer " + webToken,
		"Connect-Protocol-Version": "1",
		"Accept":                   "application/json",
	}
	for _, domain := range []string{"DOMAIN_CODE", "DOMAIN_KIMI"} {
		var resp kimiStatsResponse
		if err := postJSON(url, headers, map[string]string{"domain": domain}, &resp); err != nil {
			return nil, fmt.Errorf("kimi stats(%s)（web_token 可能已过期，需重新粘贴）: %w", domain, err)
		}
		b := resp.SubscriptionBalance
		if b == nil {
			b = resp.SubscriptionBalanceSnake
		}
		if b == nil {
			continue
		}
		amount, left := num(b.Amount), num(b.left())
		pct := b.usedRatio() * 100
		if pct == 0 && amount > 0 {
			pct = (amount - left) / amount * 100
		}
		rows := []Row{{
			Provider:   "kimi",
			Metric:     "monthly_used_pct",
			Value:      math.Round(pct*10) / 10,
			Unit:       strptr("percent"),
			LimitValue: fptr(100),
			ResetAt:    strptrOrNil(b.expire()),
		}}
		if amount > 0 {
			rows = append(rows, Row{
				Provider:   "kimi",
				Metric:     "monthly_remaining",
				Value:      left,
				Unit:       strptr("credits"),
				LimitValue: fptr(amount),
				ResetAt:    strptrOrNil(b.expire()),
			})
		}
		return rows, nil
	}
	return nil, nil // 有 web_token 但无订阅余额（未订阅会员）：不报错，只是没有月额度行
}
