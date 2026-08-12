// Package upload 与 hub 通信：批量上报用量、心跳、凭证推送。
// 自动携带 Access 认证头（用户 cookie 或 service token）与重试。
package upload

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"tokendash/client/internal/aggregate"
	"tokendash/client/internal/auth"
	"tokendash/client/internal/config"
)

const maxAttempts = 3

type Client struct {
	BaseURL    string
	DeviceName string
	Auth       *auth.Store
	HTTP       *http.Client
}

func New(cfg *config.Config, authStore *auth.Store) *Client {
	return &Client{
		BaseURL:    cfg.HubURL,
		DeviceName: cfg.DeviceName,
		Auth:       authStore,
		HTTP:       &http.Client{Timeout: 20 * time.Second},
	}
}

func (c *Client) newRequest(method, path string, body io.Reader) (*http.Request, error) {
	req, err := http.NewRequest(method, c.BaseURL+path, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "tokendash-client")
	req.Header.Set("X-Client-Device", c.DeviceName)
	for k, vs := range c.Auth.AuthHeaders() {
		req.Header[k] = vs
	}
	return req, nil
}

// do 带退避重试：网络错误与 5xx 都会重试；4xx 立即返回。
func (c *Client) do(method, path string, body []byte) (*http.Response, error) {
	var lastErr error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		req, err := c.newRequest(method, path, bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := c.HTTP.Do(req)
		if err != nil {
			lastErr = err
		} else if resp.StatusCode < 500 {
			return resp, nil
		} else {
			lastErr = fmt.Errorf("%s %s: HTTP %d", method, path, resp.StatusCode)
			resp.Body.Close()
		}
		if attempt < maxAttempts {
			time.Sleep(time.Duration(attempt) * time.Second)
		}
	}
	return nil, lastErr
}

// IngestUsage 批量上报聚合行，返回接收行数。
func (c *Client) IngestUsage(rows []aggregate.Row) (int, error) {
	if len(rows) == 0 {
		return 0, nil
	}
	payload := struct {
		DeviceID string           `json:"device_id"`
		Rows     []aggregate.Row  `json:"rows"`
	}{DeviceID: c.DeviceName, Rows: rows}
	body, err := json.Marshal(payload)
	if err != nil {
		return 0, err
	}
	resp, err := c.do("POST", "/api/v1/ingest/usage", body)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized {
		return 0, ErrUnauthorized
	}
	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("ingest usage: HTTP %d", resp.StatusCode)
	}
	var out struct {
		Rows int `json:"rows"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return len(rows), nil
	}
	return out.Rows, nil
}

// Heartbeat 上报设备心跳（幂等 upsert）。
func (c *Client) Heartbeat() error {
	resp, err := c.do("POST", "/api/v1/ingest/usage", []byte(fmt.Sprintf(
		`{"device_id":%q,"rows":[]}`, c.DeviceName)))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("heartbeat: HTTP %d", resp.StatusCode)
	}
	return nil
}

// PushCredential 把本机凭证推送到 hub（明文仅经 TLS 传输，hub 加密存储）。
func (c *Client) PushCredential(provider string, payload any) error {
	body, err := json.Marshal(struct {
		Payload any `json:"payload"`
	}{Payload: payload})
	if err != nil {
		return err
	}
	resp, err := c.do("PUT", "/api/v1/credentials/"+provider, body)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("push credential: HTTP %d", resp.StatusCode)
	}
	return nil
}

// FetchQuota 拉取额度快照（客户端 UI 展示用）。
func (c *Client) FetchQuota() ([]byte, error) {
	resp, err := c.do("GET", "/api/v1/quota/current", nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("quota: HTTP %d", resp.StatusCode)
	}
	return io.ReadAll(resp.Body)
}

var ErrUnauthorized = fmt.Errorf("unauthorized: 登录态失效，请重新登录")
