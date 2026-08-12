package auth

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func makeJWT(claims map[string]any) string {
	head := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none"}`))
	payload, err := json.Marshal(claims)
	if err != nil {
		panic(err)
	}
	return head + "." + base64.RawURLEncoding.EncodeToString(payload) + "."
}

func TestStoreFileFallback(t *testing.T) {
	s := NewStore(t.TempDir())
	s.useKeyring = false // 强制文件回退
	if err := s.SetAccessCookie("jwt-1"); err != nil {
		t.Fatal(err)
	}
	if s.AccessCookie() != "jwt-1" {
		t.Fatal("roundtrip failed")
	}
	if err := s.SetServiceToken("id", "secret"); err != nil {
		t.Fatal(err)
	}
	id, secret, ok := s.ServiceToken()
	if !ok || id != "id" || secret != "secret" {
		t.Fatal("service token roundtrip failed")
	}
	// 文件权限应为 0600
	fi, err := os.Stat(s.filePath(keyAccessCookie))
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("credentials file perms want 0600 got %o", fi.Mode().Perm())
	}
}

func TestAuthHeaders(t *testing.T) {
	s := NewStore(t.TempDir())
	s.useKeyring = false
	s.SetAccessCookie("jwt-1")
	h := s.AuthHeaders()
	if !strings.Contains(h.Get("Cookie"), "CF_Authorization=jwt-1") {
		t.Fatalf("cookie header wrong: %q", h.Get("Cookie"))
	}
	s.ClearAccessCookie()
	s.SetServiceToken("cid", "csecret")
	h = s.AuthHeaders()
	if h.Get("CF-Access-Client-Id") != "cid" || h.Get("CF-Access-Client-Secret") != "csecret" {
		t.Fatalf("service token headers wrong: %v", h)
	}
}

func TestLoopbackCallback(t *testing.T) {
	// 直接测试回调处理：用 httptest 起一个只含 callback 的 server，
	// 验证 Set-Cookie 被提取。
	ln := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.SetCookie(w, &http.Cookie{Name: "CF_Authorization", Value: "the-jwt", Path: "/"})
	}))
	defer ln.Close()

	client := &http.Client{}
	req, _ := http.NewRequest("GET", ln.URL+"/cdn-cgi/access/callback", nil)
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var got string
	for _, c := range resp.Cookies() {
		if c.Name == "CF_Authorization" {
			got = c.Value
		}
	}
	if got != "the-jwt" {
		t.Fatalf("cookie extraction failed: %q", got)
	}
}

func TestLoginURLFormat(t *testing.T) {
	// 与 cloudflared 的 access login URL 格式保持一致
	team, aud := "my-team", "abc123aud"
	callback := "http://127.0.0.1:54321/cdn-cgi/access/callback"
	got := "https://" + team + ".cloudflareaccess.com/cdn-cgi/access/login/" + aud + "?redirect_uri=" + strings.ReplaceAll(callback, ":", "%3A")
	if !strings.Contains(got, "my-team.cloudflareaccess.com/cdn-cgi/access/login/abc123aud") {
		t.Fatalf("login url format wrong: %s", got)
	}
}

func TestJWTExpiryParsing(t *testing.T) {
	jwt := makeJWT(map[string]any{"exp": 9999})
	exp := JwtExpiry(jwt)
	if exp != 9999 {
		t.Fatalf("exp want 9999 got %d", exp)
	}
	if JwtExpiry("not-a-jwt") != 0 {
		t.Fatal("invalid jwt should give 0")
	}
}
