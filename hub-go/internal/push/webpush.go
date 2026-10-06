package push

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"strings"
	"time"

	"golang.org/x/crypto/hkdf"
)

// recordSize is the RFC 8291 rs value; payloads are sent as a single record.
const recordSize = 4096

// WebSender holds the VAPID configuration (RFC 8292) for web push.
type WebSender struct {
	PublicKey  string // base64url, 65-byte uncompressed P-256 point
	PrivateKey string // base64url scalar d
	Subject    string // VAPID_SUBJECT (mailto: or https:)
}

// b64url decodes base64url input, adding padding like webPush.ts base64UrlDecode.
func b64url(value string) ([]byte, error) {
	normalized := strings.ReplaceAll(strings.ReplaceAll(value, "-", "+"), "_", "/")
	switch len(normalized) % 4 {
	case 0:
	case 2:
		normalized += "=="
	case 3:
		normalized += "="
	default:
		return nil, fmt.Errorf("bad base64url length")
	}
	return base64.StdEncoding.DecodeString(normalized)
}

func b64urlEncode(b []byte) string {
	return base64.RawURLEncoding.EncodeToString(b)
}

func validatePublicKey(key []byte, label string) error {
	if len(key) != 65 || key[0] != 0x04 {
		return fmt.Errorf("%s 必须是 65 字节的 P-256 未压缩公钥", label)
	}
	return nil
}

// hkdfSHA256 derives byteLength bytes via HKDF-SHA256 (equivalent to the
// Web Crypto deriveBits HKDF used by webPush.ts).
func hkdfSHA256(secret, salt, info []byte, byteLength int) ([]byte, error) {
	r := hkdf.New(sha256.New, secret, salt, info)
	out := make([]byte, byteLength)
	if _, err := io.ReadFull(r, out); err != nil {
		return nil, err
	}
	return out, nil
}

func concat(parts ...[]byte) []byte {
	out := make([]byte, 0)
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}

// signES256 signs data with ECDSA P-256/SHA-256 and returns the raw R||S
// signature (64 bytes) required by JWS.
func signES256(key *ecdsa.PrivateKey, data []byte) ([]byte, error) {
	digest := sha256.Sum256(data)
	r, s, err := ecdsa.Sign(rand.Reader, key, digest[:])
	if err != nil {
		return nil, err
	}
	return concat(pad32(r.Bytes()), pad32(s.Bytes())), nil
}

// vapidPrivateKey reconstructs the ECDSA P-256 private key from the config
// pair (65-byte uncompressed public point + base64url scalar), as in
// webPush.ts vapidPrivateJwk.
func (w *WebSender) vapidPrivateKey() (*ecdsa.PrivateKey, error) {
	pub, err := b64url(w.PublicKey)
	if err != nil || validatePublicKey(pub, "VAPID_PUBLIC_KEY") != nil {
		return nil, fmt.Errorf("VAPID_PUBLIC_KEY 必须是 65 字节的 P-256 未压缩公钥")
	}
	dBytes, err := b64url(w.PrivateKey)
	if err != nil {
		return nil, fmt.Errorf("VAPID_PRIVATE_KEY base64url 解码失败: %w", err)
	}
	key := &ecdsa.PrivateKey{
		PublicKey: ecdsa.PublicKey{Curve: elliptic.P256(), X: new(big.Int).SetBytes(pub[1:33]), Y: new(big.Int).SetBytes(pub[33:65])},
		D:         new(big.Int).SetBytes(dBytes),
	}
	if !key.IsOnCurve(key.X, key.Y) {
		return nil, errors.New("VAPID 公私钥不匹配")
	}
	return key, nil
}

// createVapidJWT builds the ES256 JWT from RFC 8292: aud = endpoint origin,
// exp = now + 12h, sub = VAPID_SUBJECT. Header byte order matches webPush.ts.
func (w *WebSender) createVapidJWT(endpoint string, key *ecdsa.PrivateKey, now time.Time) (string, error) {
	u, err := url.Parse(endpoint)
	if err != nil {
		return "", err
	}
	header := b64urlEncode([]byte(`{"typ":"JWT","alg":"ES256"}`))
	claims := b64urlEncode([]byte(fmt.Sprintf(`{"aud":%q,"exp":%d,"sub":%q}`,
		u.Scheme+"://"+u.Host, now.Unix()+12*60*60, w.Subject)))
	unsigned := header + "." + claims
	sig, err := signES256(key, []byte(unsigned))
	if err != nil {
		return "", err
	}
	return unsigned + "." + b64urlEncode(sig), nil
}

func pad32(b []byte) []byte {
	if len(b) >= 32 {
		return b
	}
	out := make([]byte, 32)
	copy(out[32-len(b):], b)
	return out
}

// buildRequest produces a standards-compliant aes128gcm POST request per
// RFC 8291, mirroring webPush.ts buildWebPushRequest.
func (w *WebSender) buildRequest(sub Subscription, payload []byte, ttl int, now time.Time) (*http.Request, error) {
	endpointURL, err := url.Parse(sub.Endpoint)
	if err != nil || endpointURL.Scheme != "https" {
		return nil, errors.New("Web Push endpoint 必须使用 HTTPS")
	}

	var keys struct {
		P256dh string `json:"p256dh"`
		Auth   string `json:"auth"`
	}
	if sub.KeysJSON == nil {
		return nil, errors.New("Web Push 订阅缺少 p256dh/auth")
	}
	if err := json.Unmarshal([]byte(*sub.KeysJSON), &keys); err != nil {
		return nil, fmt.Errorf("Web Push 订阅密钥不是有效 JSON: %w", err)
	}
	if keys.P256dh == "" || keys.Auth == "" {
		return nil, errors.New("Web Push 订阅缺少 p256dh/auth")
	}
	userPublicKey, err := b64url(keys.P256dh)
	if err != nil || validatePublicKey(userPublicKey, "p256dh") != nil {
		return nil, errors.New("p256dh 必须是 65 字节的 P-256 未压缩公钥")
	}
	authSecret, err := b64url(keys.Auth)
	if err != nil || len(authSecret) != 16 {
		return nil, errors.New("auth secret 必须是 16 字节")
	}

	ephemeral, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	ephemeralPublic := ephemeral.PublicKey().Bytes()
	if err := validatePublicKey(ephemeralPublic, "临时服务端公钥"); err != nil {
		return nil, err
	}
	userKey, err := ecdh.P256().NewPublicKey(userPublicKey)
	if err != nil {
		return nil, err
	}
	sharedSecret, err := ephemeral.ECDH(userKey)
	if err != nil {
		return nil, err
	}

	keyInfo := concat([]byte("WebPush: info"), []byte{0}, userPublicKey, ephemeralPublic)
	inputKeyMaterial, err := hkdfSHA256(sharedSecret, authSecret, keyInfo, 32)
	if err != nil {
		return nil, err
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return nil, err
	}
	contentEncryptionKey, err := hkdfSHA256(inputKeyMaterial, salt,
		concat([]byte("Content-Encoding: aes128gcm"), []byte{0}), 16)
	if err != nil {
		return nil, err
	}
	nonce, err := hkdfSHA256(inputKeyMaterial, salt,
		concat([]byte("Content-Encoding: nonce"), []byte{0}), 12)
	if err != nil {
		return nil, err
	}

	// RFC 8188 final-record delimiter 0x02 is part of the plaintext.
	plaintext := append(append([]byte{}, payload...), 0x02)
	if len(plaintext)+16 > recordSize {
		return nil, errors.New("Web Push payload 超过单条记录上限")
	}
	block, err := aes.NewCipher(contentEncryptionKey)
	if err != nil {
		return nil, err
	}
	aesgcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	ciphertext := aesgcm.Seal(nil, nonce, plaintext, nil)

	// aes128gcm body header: salt || rs(uint32be) || keyid length || ephemeral key.
	header := make([]byte, 0, 16+4+1+len(ephemeralPublic))
	header = append(header, salt...)
	var rs [4]byte
	binary.BigEndian.PutUint32(rs[:], recordSize)
	header = append(header, rs[:]...)
	header = append(header, byte(len(ephemeralPublic)))
	header = append(header, ephemeralPublic...)
	body := append(header, ciphertext...)

	vapidKey, err := w.vapidPrivateKey()
	if err != nil {
		return nil, err
	}
	jwt, err := w.createVapidJWT(sub.Endpoint, vapidKey, now)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequest(http.MethodPost, sub.Endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", fmt.Sprintf("vapid t=%s, k=%s", jwt, w.PublicKey))
	req.Header.Set("Content-Encoding", "aes128gcm")
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("TTL", fmt.Sprint(ttl))
	req.Header.Set("Urgency", "normal")
	return req, nil
}

// sendWeb mirrors push.ts sendWeb, including the result classification:
// 404/410 → invalid subscription, 408/429/5xx → retryable, rest → failed.
func (s *Sender) sendWeb(ctx context.Context, sub Subscription, payload Payload) SendResult {
	if s.web == nil {
		return failedResult("VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY/VAPID_SUBJECT 未配置", withRetryable)
	}
	req, err := s.web.buildRequest(sub, []byte(marshalPayload(payload)), 3600, time.Now())
	if err != nil {
		reason := safeError(err, sub.Endpoint)
		invalid := strings.Contains(reason, "p256dh") || strings.Contains(reason, "auth secret") || strings.Contains(reason, "订阅")
		return failedResult("Web Push 请求构造失败："+reason, func(r *SendResult) {
			r.InvalidSubscription = invalid
			r.Retryable = !invalid
		})
	}
	resp, err := s.httpClient.Do(req.WithContext(ctx))
	if err != nil {
		return failedResult("Web Push 网络错误："+safeError(err, sub.Endpoint), withRetryable)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 200 && resp.StatusCode <= 299 {
		return sentResult(resp.StatusCode, resp.Header.Get("Location"))
	}
	detail, _ := io.ReadAll(io.LimitReader(resp.Body, resultTruncateLen))
	invalid := resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone
	retryable := resp.StatusCode == http.StatusRequestTimeout || resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500
	reason := fmt.Sprintf("Web Push HTTP %d", resp.StatusCode)
	if trimmed := strings.TrimSpace(string(detail)); trimmed != "" {
		reason += ": " + bounded(trimmed)
	}
	return failedResult(reason, func(r *SendResult) {
		r.Status = &resp.StatusCode
		r.InvalidSubscription = invalid
		r.Retryable = retryable
	})
}

// marshalPayload encodes {title, body} exactly like JSON.stringify(payload).
func marshalPayload(p Payload) string {
	b, _ := json.Marshal(p)
	return string(b)
}
