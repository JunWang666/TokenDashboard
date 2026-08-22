package adapter

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// serve 起 httptest 服务器返回固定 JSON，并断言 Authorization 头。
func serve(t *testing.T, wantAuth string, status int, payload any) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != wantAuth {
			t.Errorf("Authorization = %q, want %q", got, wantAuth)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		switch p := payload.(type) {
		case string:
			_, _ = w.Write([]byte(p))
		default:
			_ = json.NewEncoder(w).Encode(p)
		}
	}))
}

func findRow(rows []Row, metric string) *Row {
	for i := range rows {
		if rows[i].Metric == metric {
			return &rows[i]
		}
	}
	return nil
}

func TestKimiWeeklyAndSessionWindow(t *testing.T) {
	// 与实测响应同构：数字是 JSON 字符串，5h 窗口 = 300 分钟
	srv := serve(t, "Bearer sk-kimi-test", 200, map[string]any{
		"usage": map[string]any{"limit": "100", "used": "19", "remaining": "81", "resetTime": "2026-08-28T11:24:38Z"},
		"limits": []any{map[string]any{
			"window": map[string]any{"duration": 300, "timeUnit": "TIME_UNIT_MINUTE"},
			"detail": map[string]any{"limit": "100", "used": "78", "remaining": "22", "resetTime": "2026-08-22T17:24:38Z"},
		}},
	})
	defer srv.Close()

	old := KimiUsageURL
	KimiUsageURL = srv.URL
	defer func() { KimiUsageURL = old }()

	rows, err := kimiAdapter{}.Fetch(map[string]string{"api_key": "sk-kimi-test"})
	if err != nil {
		t.Fatal(err)
	}
	weekly := findRow(rows, "weekly_used_pct")
	if weekly == nil || weekly.Value != 19 {
		t.Fatalf("weekly_used_pct = %+v, want 19", weekly)
	}
	if weekly.ResetAt == nil || *weekly.ResetAt != "2026-08-28T11:24:38Z" {
		t.Fatalf("weekly reset_at = %v", weekly.ResetAt)
	}
	session := findRow(rows, "session_used_pct")
	if session == nil || session.Value != 78 {
		t.Fatalf("session_used_pct = %+v, want 78", session)
	}
}

func TestKimiNumericFieldsAndRemainingOnly(t *testing.T) {
	// 数字形态 + 窗口只有 remaining 没有 used
	srv := serve(t, "Bearer sk-kimi-test", 200, map[string]any{
		"usage": map[string]any{"limit": 200, "remaining": 150, "resetTime": "2026-08-30T00:00:00Z"},
		"limits": []any{map[string]any{
			"window": map[string]any{"duration": 5, "timeUnit": "TIME_UNIT_HOUR"},
			"detail": map[string]any{"limit": 100, "remaining": 90},
		}},
	})
	defer srv.Close()

	old := KimiUsageURL
	KimiUsageURL = srv.URL
	defer func() { KimiUsageURL = old }()

	rows, err := kimiAdapter{}.Fetch(map[string]string{"api_key": "sk-kimi-test"})
	if err != nil {
		t.Fatal(err)
	}
	if w := findRow(rows, "weekly_used_pct"); w == nil || w.Value != 25 {
		t.Fatalf("weekly_used_pct = %+v, want 25", w)
	}
	if s := findRow(rows, "session_used_pct"); s == nil || s.Value != 10 {
		t.Fatalf("session_used_pct = %+v, want 10", s)
	}
}

func TestKimiHTTPErrorCarriesBody(t *testing.T) {
	srv := serve(t, "Bearer bad", 403, "<html>cf challenge</html>")
	defer srv.Close()

	old := KimiUsageURL
	KimiUsageURL = srv.URL
	defer func() { KimiUsageURL = old }()

	rows := Run("kimi", map[string]string{"api_key": "bad"})
	if len(rows) != 1 || rows[0].Metric != "scrape_error" {
		t.Fatalf("rows = %+v, want 1 条 scrape_error", rows)
	}
	if rows[0].ResetAt == nil || !strings.Contains(*rows[0].ResetAt, "HTTP 403") || !strings.Contains(*rows[0].ResetAt, "cf challenge") {
		t.Fatalf("scrape_error 信息不含状态码/响应体: %v", *rows[0].ResetAt)
	}
}

func TestCodexWindowsClassifiedByDuration(t *testing.T) {
	reset5h := 1786536977.0
	resetWeek := 1787049600.0
	srv := serve(t, "Bearer tok-test", 200, map[string]any{
		"plan_type": "plus",
		"rate_limit": map[string]any{
			"primary_window":   map[string]any{"used_percent": 42, "limit_window_seconds": 18000, "reset_at": reset5h},
			"secondary_window": map[string]any{"used_percent": 7, "limit_window_seconds": 604800, "reset_at": resetWeek},
		},
		"credits": map[string]any{"has_credits": true, "balance": "12.5"},
	})
	defer srv.Close()

	old := CodexUsageURL
	CodexUsageURL = srv.URL
	defer func() { CodexUsageURL = old }()

	rows, err := codexAdapter{}.Fetch(map[string]string{"access_token": "tok-test", "account_id": "acc-1"})
	if err != nil {
		t.Fatal(err)
	}
	if s := findRow(rows, "session_used_pct"); s == nil || s.Value != 42 {
		t.Fatalf("session_used_pct = %+v, want 42", s)
	}
	w := findRow(rows, "weekly_used_pct")
	if w == nil || w.Value != 7 {
		t.Fatalf("weekly_used_pct = %+v, want 7", w)
	}
	if w.ResetAt == nil || !strings.HasPrefix(*w.ResetAt, "2026-") {
		t.Fatalf("reset_at 未转成 ISO: %v", w.ResetAt)
	}
	if c := findRow(rows, "credits_usd"); c == nil || c.Value != 12.5 {
		t.Fatalf("credits_usd = %+v, want 12.5", c)
	}
}

func TestCodexWeeklyInPrimaryWindow(t *testing.T) {
	// pro 档：周限额在 primary_window，secondary 为 null
	srv := serve(t, "Bearer tok-test", 200, map[string]any{
		"plan_type": "prolite",
		"rate_limit": map[string]any{
			"primary_window":   map[string]any{"used_percent": 81, "limit_window_seconds": 604800, "reset_at": 1786536977},
			"secondary_window": nil,
		},
		"credits": map[string]any{"has_credits": false, "balance": "0"},
	})
	defer srv.Close()

	old := CodexUsageURL
	CodexUsageURL = srv.URL
	defer func() { CodexUsageURL = old }()

	rows, err := codexAdapter{}.Fetch(map[string]string{"access_token": "tok-test"})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].Metric != "weekly_used_pct" || rows[0].Value != 81 {
		t.Fatalf("rows = %+v, want 单条 weekly_used_pct=81", rows)
	}
}

func TestKimiBaseURLOverride(t *testing.T) {
	// 凭证里配 base_url 时走自建转发，不碰默认地址；末尾斜杠要归一化
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"usage": map[string]any{"limit": "100", "remaining": "50", "resetTime": "2026-08-28T00:00:00Z"},
		})
	}))
	defer srv.Close()

	rows, err := kimiAdapter{}.Fetch(map[string]string{"api_key": "sk-kimi-test", "base_url": srv.URL + "/"})
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/usages" {
		t.Fatalf("path = %q, want /usages", gotPath)
	}
	if w := findRow(rows, "weekly_used_pct"); w == nil || w.Value != 50 {
		t.Fatalf("weekly_used_pct = %+v, want 50", w)
	}
}

func TestCodexBaseURLOverride(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"rate_limit": map[string]any{
				"primary_window":   map[string]any{"used_percent": 10, "limit_window_seconds": 18000},
				"secondary_window": nil,
			},
		})
	}))
	defer srv.Close()

	rows, err := codexAdapter{}.Fetch(map[string]string{"access_token": "tok", "base_url": srv.URL + "/backend-api"})
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/backend-api/codex/usage" {
		t.Fatalf("path = %q, want /backend-api/codex/usage", gotPath)
	}
	if s := findRow(rows, "session_used_pct"); s == nil || s.Value != 10 {
		t.Fatalf("session_used_pct = %+v, want 10", s)
	}
}

func TestCodexErrors(t *testing.T) {
	// 缺凭证
	rows := Run("codex", map[string]string{})
	if len(rows) != 1 || !strings.Contains(*rows[0].ResetAt, "access_token") {
		t.Fatalf("缺凭证应提示 access_token: %+v", rows)
	}

	// 401 → 提示过期
	srv := serve(t, "Bearer expired", 401, `{"error":"token expired"}`)
	defer srv.Close()
	old := CodexUsageURL
	CodexUsageURL = srv.URL
	defer func() { CodexUsageURL = old }()

	rows = Run("codex", map[string]string{"access_token": "expired"})
	if len(rows) != 1 || rows[0].Metric != "scrape_error" || !strings.Contains(*rows[0].ResetAt, "过期") {
		t.Fatalf("401 应提示过期: %+v", rows)
	}
}
