package upload

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"tokendash/client/internal/aggregate"
	"tokendash/client/internal/auth"
)

type fakeHub struct {
	mu        sync.Mutex
	posts     int
	gotRows   int
	gotCookie string
	failNext  bool
}

func (h *fakeHub) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/ingest/usage", func(w http.ResponseWriter, r *http.Request) {
		h.mu.Lock()
		defer h.mu.Unlock()
		h.posts++
		h.gotCookie = r.Header.Get("Cookie")
		if h.failNext {
			h.failNext = false
			w.WriteHeader(500)
			return
		}
		var body struct {
			DeviceID string `json:"device_id"`
			Rows     []aggregate.Row `json:"rows"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		h.gotRows += len(body.Rows)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true, "rows": len(body.Rows)})
	})
	return mux
}

func newClient(t *testing.T, hub *fakeHub) *Client {
	t.Helper()
	srv := httptest.NewServer(hub.handler())
	t.Cleanup(srv.Close)
	return &Client{
		BaseURL:    srv.URL,
		DeviceName: "test-dev",
		Auth:       auth.NewStore(t.TempDir()),
		HTTP:       srv.Client(),
	}
}

func TestIngestUsageWithCookieAndDevice(t *testing.T) {
	hub := &fakeHub{}
	c := newClient(t, hub)
	c.Auth.SetAccessCookie("jwt-token")

	rows := []aggregate.Row{{
		Provider: "claude", Source: "claude-code", Model: "m",
		BucketHour: "2026-08-12T14:00:00Z", InputTokens: 5, Requests: 1,
	}}
	n, err := c.IngestUsage(rows)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 || hub.posts != 1 || hub.gotRows != 1 {
		t.Fatalf("bad ingest result: n=%d posts=%d rows=%d", n, hub.posts, hub.gotRows)
	}
	if !strings.Contains(hub.gotCookie, "CF_Authorization=jwt-token") {
		t.Fatalf("cookie not sent: %q", hub.gotCookie)
	}
}

func TestIngestUsageRetryAfterFailure(t *testing.T) {
	hub := &fakeHub{failNext: true}
	c := newClient(t, hub)
	rows := []aggregate.Row{{
		Provider: "claude", Source: "claude-code", Model: "m",
		BucketHour: "2026-08-12T14:00:00Z", InputTokens: 5, Requests: 1,
	}}
	if _, err := c.IngestUsage(rows); err != nil {
		t.Fatal("should retry until success, got", err)
	}
	if hub.posts != 2 {
		t.Fatalf("want 2 attempts (1 fail + 1 ok), got %d", hub.posts)
	}
}

func TestPushCredential(t *testing.T) {
	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "PUT" || r.URL.Path != "/api/v1/credentials/openai" {
			w.WriteHeader(404)
			return
		}
		json.NewDecoder(r.Body).Decode(&got)
		w.WriteHeader(200)
	}))
	defer srv.Close()
	c := &Client{BaseURL: srv.URL, DeviceName: "d", Auth: auth.NewStore(t.TempDir()), HTTP: srv.Client()}
	if err := c.PushCredential("openai", map[string]string{"api_key": "sk-1234"}); err != nil {
		t.Fatal(err)
	}
	if got["payload"].(map[string]any)["api_key"] != "sk-1234" {
		t.Fatalf("bad payload: %v", got)
	}
}

func TestUnauthorizedDetected(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
	}))
	defer srv.Close()
	c := &Client{BaseURL: srv.URL, DeviceName: "d", Auth: auth.NewStore(t.TempDir()), HTTP: srv.Client()}
	_, err := c.IngestUsage([]aggregate.Row{{
		Provider: "claude", Source: "s", Model: "m", BucketHour: "2026-08-12T14:00:00Z", Requests: 1,
	}})
	if err != ErrUnauthorized {
		t.Fatalf("want ErrUnauthorized, got %v", err)
	}
}
