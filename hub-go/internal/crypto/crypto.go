// Package crypto implements AES-256-GCM encryption compatible with the
// TypeScript hub's crypto.ts.
package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"sort"
)

// Crypto encrypts and decrypts credential payloads with AES-256-GCM.
type Crypto struct {
	aead cipher.AEAD
}

// New decodes the base64-encoded 32-byte key and prepares the AEAD.
func New(keyB64 string) (*Crypto, error) {
	raw, err := base64.StdEncoding.DecodeString(keyB64)
	if err != nil {
		return nil, fmt.Errorf("decode key: %w", err)
	}
	if len(raw) != 32 {
		return nil, errors.New("CREDENTIALS_KEY must be 32 bytes base64 encoded")
	}
	block, err := aes.NewCipher(raw)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Crypto{aead: aead}, nil
}

// Encrypt returns base64(nonce(12B) ‖ ciphertext ‖ tag(16B)).
func (c *Crypto) Encrypt(plaintext []byte) (string, error) {
	nonce := make([]byte, c.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	out := c.aead.Seal(nonce, nonce, plaintext, nil)
	return base64.StdEncoding.EncodeToString(out), nil
}

// Decrypt reverses Encrypt. The input must be base64(nonce ‖ ciphertext ‖ tag).
func (c *Crypto) Decrypt(payloadB64 string) ([]byte, error) {
	data, err := base64.StdEncoding.DecodeString(payloadB64)
	if err != nil {
		return nil, fmt.Errorf("decode payload: %w", err)
	}
	if len(data) <= c.aead.NonceSize() {
		return nil, errors.New("bad encrypted payload")
	}
	nonce, ct := data[:c.aead.NonceSize()], data[c.aead.NonceSize():]
	return c.aead.Open(nil, nonce, ct, nil)
}

// Hint returns the last 4 characters of the longest string value in payload,
// prefixed with "...". It mirrors crypto.ts credentialHint.
func (c *Crypto) Hint(payload map[string]any) string {
	secret := longestString(payload)
	if len(secret) > 4 {
		secret = secret[len(secret)-4:]
	}
	return "..." + secret
}

// longestString mirrors crypto.ts extractSecret for object payloads.
func longestString(payload map[string]any) string {
	vals := make([]string, 0, len(payload))
	for _, v := range payload {
		if s, ok := v.(string); ok {
			vals = append(vals, s)
		}
	}
	if len(vals) == 0 {
		return ""
	}
	sort.Slice(vals, func(i, j int) bool { return len(vals[i]) > len(vals[j]) })
	return vals[0]
}
