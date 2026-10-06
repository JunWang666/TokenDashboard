package server

import (
	"context"
	"net/http"
	"strings"

	"tokendash/hub/internal/apperr"
	"tokendash/hub/internal/auth"
)

// Settings table keys for the collect webhook, mirroring settings.ts.
const (
	keyCollectWebhookURL    = "collect_webhook_url"
	keyCollectWebhookSecret = "collect_webhook_secret" // 加密存储，与凭证同级
)

func (s *Server) registerSettings(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/collect-webhook", s.require(auth.RoleUser, auth.RoleClient)(http.HandlerFunc(s.handleCollectWebhookGet)))
	mux.Handle("PUT /api/v1/collect-webhook", s.require(auth.RoleUser)(http.HandlerFunc(s.handleCollectWebhookPut)))
}

func (s *Server) readSettings(ctx context.Context) (map[string]string, error) {
	rows, err := s.Store.DB().QueryContext(ctx, `SELECT key, value FROM settings`)
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

// handleCollectWebhookGet mirrors settings.ts get: the secret is never returned.
func (s *Server) handleCollectWebhookGet(w http.ResponseWriter, r *http.Request) {
	settings, err := s.readSettings(r.Context())
	if err != nil {
		s.Log.Error("settings read failed", "err", err)
		apperr.Error(w, http.StatusInternalServerError, "internal")
		return
	}
	var url *string
	if u, ok := settings[keyCollectWebhookURL]; ok {
		url = &u
	}
	apperr.WriteJSON(w, http.StatusOK, map[string]any{
		"url": url, "hasSecret": settings[keyCollectWebhookSecret] != "",
	})
}

// handleCollectWebhookPut mirrors settings.ts put: an empty url clears both
// keys; a changed url without a provided secret drops the old secret.
func (s *Server) handleCollectWebhookPut(w http.ResponseWriter, r *http.Request) {
	body, _ := decodeBody(r) // TS tolerates an unparseable body as null → url "" → clear
	var url, secret string
	if body != nil {
		if u, ok := body["url"].(string); ok {
			url = strings.TrimSpace(u)
		}
		if sec, ok := body["secret"].(string); ok {
			secret = strings.TrimSpace(sec)
		}
	}

	if url == "" {
		if _, err := s.Store.DB().ExecContext(r.Context(),
			`DELETE FROM settings WHERE key IN (?, ?)`, keyCollectWebhookURL, keyCollectWebhookSecret); err != nil {
			s.Log.Error("settings clear failed", "err", err)
			apperr.Error(w, http.StatusInternalServerError, "internal")
			return
		}
		apperr.WriteJSON(w, http.StatusOK, map[string]any{"ok": true, "url": nil, "hasSecret": false})
		return
	}
	if !httpURLRe.MatchString(url) {
		bad(w, "url 必须是 http(s) 地址")
		return
	}

	old, err := s.readSettings(r.Context())
	if err != nil {
		s.Log.Error("settings read failed", "err", err)
		apperr.Error(w, http.StatusInternalServerError, "internal")
		return
	}
	urlChanged := old[keyCollectWebhookURL] != url

	db := s.Store.DB()
	tx, err := db.BeginTx(r.Context(), nil)
	if err != nil {
		apperr.Error(w, http.StatusInternalServerError, "internal")
		return
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(r.Context(),
		`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
		 ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
		keyCollectWebhookURL, url); err != nil {
		s.Log.Error("settings upsert failed", "err", err)
		apperr.Error(w, http.StatusInternalServerError, "internal")
		return
	}

	if secret != "" {
		enc, err := s.Crypt.Encrypt([]byte(secret))
		if err != nil {
			s.Log.Error("webhook secret encrypt failed", "err", err)
			apperr.Error(w, http.StatusInternalServerError, "internal")
			return
		}
		if _, err := tx.ExecContext(r.Context(),
			`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
			 ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
			keyCollectWebhookSecret, enc); err != nil {
			s.Log.Error("settings upsert failed", "err", err)
			apperr.Error(w, http.StatusInternalServerError, "internal")
			return
		}
	} else if urlChanged {
		if _, err := tx.ExecContext(r.Context(),
			`DELETE FROM settings WHERE key = ?`, keyCollectWebhookSecret); err != nil {
			s.Log.Error("settings delete failed", "err", err)
			apperr.Error(w, http.StatusInternalServerError, "internal")
			return
		}
	}

	if err := tx.Commit(); err != nil {
		apperr.Error(w, http.StatusInternalServerError, "internal")
		return
	}

	hasSecret := secret != "" || (!urlChanged && old[keyCollectWebhookSecret] != "")
	apperr.WriteJSON(w, http.StatusOK, map[string]any{"ok": true, "url": url, "hasSecret": hasSecret})
}
