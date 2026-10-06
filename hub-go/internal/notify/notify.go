// Package notify fans alert events out to third-party channels (Feishu
// custom-bot webhook and Bark), mirroring cloudflare-hub's notify.ts.
// Configuration lives in the settings table; secrets are stored encrypted
// with the hub credential key.
package notify

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"tokendash/hub/internal/alerts"
	"tokendash/hub/internal/crypto"
)

// Settings table keys, mirroring notify.ts.
const (
	KeyFeishuURL    = "feishu_webhook_url"
	KeyFeishuSecret = "feishu_webhook_secret" // 加密存储（机器人签名校验密钥，可选）
	KeyBarkServer   = "bark_server"
	KeyBarkKey      = "bark_key" // 加密存储（设备 key）
)

const notifyTimeout = 10 * time.Second

// Config is the decrypted channel configuration; a nil channel is unconfigured.
type Config struct {
	Feishu *FeishuChannel
	Bark   *BarkChannel
}

type FeishuChannel struct {
	URL    string
	Secret string // empty when the bot has no sign secret
}

type BarkChannel struct {
	Server string
	Key    string
}

// ReadState loads the four raw settings values (without decrypting), used by
// the GET/PUT handlers which must not return secrets.
func ReadState(ctx context.Context, db *sql.DB) (map[string]string, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT key, value FROM settings WHERE key IN (?, ?, ?, ?)`,
		KeyFeishuURL, KeyFeishuSecret, KeyBarkServer, KeyBarkKey)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		out[k] = v
	}
	return out, rows.Err()
}

// ReadConfig decrypts the stored secrets, mirroring notify.ts readNotifyConfig.
func ReadConfig(ctx context.Context, db *sql.DB, crypt *crypto.Crypto) (*Config, error) {
	raw, err := ReadState(ctx, db)
	if err != nil {
		return nil, err
	}
	cfg := &Config{}
	if url := raw[KeyFeishuURL]; url != "" {
		ch := &FeishuChannel{URL: url}
		if enc := raw[KeyFeishuSecret]; enc != "" {
			secret, err := crypt.Decrypt(enc)
			if err != nil {
				return nil, fmt.Errorf("decrypt feishu secret: %w", err)
			}
			ch.Secret = string(secret)
		}
		cfg.Feishu = ch
	}
	if server, keyEnc := raw[KeyBarkServer], raw[KeyBarkKey]; server != "" && keyEnc != "" {
		key, err := crypt.Decrypt(keyEnc)
		if err != nil {
			return nil, fmt.Errorf("decrypt bark key: %w", err)
		}
		cfg.Bark = &BarkChannel{Server: server, Key: string(key)}
	}
	return cfg, nil
}

// feishuSign mirrors notify.ts feishuSign:
// HmacSHA256(key = "{timestamp}\n{secret}", data = "") in base64.
func feishuSign(secret, timestamp string) string {
	mac := hmac.New(sha256.New, []byte(timestamp+"\n"+secret))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

type webhookClient interface {
	Do(*http.Request) (*http.Response, error)
}

func sendFeishu(ctx context.Context, client webhookClient, ch *FeishuChannel, ev alerts.Event) error {
	payload := map[string]any{
		"msg_type": "text",
		"content":  map[string]any{"text": ev.Title + "\n" + ev.Body},
	}
	if ch.Secret != "" {
		timestamp := fmt.Sprint(time.Now().Unix())
		payload["timestamp"] = timestamp
		payload["sign"] = feishuSign(ch.Secret, timestamp)
	}
	body, _ := json.Marshal(payload)
	ctx, cancel := context.WithTimeout(ctx, notifyTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, ch.URL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("content-type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	var parsed struct {
		Code       int `json:"code"`
		StatusCode int `json:"StatusCode"`
		Msg        string
	}
	_ = json.Unmarshal(data, &parsed)
	if resp.StatusCode < 200 || resp.StatusCode > 299 ||
		(len(data) > 0 && parsed.Code != 0 && parsed.StatusCode != 0) {
		return fmt.Errorf("feishu webhook: HTTP %d %s", resp.StatusCode, parsed.Msg)
	}
	return nil
}

func sendBark(ctx context.Context, client webhookClient, ch *BarkChannel, ev alerts.Event) error {
	url := strings.TrimRight(ch.Server, "/") + "/" + ch.Key
	body, _ := json.Marshal(map[string]any{
		"title": ev.Title,
		"body":  ev.Body,
		"group": "TokenDashboard",
	})
	ctx, cancel := context.WithTimeout(ctx, notifyTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("content-type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	var parsed struct {
		Code    int
		Message string
	}
	_ = json.Unmarshal(data, &parsed)
	if resp.StatusCode < 200 || resp.StatusCode > 299 ||
		(len(data) > 0 && parsed.Code != 200) {
		return fmt.Errorf("bark: HTTP %d %s", resp.StatusCode, parsed.Message)
	}
	return nil
}

// Dispatch sends every event to every configured channel. A single channel
// failure is logged, never propagated (notify.ts dispatchNotify).
func Dispatch(ctx context.Context, db *sql.DB, crypt *crypto.Crypto, log *slog.Logger, events []alerts.Event) {
	if len(events) == 0 {
		return
	}
	cfg, err := ReadConfig(ctx, db, crypt)
	if err != nil {
		if log != nil {
			log.Error("notify read config failed", "err", err)
		}
		return
	}
	if cfg.Feishu == nil && cfg.Bark == nil {
		return
	}
	client := &http.Client{Timeout: notifyTimeout}
	for _, ev := range events {
		if cfg.Feishu != nil {
			if err := sendFeishu(ctx, client, cfg.Feishu, ev); err != nil && log != nil {
				log.Error("notify feishu failed", "err", err)
			}
		}
		if cfg.Bark != nil {
			if err := sendBark(ctx, client, cfg.Bark, ev); err != nil && log != nil {
				log.Error("notify bark failed", "err", err)
			}
		}
	}
}
