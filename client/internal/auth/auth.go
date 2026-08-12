// Package auth 处理 hub 访问凭证：
//   - 用户身份：loopback 浏览器授权拿到的 CF_Authorization JWT（存系统钥匙串）
//   - 备选：service token（CF-Access-Client-Id/Secret）
// 无钥匙串环境（headless Linux）回退到配置文件目录下的 credentials 文件（0600）。
package auth

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/zalando/go-keyring"
)

const keyringService = "tokendash"

const (
	keyAccessCookie = "access_cookie" // CF_Authorization JWT
	keyClientID     = "service_token_id"
	keyClientSecret = "service_token_secret"
)

// Store 凭证存取。
type Store struct {
	fallbackDir string // 无钥匙串时回退目录
	useKeyring  bool
}

func NewStore(fallbackDir string) *Store {
	return &Store{fallbackDir: fallbackDir, useKeyring: true}
}

func (s *Store) key(k string) string { return "tokendash/" + k }

func (s *Store) get(k string) (string, error) {
	if s.useKeyring {
		v, err := keyring.Get(keyringService, s.key(k))
		if err == nil {
			return v, nil
		}
		if !errors.Is(err, keyring.ErrNotFound) {
			s.useKeyring = false // 钥匙串不可用，回退文件
		}
	}
	return s.fileGet(k)
}

func (s *Store) set(k, v string) error {
	if s.useKeyring {
		if err := keyring.Set(keyringService, s.key(k), v); err == nil {
			return nil
		} else {
			s.useKeyring = false
		}
	}
	return s.fileSet(k, v)
}

func (s *Store) delete(k string) error {
	if s.useKeyring {
		if err := keyring.Delete(keyringService, s.key(k)); err != nil && !errors.Is(err, keyring.ErrNotFound) {
			s.useKeyring = false
		} else if err == nil {
			return nil
		}
	}
	return s.fileDelete(k)
}

func (s *Store) filePath(k string) string {
	return filepath.Join(s.fallbackDir, strings.ReplaceAll(s.key(k), "/", "_"))
}

func (s *Store) fileGet(k string) (string, error) {
	b, err := os.ReadFile(s.filePath(k))
	if err != nil {
		return "", keyring.ErrNotFound
	}
	return strings.TrimSpace(string(b)), nil
}

func (s *Store) fileSet(k, v string) error {
	if err := os.MkdirAll(s.fallbackDir, 0o755); err != nil {
		return err
	}
	return os.WriteFile(s.filePath(k), []byte(v), 0o600)
}

func (s *Store) fileDelete(k string) error {
	err := os.Remove(s.filePath(k))
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// AccessCookie 返回用户身份 JWT（可能为空）。
func (s *Store) AccessCookie() string {
	v, err := s.get(keyAccessCookie)
	if err != nil {
		return ""
	}
	return v
}

func (s *Store) SetAccessCookie(jwt string) error { return s.set(keyAccessCookie, jwt) }
func (s *Store) ClearAccessCookie() error         { return s.delete(keyAccessCookie) }

// ServiceToken 返回可选 service token。
func (s *Store) ServiceToken() (id, secret string, ok bool) {
	a, err1 := s.get(keyClientID)
	b, err2 := s.get(keyClientSecret)
	if err1 == nil && err2 == nil {
		return a, b, true
	}
	return "", "", false
}

func (s *Store) SetServiceToken(id, secret string) error {
	if err := s.set(keyClientID, id); err != nil {
		return err
	}
	return s.set(keyClientSecret, secret)
}

// AuthHeaders 返回访问 hub 所需的请求头。
// 优先 service token（Runner 约定），否则带用户 cookie。
func (s *Store) AuthHeaders() http.Header {
	h := http.Header{}
	if id, secret, ok := s.ServiceToken(); ok {
		h.Set("CF-Access-Client-Id", id)
		h.Set("CF-Access-Client-Secret", secret)
	} else if c := s.AccessCookie(); c != "" {
		h.Set("Cookie", "CF_Authorization="+c)
	}
	return h
}

func (s *Store) HasAuth() bool {
	return s.AccessCookie() != "" || func() bool { _, _, ok := s.ServiceToken(); return ok }()
}

// LoginResult 描述登录状态。
type LoginResult struct {
	OK      bool   `json:"ok"`
	Message string `json:"message"`
	Expires time.Time `json:"expires,omitempty"`
	URL     string `json:"url,omitempty"` // 已打开的登录页
}

// LoopbackLogin 启动一次性 localhost 回调，打开浏览器完成 Access 授权。
// team 形如 "my-team"，aud 为 hub Access App 的 AUD；sessionDuration 用于预估到期时间。
func (s *Store) LoopbackLogin(team, aud string) (*LoginResult, error) {
	if team == "" || aud == "" {
		return nil, errors.New("需要 access_team 与 access_aud（config.toml 或 --team/--aud）")
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	port := ln.Addr().(*net.TCPAddr).Port
	callback := fmt.Sprintf("http://127.0.0.1:%d/cdn-cgi/access/callback", port)

	tokenCh := make(chan string, 1)
	errCh := make(chan error, 1)

	mux := http.NewServeMux()
	mux.HandleFunc("/cdn-cgi/access/callback", func(w http.ResponseWriter, r *http.Request) {
		for _, c := range r.Cookies() {
			if c.Name == "CF_Authorization" {
				tokenCh <- c.Value
			}
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, "<html><body style='font-family:sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh'>登录成功，可以关闭此页面，回到 tokendash。</body></html>")
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// Access 可能重定向到 callback 的其他路径
		http.Redirect(w, r, callback, http.StatusFound)
	})

	srv := &http.Server{Handler: mux}
	go func() {
		errCh <- srv.Serve(ln)
	}()

	loginURL := fmt.Sprintf("https://%s.cloudflareaccess.com/cdn-cgi/access/login/%s?redirect_uri=%s",
		url.QueryEscape(team), aud, url.QueryEscape(callback))

	if err := openBrowser(loginURL); err != nil {
		return nil, fmt.Errorf("打开浏览器失败（可手动访问登录页）：%w", err)
	}

	select {
	case tok := <-tokenCh:
		if tok == "" {
			srv.Close()
			return nil, errors.New("回调中未收到 CF_Authorization cookie")
		}
		if err := s.SetAccessCookie(tok); err != nil {
			srv.Close()
			return nil, err
		}
		srv.Close()
		return &LoginResult{OK: true, Message: "已保存登录态", URL: loginURL}, nil
	case err := <-errCh:
		return nil, err
	case <-time.After(5 * time.Minute):
		srv.Close()
		return nil, errors.New("等待浏览器登录超时")
	}
}

// openBrowser 尝试打开系统浏览器（多平台备选）。
func openBrowser(rawURL string) error {
	cmd, args := browserCommand()
	if cmd == "" {
		return errors.New("无法确定浏览器命令")
	}
	p := newProc(cmd, args...)
	return p.start(rawURL)
}

// randomHex 用于生成 state 之类（预留）。
func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// JwtExpiry 粗略解析 JWT exp（不验签，仅展示用）。解析失败返回 0。
func JwtExpiry(token string) int64 {
	parts := splitN(token, ".", 3)
	if len(parts) != 3 {
		return 0
	}
	payload := parts[1]
	if pad := len(payload) % 4; pad != 0 {
		payload += "===="[:4-pad]
	}
	raw, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		return 0
	}
	var claims struct {
		Exp int64 `json:"exp"`
	}
	if err := json.Unmarshal(raw, &claims); err != nil {
		return 0
	}
	return claims.Exp
}

func splitN(s, sep string, n int) []string {
	var out []string
	start := 0
	for i := 0; i < len(s) && len(out) < n-1; i++ {
		if s[i] == sep[0] {
			out = append(out, s[start:i])
			start = i + 1
		}
	}
	out = append(out, s[start:])
	return out
}
