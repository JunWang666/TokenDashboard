// Package adapter 定义各服务商额度采集适配器。
package adapter

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Row 归一化的额度快照行，与 hub 的 quota_snapshots 表对应。
type Row struct {
	Provider   string   `json:"provider"`
	Metric     string   `json:"metric"`
	Account    string   `json:"account,omitempty"` // 凭证名（多 key 场景）
	Value      float64  `json:"value"`
	LimitValue *float64 `json:"limit_value"`
	Unit       *string  `json:"unit"`
	ResetAt    *string  `json:"reset_at"`
}

// Adapter 拉取一个服务商的额度快照。cred 来自 hub credentials 表（解密后的 JSON 对象）。
type Adapter interface {
	Provider() string
	Fetch(cred map[string]string) ([]Row, error)
}

var registry = map[string]Adapter{
	"kimi":  kimiAdapter{},
	"codex": codexAdapter{},
}

// Lookup 返回 provider 对应的适配器，未实现返回 nil。
func Lookup(provider string) Adapter { return registry[provider] }

// Providers 返回已实现的 provider 列表。
func Providers() []string {
	out := make([]string, 0, len(registry))
	for p := range registry {
		out = append(out, p)
	}
	sort.Strings(out)
	return out
}

// Run 执行单个适配器；整体失败转为 scrape_error 行（web 端整卡报红）。
// 部分指标失败时适配器应返回成功行 + scrape_warn 行（web 端显示数据并带警告），而不是返回 error。
func Run(provider string, cred map[string]string) []Row {
	a := registry[provider]
	if a == nil {
		return nil
	}
	rows, err := a.Fetch(cred)
	if err != nil {
		return []Row{{
			Provider: provider,
			Metric:   "scrape_error",
			Value:    1,
			Unit:     strptr("error"),
			ResetAt:  strptr(truncate(err.Error(), 500)),
		}}
	}
	return rows
}

// HTTPClient 适配器共用的 HTTP 客户端（测试可替换）。
var HTTPClient = &http.Client{Timeout: 30 * time.Second}

// getJSON 发 GET 请求并解析 JSON；非 2xx 返回带响应体片段的错误（便于诊断 WAF 拦截）。
func getJSON(url string, headers map[string]string, out any) error {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	return doJSON(req, headers, out)
}

// postJSON 发 POST JSON 请求并解析响应。
func postJSON(url string, headers map[string]string, body any, out any) error {
	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	if headers == nil {
		headers = map[string]string{}
	}
	headers["Content-Type"] = "application/json"
	return doJSON(req, headers, out)
}

func doJSON(req *http.Request, headers map[string]string, out any) error {
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := HTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("HTTP %d: %s", res.StatusCode, truncate(string(body), 200))
	}
	return json.Unmarshal(body, out)
}

// num 宽松解析字符串或数字形态的数值（部分接口数字以 JSON 字符串返回）。
func num(v any) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case string:
		n, _ := strconv.ParseFloat(strings.TrimSpace(t), 64)
		return n
	default:
		return 0
	}
}

func strptr(s string) *string { return &s }

func strptrOrNil(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func fptr(f float64) *float64 { return &f }

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
