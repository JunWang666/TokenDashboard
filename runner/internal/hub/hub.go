// Package hub 封装与 hub 的通信：拉凭证、上报额度快照。
package hub

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"tokendash/runner/internal/adapter"
)

type Client struct {
	baseURL string
	headers map[string]string // 鉴权头：Access service token 或 dev token
	hc      *http.Client
}

// NewClient 创建 hub 客户端。auth 为鉴权头（如 CF-Access-Client-Id/Secret 或 Authorization）。
func NewClient(baseURL string, auth map[string]string) *Client {
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		headers: auth,
		hc:      &http.Client{Timeout: 30 * time.Second},
	}
}

// Credentials 拉取全部凭证（解密明文）：{ provider: [ { name, ...credFields } ] }。
func (c *Client) Credentials(ctx context.Context) (map[string][]map[string]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/api/v1/internal/credentials", nil)
	if err != nil {
		return nil, err
	}
	var raw map[string][]map[string]any
	if err := c.do(req, &raw); err != nil {
		return nil, fmt.Errorf("hub internal/credentials: %w", err)
	}
	out := make(map[string][]map[string]string, len(raw))
	for provider, keys := range raw {
		for _, k := range keys {
			cred := make(map[string]string, len(k))
			for field, v := range k {
				if s, ok := v.(string); ok && s != "" {
					cred[field] = s
				}
			}
			out[provider] = append(out[provider], cred)
		}
	}
	return out, nil
}

// PostQuota 批量写入额度快照。
func (c *Client) PostQuota(ctx context.Context, rows []adapter.Row) error {
	body, err := json.Marshal(map[string]any{"rows": rows})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/api/v1/ingest/quota", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if err := c.do(req, nil); err != nil {
		return fmt.Errorf("hub ingest/quota: %w", err)
	}
	return nil
}

func (c *Client) do(req *http.Request, out any) error {
	for k, v := range c.headers {
		req.Header.Set(k, v)
	}
	res, err := c.hc.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		snippet := string(body)
		if len(snippet) > 200 {
			snippet = snippet[:200]
		}
		return fmt.Errorf("HTTP %d: %s", res.StatusCode, snippet)
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(body, out)
}
