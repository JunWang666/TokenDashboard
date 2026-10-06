package server

import (
	"net/http"
	"strings"

	"tokendash/hub/internal/apperr"
	"tokendash/hub/internal/auth"
	"tokendash/hub/internal/notify"
)

// Third-party notify channel configuration endpoints, mirroring
// cloudflare-hub/src/notify.ts (GET/PUT /notify-channels).

func (s *Server) registerNotify(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/notify-channels", s.require(auth.RoleUser, auth.RoleClient)(http.HandlerFunc(s.handleNotifyChannelsGet)))
	mux.Handle("PUT /api/v1/notify-channels", s.require(auth.RoleUser)(http.HandlerFunc(s.handleNotifyChannelsPut)))
}

// handleNotifyChannelsGet: secrets are never returned, only presence flags.
func (s *Server) handleNotifyChannelsGet(w http.ResponseWriter, r *http.Request) {
	state, err := notify.ReadState(r.Context(), s.Store.DB())
	if err != nil {
		s.Log.Error("notify channels read failed", "err", err)
		apperr.Error(w, http.StatusInternalServerError, "internal")
		return
	}
	apperr.WriteJSON(w, http.StatusOK, map[string]any{
		"feishu": map[string]any{
			"url":       nullIfEmpty(state[notify.KeyFeishuURL]),
			"hasSecret": state[notify.KeyFeishuSecret] != "",
		},
		"bark": map[string]any{
			"server": nullIfEmpty(state[notify.KeyBarkServer]),
			"hasKey": state[notify.KeyBarkKey] != "",
		},
	})
}

// handleNotifyChannelsPut: body { feishu?: { url, secret? }, bark?: { server, key? } }.
// A channel absent from the body is untouched; an empty url/server clears it;
// a changed url/server without a provided secret drops the old secret
// (notify.ts putChannels).
func (s *Server) handleNotifyChannelsPut(w http.ResponseWriter, r *http.Request) {
	body, _ := decodeBody(r)
	var feishuIn, barkIn map[string]any
	var hasFeishu, hasBark bool
	if body != nil {
		_, hasFeishu = body["feishu"]
		_, hasBark = body["bark"]
		feishuIn, _ = body["feishu"].(map[string]any)
		barkIn, _ = body["bark"].(map[string]any)
	}
	if !hasFeishu && !hasBark {
		bad(w, "body 需包含 feishu 或 bark 字段")
		return
	}

	db := s.Store.DB()
	ctx := r.Context()
	old, err := notify.ReadState(ctx, db)
	if err != nil {
		s.Log.Error("notify channels read failed", "err", err)
		apperr.Error(w, http.StatusInternalServerError, "internal")
		return
	}

	if hasFeishu {
		url := strings.TrimSpace(stringField(feishuIn, "url"))
		secret := strings.TrimSpace(stringField(feishuIn, "secret"))
		switch {
		case url == "":
			if _, err := db.ExecContext(ctx,
				`DELETE FROM settings WHERE key IN (?, ?)`, notify.KeyFeishuURL, notify.KeyFeishuSecret); err != nil {
				s.Log.Error("notify channels delete failed", "err", err)
				apperr.Error(w, http.StatusInternalServerError, "internal")
				return
			}
		case !httpURLRe.MatchString(url):
			bad(w, "feishu.url 必须是 http(s) 地址")
			return
		default:
			if err := upsertSetting(ctx, db, notify.KeyFeishuURL, url); err != nil {
				s.Log.Error("notify channels upsert failed", "err", err)
				apperr.Error(w, http.StatusInternalServerError, "internal")
				return
			}
			if secret != "" {
				enc, err := s.Crypt.Encrypt([]byte(secret))
				if err != nil {
					s.Log.Error("feishu secret encrypt failed", "err", err)
					apperr.Error(w, http.StatusInternalServerError, "internal")
					return
				}
				if err := upsertSetting(ctx, db, notify.KeyFeishuSecret, string(enc)); err != nil {
					s.Log.Error("notify channels upsert failed", "err", err)
					apperr.Error(w, http.StatusInternalServerError, "internal")
					return
				}
			} else if old[notify.KeyFeishuURL] != url {
				if _, err := db.ExecContext(ctx,
					`DELETE FROM settings WHERE key = ?`, notify.KeyFeishuSecret); err != nil {
					s.Log.Error("notify channels delete failed", "err", err)
					apperr.Error(w, http.StatusInternalServerError, "internal")
					return
				}
			}
		}
	}

	if hasBark {
		server := strings.TrimRight(strings.TrimSpace(stringField(barkIn, "server")), "/")
		key := strings.TrimSpace(stringField(barkIn, "key"))
		switch {
		case server == "":
			if _, err := db.ExecContext(ctx,
				`DELETE FROM settings WHERE key IN (?, ?)`, notify.KeyBarkServer, notify.KeyBarkKey); err != nil {
				s.Log.Error("notify channels delete failed", "err", err)
				apperr.Error(w, http.StatusInternalServerError, "internal")
				return
			}
		case !httpURLRe.MatchString(server):
			bad(w, "bark.server 必须是 http(s) 地址")
			return
		case key == "" && old[notify.KeyBarkKey] == "":
			bad(w, "首次配置 bark 需提供 key")
			return
		default:
			if err := upsertSetting(ctx, db, notify.KeyBarkServer, server); err != nil {
				s.Log.Error("notify channels upsert failed", "err", err)
				apperr.Error(w, http.StatusInternalServerError, "internal")
				return
			}
			if key != "" {
				enc, err := s.Crypt.Encrypt([]byte(key))
				if err != nil {
					s.Log.Error("bark key encrypt failed", "err", err)
					apperr.Error(w, http.StatusInternalServerError, "internal")
					return
				}
				if err := upsertSetting(ctx, db, notify.KeyBarkKey, string(enc)); err != nil {
					s.Log.Error("notify channels upsert failed", "err", err)
					apperr.Error(w, http.StatusInternalServerError, "internal")
					return
				}
			} else if old[notify.KeyBarkServer] != server {
				if _, err := db.ExecContext(ctx,
					`DELETE FROM settings WHERE key = ?`, notify.KeyBarkKey); err != nil {
					s.Log.Error("notify channels delete failed", "err", err)
					apperr.Error(w, http.StatusInternalServerError, "internal")
					return
				}
			}
		}
	}

	s.handleNotifyChannelsGet(w, r)
}

func stringField(m map[string]any, key string) string {
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}

func nullIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
