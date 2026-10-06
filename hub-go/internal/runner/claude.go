package runner

import (
	"errors"
	"fmt"
	"math"
	"regexp"
)

// claudeAdapter: claude.ai usage（非官方，sessionKey cookie；接口变动时记录 scrape_error）。
type claudeAdapter struct{}

func (claudeAdapter) Provider() string { return "claude" }

func (claudeAdapter) Fetch(cred map[string]string) ([]Row, error) {
	sessionKey := cred["session_key"]
	if sessionKey == "" {
		sessionKey = cred["sessionKey"]
	}
	if sessionKey == "" {
		sessionKey = cred["session"]
	}
	if sessionKey == "" {
		return nil, errors.New("missing credential: session_key")
	}
	cookie := "sessionKey=" + sessionKey

	var orgs []struct {
		UUID string `json:"uuid"`
	}
	if err := getJSON("https://claude.ai/api/organizations",
		map[string]string{"Cookie": cookie}, &orgs); err != nil {
		return nil, fmt.Errorf("claude organizations: %w", err)
	}
	if len(orgs) == 0 || orgs[0].UUID == "" {
		return nil, errors.New("claude: no organization uuid")
	}

	var json struct {
		TotalUsage *struct {
			RateLimitModel []struct {
				Model        string `json:"model"`
				MaxInWindow  any    `json:"max_in_window"`
				UsedInWindow any    `json:"used_in_window"`
			} `json:"rate_limit_model"`
			RateLimitSystem []struct {
				Period string `json:"period"`
				Max    any    `json:"max"`
				Used   any    `json:"used"`
			} `json:"rate_limit_system"`
		} `json:"total_usage"`
	}
	if err := getJSON(fmt.Sprintf("https://claude.ai/api/organizations/%s/usage", orgs[0].UUID),
		map[string]string{"Cookie": cookie}, &json); err != nil {
		return nil, fmt.Errorf("claude usage: %w", err)
	}
	if json.TotalUsage == nil || len(json.TotalUsage.RateLimitModel) == 0 {
		return nil, errors.New("claude: no rate_limit_model in response")
	}

	models := json.TotalUsage.RateLimitModel
	multi := len(models) > 1
	var rows []Row
	for _, m := range models {
		max := num(m.MaxInWindow)
		used := num(m.UsedInWindow)
		if max <= 0 {
			continue
		}
		metric := "session_used_pct"
		if multi {
			metric = "session_used_pct_" + sanitize(m.Model)
		}
		rows = append(rows, Row{
			Provider:   "claude",
			Metric:     metric,
			Value:      math.Round(used/max*1000) / 10,
			Unit:       strptr("percent"),
			LimitValue: fptr(100),
		})
	}

	// 周限额（rate_limit_system 中 period 含 week 的条目）
	weekRe := regexp.MustCompile(`week`)
	for _, s := range json.TotalUsage.RateLimitSystem {
		if !weekRe.MatchString(s.Period) {
			continue
		}
		max := num(s.Max)
		used := num(s.Used)
		if max <= 0 {
			continue
		}
		rows = append(rows, Row{
			Provider:   "claude",
			Metric:     "weekly_used_pct",
			Value:      math.Round(used/max*1000) / 10,
			Unit:       strptr("percent"),
			LimitValue: fptr(100),
		})
	}
	return rows, nil
}
