package runner

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

// anyrouterTopAdapter: AnyRouter.top NewAPI——使用 session Cookie 查询 /api/user/self。
type anyrouterTopAdapter struct{}

func (anyrouterTopAdapter) Provider() string { return "anyrouter_top" }

const anyrouterTopQuotaUnitsPerUSD = 500_000

var cookieHeaderPrefixRe = regexp.MustCompile(`(?i)^cookie\s*:\s*`)

// firstNonEmpty mirrors the TS helper: the first credential field that is
// present and non-empty after trimming.
func firstNonEmpty(cred map[string]string, names []string) string {
	for _, name := range names {
		if value := strings.TrimSpace(cred[name]); value != "" {
			return value
		}
	}
	return ""
}

// cookieHeader accepts a session value, a full Cookie header, or a nested
// object ({"session":"..."}; the collector flattens credential objects to
// JSON strings), mirroring the TS cookieHeader.
func cookieHeader(cred map[string]string) string {
	raw := firstNonEmpty(cred, []string{"cookie", "cookies", "session"})
	if raw == "" {
		return ""
	}
	value := strings.TrimSpace(raw)
	value = strings.TrimSpace(cookieHeaderPrefixRe.ReplaceAllString(value, ""))
	if value == "" {
		return ""
	}
	if strings.HasPrefix(value, "{") {
		var obj map[string]string
		if err := json.Unmarshal([]byte(value), &obj); err == nil {
			parts := make([]string, 0, len(obj))
			for name, v := range obj {
				if v = strings.TrimSpace(v); v != "" {
					parts = append(parts, name+"="+v)
				}
			}
			if len(parts) > 0 {
				return strings.Join(parts, "; ")
			}
		}
	}
	if strings.Contains(value, "=") {
		return value
	}
	return "session=" + value
}

// apiUserHeader mirrors the TS helper (New-Api-User header).
func apiUserHeader(cred map[string]string) string {
	return firstNonEmpty(cred, []string{"api_user", "user_id", "userId", "new-api-user"})
}

func (anyrouterTopAdapter) Fetch(cred map[string]string) ([]Row, error) {
	cookie := cookieHeader(cred)
	if cookie == "" {
		return nil, errors.New("missing credential: session（AnyRouter.top 登录 Cookie）")
	}

	base := "https://anyrouter.top"
	if b := strings.TrimSpace(cred["base_url"]); b != "" {
		var err error
		base, err = secureBaseURL("anyrouter.top", b)
		if err != nil {
			return nil, err
		}
	}
	origin := base
	if u, err := url.Parse(base); err == nil && u.Scheme != "" && u.Host != "" {
		origin = u.Scheme + "://" + u.Host
	}
	headers := map[string]string{
		"Cookie":  cookie,
		"Accept":  "application/json, text/plain, */*",
		"Referer": base + "/console/personal",
		"Origin":  origin,
	}
	if apiUser := apiUserHeader(cred); apiUser != "" {
		headers["New-Api-User"] = apiUser
	}

	req, err := http.NewRequest(http.MethodGet, base+"/api/user/self", nil)
	if err != nil {
		return nil, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := HTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	// TS reads the full text (capped at 20k chars) and JSON.parses it after the
	// status check, so a WAF HTML page produces a dedicated error message.
	body, err := io.ReadAll(io.LimitReader(res.Body, 20_000))
	if err != nil {
		return nil, err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		if res.StatusCode == 401 {
			msg := "anyrouter.top: HTTP 401：session Cookie 已过期或无效，请重新登录 anyrouter.top 后更新 session。"
			if detail := truncate(string(body), 200); detail != "" {
				msg += " 原始响应: " + detail
			}
			return nil, errors.New(msg)
		}
		return nil, fmt.Errorf("anyrouter.top: HTTP %d: %s", res.StatusCode, truncate(string(body), 200))
	}

	var parsed struct {
		Success any            `json:"success"`
		Message any            `json:"message"`
		Data    map[string]any `json:"data"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, errors.New("anyrouter.top: /api/user/self 返回了非 JSON 响应，可能被 WAF 拦截；请补充有效的 WAF Cookie 或使用可达的 base_url")
	}
	responseMessage := func() string {
		if s, ok := parsed.Message.(string); ok && strings.TrimSpace(s) != "" {
			return strings.TrimSpace(s)
		}
		return "请求失败"
	}
	if b, ok := parsed.Success.(bool); ok && !b {
		return nil, fmt.Errorf("anyrouter.top: %s", responseMessage())
	}
	if parsed.Data == nil {
		return nil, fmt.Errorf("anyrouter.top: %s（缺少 data）", responseMessage())
	}

	quota := finite(parsed.Data["quota"])
	used := finite(parsed.Data["used_quota"])
	var rows []Row
	if quota != nil {
		rows = append(rows, Row{
			Provider: "anyrouter_top",
			Metric:   "balance_usd",
			Value:    *quota / anyrouterTopQuotaUnitsPerUSD,
			Unit:     strptr("usd"),
		})
	}
	if used != nil {
		rows = append(rows, Row{
			Provider: "anyrouter_top",
			Metric:   "used_usd",
			Value:    *used / anyrouterTopQuotaUnitsPerUSD,
			Unit:     strptr("usd"),
		})
	}
	if len(rows) == 0 {
		return nil, errors.New("anyrouter.top: /api/user/self 没有可用的 quota/used_quota 字段")
	}
	return rows, nil
}
