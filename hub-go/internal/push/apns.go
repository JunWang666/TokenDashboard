package push

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/http2"
)

// apnsTokenTTL is how long a provider JWT is reused before re-signing.
const apnsTokenTTL = 50 * time.Minute

var (
	invalidApnsReasons = map[string]bool{
		"BadDeviceToken":         true,
		"DeviceTokenNotForTopic": true,
		"Unregistered":           true,
	}
	retryableApnsReasons = map[string]bool{
		"ExpiredProviderToken":        true,
		"IdleTimeout":                 true,
		"InvalidProviderToken":        true,
		"MissingProviderToken":        true,
		"Shutdown":                    true,
		"TooManyProviderTokenUpdates": true,
		"TooManyRequests":             true,
	}
)

// APNSSender delivers to iOS devices via the APNs provider API (HTTP/2,
// ES256 provider JWT), mirroring push.ts sendApns/createApnsJwt.
type APNSSender struct {
	key    *ecdsa.PrivateKey
	keyID  string
	teamID string
	client *http.Client

	mu      sync.Mutex
	token   string
	tokenAt time.Time
}

// NewAPNSSender parses the .p8 PEM contents into a PKCS8 P-256 private key.
func NewAPNSSender(p8, keyID, teamID string) (*APNSSender, error) {
	block, _ := pem.Decode([]byte(p8))
	if block == nil {
		return nil, errors.New("APNS_KEY_P8 不是有效的 PEM")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("解析 APNS_KEY_P8: %w", err)
	}
	key, ok := parsed.(*ecdsa.PrivateKey)
	if !ok {
		return nil, errors.New("APNS_KEY_P8 必须是 P-256 (EC) 私钥")
	}
	return &APNSSender{
		key:    key,
		keyID:  keyID,
		teamID: teamID,
		// A direct http2.Transport speaks HTTP/2 over TLS without ALPN
		// negotiation issues; APNs requires HTTP/2.
		client: &http.Client{Transport: &http2.Transport{}, Timeout: 30 * time.Second},
	}, nil
}

// providerToken returns a cached ES256 JWT (header alg/kid, claims iss/iat),
// re-signing at most once per apnsTokenTTL.
func (a *APNSSender) providerToken() (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.token != "" && time.Since(a.tokenAt) < apnsTokenTTL {
		return a.token, nil
	}
	header := b64urlEncode([]byte(fmt.Sprintf(`{"alg":"ES256","kid":%q}`, a.keyID)))
	claims := b64urlEncode([]byte(fmt.Sprintf(`{"iss":%q,"iat":%d}`, a.teamID, time.Now().Unix())))
	unsigned := header + "." + claims
	sig, err := signES256(a.key, []byte(unsigned))
	if err != nil {
		return "", err
	}
	a.token = unsigned + "." + b64urlEncode(sig)
	a.tokenAt = time.Now()
	return a.token, nil
}

// apnsHostForEnvironment mirrors push.ts: an explicit "sandbox" (or legacy
// default when the environment is unset/unknown) selects the sandbox host.
func apnsHostForEnvironment(environment string, legacySandboxDefault bool) string {
	sandbox := environment == "sandbox" || (environment != "production" && legacySandboxDefault)
	if sandbox {
		return "https://api.sandbox.push.apple.com"
	}
	return "https://api.push.apple.com"
}

// sendAPNS mirrors push.ts sendApns, including reason-based classification.
func (s *Sender) sendAPNS(ctx context.Context, sub Subscription, payload Payload) SendResult {
	if s.apns == nil {
		return failedResult("APNS_KEY_P8/APNS_KEY_ID/APNS_TEAM_ID 未配置", withRetryable)
	}
	token, err := s.apns.providerToken()
	if err != nil {
		return failedResult("APNs provider token 生成失败: "+bounded(err.Error()), withRetryable)
	}

	body, _ := json.Marshal(map[string]any{
		"aps": map[string]any{
			"alert": payload,
			"sound": "default",
		},
	})
	host := apnsHostForEnvironment(sub.Environment, s.sandboxDefault)
	req, err := http.NewRequest(http.MethodPost, host+"/3/device/"+sub.Endpoint, bytes.NewReader(body))
	if err != nil {
		return failedResult("APNs 请求构造失败: "+bounded(err.Error()), withRetryable)
	}
	req = req.WithContext(ctx)
	req.Header.Set("authorization", "bearer "+token)
	req.Header.Set("content-type", "application/json")
	req.Header.Set("apns-topic", apnsTopic)
	req.Header.Set("apns-push-type", "alert")
	req.Header.Set("apns-priority", "10")
	req.Header.Set("apns-expiration", "0")

	resp, err := s.apns.client.Do(req)
	if err != nil {
		return failedResult("APNs 网络错误："+safeError(err, sub.Endpoint), withRetryable)
	}
	defer resp.Body.Close()
	messageID := resp.Header.Get("apns-id")
	if resp.StatusCode >= 200 && resp.StatusCode <= 299 {
		return sentResult(resp.StatusCode, messageID)
	}

	detailBytes, _ := io.ReadAll(io.LimitReader(resp.Body, resultTruncateLen))
	detail := strings.TrimSpace(string(detailBytes))
	var reason string
	var parsed struct {
		Reason string `json:"reason"`
	}
	if json.Unmarshal(detailBytes, &parsed) == nil {
		reason = parsed.Reason
	}
	invalid := resp.StatusCode == http.StatusGone || invalidApnsReasons[reason]
	retryable := retryableApnsReasons[reason] ||
		resp.StatusCode == http.StatusRequestTimeout ||
		resp.StatusCode == http.StatusTooManyRequests ||
		resp.StatusCode >= 500
	reasonText := fmt.Sprintf("APNs HTTP %d", resp.StatusCode)
	switch {
	case reason != "":
		reasonText += ": " + reason
	case detail != "":
		reasonText += ": " + bounded(detail)
	}
	return failedResult(reasonText, func(r *SendResult) {
		r.Status = &resp.StatusCode
		r.InvalidSubscription = invalid
		r.Retryable = retryable
		if messageID != "" {
			r.ProviderMessageID = &messageID
		}
	})
}
