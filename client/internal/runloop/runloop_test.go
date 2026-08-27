package runloop

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"tokendash/client/internal/aggregate"
	"tokendash/client/internal/auth"
	"tokendash/client/internal/config"
)

// TestOnceEndToEnd 全链路：JSONL → 采集 → 聚合 → spool → 上传到假 hub。
func TestOnceEndToEnd(t *testing.T) {
	projects := filepath.Join(t.TempDir(), ".claude", "projects", "d1")
	if err := os.MkdirAll(projects, 0o755); err != nil {
		t.Fatal(err)
	}
	f, err := os.Create(filepath.Join(projects, "session.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	f.WriteString(`{"type":"assistant","message":{"model":"claude-sonnet-4-5","usage":{"input_tokens":42,"output_tokens":8,"cache_read_input_tokens":100}}}` + "\n")
	f.Close()

	var got []aggregate.Row
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/ingest/usage" {
			var body struct {
				DeviceID string          `json:"device_id"`
				Rows     []aggregate.Row `json:"rows"`
			}
			json.NewDecoder(r.Body).Decode(&body)
			got = append(got, body.Rows...)
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]any{"ok": true, "rows": len(body.Rows)})
			return
		}
		w.WriteHeader(404)
	}))
	defer srv.Close()

	cfg := config.Default()
	cfg.HubURL = srv.URL
	cfg.DeviceName = "e2e-dev"
	cfg.Sources.ClaudeCode = true
	cfg.Sources.Cursor = false
	cfg.Sources.Codex = false
	cfg.Sources.Gemini = false
	cfg.Sources.OpenCode = false
	cfg.Sources.Copilot = false

	r, err := New(cfg, auth.NewStore(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	r.Cfg = cfg
	r.ClaudeRoot = filepath.Join(projects, "..", "..")

	if err := r.Once(); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("hub should receive 1 row, got %d", len(got))
	}
	if got[0].InputTokens != 42 || got[0].CacheReadTokens != 100 || got[0].Source != "claude-code" {
		t.Fatalf("bad row: %+v", got[0])
	}

	// 状态里应记录成功同步
	st, err := r.Status()
	if err != nil {
		t.Fatal(err)
	}
	if st["last_sync_error"] != "" {
		t.Fatalf("last sync should be clean, got %v", st["last_sync_error"])
	}
	if st["spool_backlog"] != 0 {
		t.Fatal("spool should be drained")
	}
}
