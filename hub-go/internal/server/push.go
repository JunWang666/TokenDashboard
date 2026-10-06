package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"tokendash/hub/internal/alerts"
	"tokendash/hub/internal/apperr"
	"tokendash/hub/internal/auth"
)

// Push subscription and alert settings endpoints, mirroring
// cloudflare-hub/src/pushSubscriptions.ts.

var iosTokenRe = regexp.MustCompile(`^[a-fA-F0-9]{64,256}$`)

func (s *Server) registerPush(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/push/vapid-public-key", s.require(auth.RoleUser, auth.RoleClient)(http.HandlerFunc(s.handleVapidKey)))
	mux.Handle("POST /api/v1/push/subscriptions", s.require(auth.RoleUser, auth.RoleClient)(http.HandlerFunc(s.handlePushSubscribe)))
	mux.Handle("DELETE /api/v1/push/subscriptions", s.require(auth.RoleUser, auth.RoleClient)(http.HandlerFunc(s.handlePushUnsubscribe)))
	mux.Handle("POST /api/v1/push/subscriptions/status", s.require(auth.RoleUser, auth.RoleClient)(http.HandlerFunc(s.handlePushStatus)))
	mux.Handle("POST /api/v1/push/test", s.require(auth.RoleUser, auth.RoleClient)(http.HandlerFunc(s.handlePushTest)))
	mux.Handle("GET /api/v1/alerts/settings", s.require(auth.RoleUser, auth.RoleClient)(http.HandlerFunc(s.handleAlertsSettingsGet)))
	mux.Handle("PUT /api/v1/alerts/settings", s.require(auth.RoleUser)(http.HandlerFunc(s.handleAlertsSettingsPut)))
}

// handleVapidKey: the frontend fetches this before subscribing to web push.
func (s *Server) handleVapidKey(w http.ResponseWriter, r *http.Request) {
	var key *string
	if s.Cfg.VAPIDPublicKey != "" {
		key = &s.Cfg.VAPIDPublicKey
	}
	apperr.WriteJSON(w, http.StatusOK, map[string]any{"key": key})
}

// handlePushSubscribe: body { platform, endpoint, keys?, environment? }.
// For web, endpoint is a push service URL; for iOS it is an APNs device token.
// Upsert by endpoint (pushSubscriptions.ts subscribe).
func (s *Server) handlePushSubscribe(w http.ResponseWriter, r *http.Request) {
	body, _ := decodeBody(r)
	platform, _ := body["platform"].(string)
	if platform != "web" && platform != "ios" {
		badf(w, "bad platform: %s", tsfmt(body["platform"]))
		return
	}
	endpoint, _ := body["endpoint"].(string)
	endpoint = strings.TrimSpace(endpoint)
	if endpoint == "" || len(endpoint) > 4096 {
		bad(w, "endpoint required")
		return
	}

	var keysJSON *string
	environment := ""
	if platform == "web" {
		if !strings.HasPrefix(endpoint, "https://") {
			bad(w, "web endpoint 必须是 https 地址")
			return
		}
		keys, ok := body["keys"].(map[string]any)
		if !ok {
			bad(w, "web 订阅需要 keys.p256dh 与 keys.auth")
			return
		}
		p256dh, _ := keys["p256dh"].(string)
		authSecret, _ := keys["auth"].(string)
		if p256dh == "" || authSecret == "" {
			bad(w, "web 订阅需要 keys.p256dh 与 keys.auth")
			return
		}
		encoded, _ := json.Marshal(struct {
			P256dh string `json:"p256dh"`
			Auth   string `json:"auth"`
		}{p256dh, authSecret})
		keysStr := string(encoded)
		keysJSON = &keysStr
	} else {
		if !iosTokenRe.MatchString(endpoint) {
			bad(w, "iOS endpoint 必须是 APNs device token")
			return
		}
		switch env := body["environment"]; {
		case env == nil:
			// Backward compatibility for apps that do not report their signing environment.
			if s.Cfg.APNSUseSandbox {
				environment = "sandbox"
			} else {
				environment = "production"
			}
		case env == "sandbox" || env == "production":
			environment = env.(string)
		default:
			bad(w, "iOS environment 必须是 sandbox 或 production")
			return
		}
	}

	_, err := s.Store.DB().ExecContext(r.Context(),
		`INSERT INTO push_subscriptions (platform, endpoint, keys_json, environment, active, last_error)
		 VALUES (?,?,?,?,1,NULL)
		 ON CONFLICT (endpoint) DO UPDATE SET
		   platform = excluded.platform,
		   keys_json = excluded.keys_json,
		   environment = excluded.environment,
		   active = 1,
		   last_error = CASE
		     WHEN push_subscriptions.platform = excluded.platform
		      AND push_subscriptions.keys_json IS excluded.keys_json
		      AND push_subscriptions.environment = excluded.environment
		     THEN push_subscriptions.last_error
		     ELSE NULL
		   END,
		   updated_at = datetime('now')`,
		platform, endpoint, keysJSON, environment)
	if err != nil {
		s.Log.Error("push subscribe upsert failed", "err", err)
		apperr.Error(w, http.StatusInternalServerError, "internal")
		return
	}

	var envOut *string
	if environment != "" {
		envOut = &environment
	}
	apperr.WriteJSON(w, http.StatusOK, map[string]any{"ok": true, "environment": envOut})
}

// handlePushUnsubscribe: body { endpoint }; missing endpoint is still ok.
func (s *Server) handlePushUnsubscribe(w http.ResponseWriter, r *http.Request) {
	body, _ := decodeBody(r)
	endpoint, _ := body["endpoint"].(string)
	endpoint = strings.TrimSpace(endpoint)
	if endpoint == "" {
		bad(w, "endpoint required")
		return
	}
	db := s.Store.DB()
	// push_deliveries has ON DELETE CASCADE, but mirror the TS explicit delete.
	if _, err := db.ExecContext(r.Context(),
		`DELETE FROM push_deliveries
		  WHERE subscription_id IN (SELECT id FROM push_subscriptions WHERE endpoint = ?)`, endpoint); err != nil {
		s.Log.Error("push unsubscribe deliveries delete failed", "err", err)
		apperr.Error(w, http.StatusInternalServerError, "internal")
		return
	}
	if _, err := db.ExecContext(r.Context(),
		`DELETE FROM push_subscriptions WHERE endpoint = ?`, endpoint); err != nil {
		s.Log.Error("push unsubscribe delete failed", "err", err)
		apperr.Error(w, http.StatusInternalServerError, "internal")
		return
	}
	apperr.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handlePushStatus: body { endpoint } — token/endpoint stay out of URL logs.
func (s *Server) handlePushStatus(w http.ResponseWriter, r *http.Request) {
	body, _ := decodeBody(r)
	endpoint, _ := body["endpoint"].(string)
	endpoint = strings.TrimSpace(endpoint)
	if endpoint == "" {
		bad(w, "endpoint required")
		return
	}

	var (
		platform, createdAt, updatedAt        string
		active                                int
		environment, lastSuccessAt, lastError sql.NullString
		deliveryStatus, deliveryLastAttemptAt sql.NullString
		deliverySentAt, deliveryLastError     sql.NullString
		deliveryHTTPStatus                    sql.NullInt64
		deliveryAttempts                      sql.NullInt64
	)
	err := s.Store.DB().QueryRowContext(r.Context(),
		`SELECT s.platform, s.environment, s.active, s.created_at, s.updated_at,
		        s.last_success_at, s.last_error,
		        d.status, d.attempts, d.last_attempt_at, d.sent_at, d.http_status, d.last_error
		   FROM push_subscriptions s
		   LEFT JOIN push_deliveries d ON d.id = (
		         SELECT id FROM push_deliveries WHERE subscription_id = s.id ORDER BY id DESC LIMIT 1
		       )
		  WHERE s.endpoint = ?`, endpoint).
		Scan(&platform, &environment, &active, &createdAt, &updatedAt,
			&lastSuccessAt, &lastError,
			&deliveryStatus, &deliveryAttempts, &deliveryLastAttemptAt,
			&deliverySentAt, &deliveryHTTPStatus, &deliveryLastError)
	if err == sql.ErrNoRows {
		apperr.WriteJSON(w, http.StatusOK, map[string]any{"subscription": nil})
		return
	}
	if err != nil {
		s.Log.Error("push status query failed", "err", err)
		apperr.Error(w, http.StatusInternalServerError, "internal")
		return
	}

	var envOut *string
	if platform == "ios" && environment.Valid && environment.String != "" {
		envOut = &environment.String
	}
	sub := map[string]any{
		"platform":       platform,
		"environment":    envOut,
		"active":         active == 1,
		"createdAt":      createdAt,
		"updatedAt":      updatedAt,
		"lastSuccessAt":  nullString(lastSuccessAt),
		"lastError":      nullString(lastError),
		"latestDelivery": nil,
	}
	if deliveryStatus.Valid {
		var httpStatus *int
		if deliveryHTTPStatus.Valid {
			n := int(deliveryHTTPStatus.Int64)
			httpStatus = &n
		}
		sub["latestDelivery"] = map[string]any{
			"status":        deliveryStatus.String,
			"attempts":      deliveryAttempts.Int64,
			"lastAttemptAt": nullString(deliveryLastAttemptAt),
			"sentAt":        nullString(deliverySentAt),
			"httpStatus":    httpStatus,
			"lastError":     nullString(deliveryLastError),
		}
	}
	apperr.WriteJSON(w, http.StatusOK, map[string]any{"subscription": sub})
}

// handlePushTest: immediate diagnostic push to a registered endpoint.
func (s *Server) handlePushTest(w http.ResponseWriter, r *http.Request) {
	body, _ := decodeBody(r)
	endpoint, _ := body["endpoint"].(string)
	endpoint = strings.TrimSpace(endpoint)
	if endpoint == "" {
		bad(w, "endpoint required")
		return
	}
	result, found := s.pushSender().SendTestPush(r.Context(), s.Store.DB(), endpoint)
	if !found {
		writeErr(w, http.StatusNotFound, "not_found", "订阅不存在，请重新开启通知")
		return
	}
	apperr.WriteJSON(w, http.StatusOK, map[string]any{
		"ok":                  result.OK,
		"retryable":           result.Retryable,
		"invalidSubscription": result.InvalidSubscription,
		"status":              result.Status,
		"reason":              result.Reason,
		"providerMessageId":   result.ProviderMessageID,
	})
}

// handleAlertsSettingsGet: defaults are enabled / remaining 10% / 60 minutes.
func (s *Server) handleAlertsSettingsGet(w http.ResponseWriter, r *http.Request) {
	cfg, err := alerts.ReadConfig(r.Context(), s.Store.DB())
	if err != nil {
		s.Log.Error("alert config read failed", "err", err)
		apperr.Error(w, http.StatusInternalServerError, "internal")
		return
	}
	writeAlertConfig(w, cfg)
}

// handleAlertsSettingsPut: partial update; only submitted fields change.
func (s *Server) handleAlertsSettingsPut(w http.ResponseWriter, r *http.Request) {
	body, err := decodeBody(r)
	if err != nil || body == nil {
		bad(w, "invalid json body")
		return
	}
	db := s.Store.DB()
	ctx := r.Context()

	if v, ok := body["enabled"]; ok {
		b, ok := v.(bool)
		if !ok {
			bad(w, "enabled 必须是布尔值")
			return
		}
		value := "0"
		if b {
			value = "1"
		}
		if err := upsertSetting(ctx, db, alerts.KeyEnabled, value); err != nil {
			s.Log.Error("alert setting upsert failed", "err", err)
			apperr.Error(w, http.StatusInternalServerError, "internal")
			return
		}
	}
	if v, ok := body["lowThresholdPct"]; ok {
		n, ok := v.(float64)
		if !ok || n < 1 || n > 100 {
			bad(w, "lowThresholdPct 必须在 1-100 之间")
			return
		}
		if err := upsertSetting(ctx, db, alerts.KeyLowPct, trimFloat(n)); err != nil {
			s.Log.Error("alert setting upsert failed", "err", err)
			apperr.Error(w, http.StatusInternalServerError, "internal")
			return
		}
	}
	if v, ok := body["resetSoonMinutes"]; ok {
		n, ok := v.(float64)
		if !ok || n < 1 || n > 1440 {
			bad(w, "resetSoonMinutes 必须在 1-1440 之间")
			return
		}
		if err := upsertSetting(ctx, db, alerts.KeySoonMin, trimFloat(n)); err != nil {
			s.Log.Error("alert setting upsert failed", "err", err)
			apperr.Error(w, http.StatusInternalServerError, "internal")
			return
		}
	}

	cfg, err := alerts.ReadConfig(ctx, db)
	if err != nil {
		s.Log.Error("alert config read failed", "err", err)
		apperr.Error(w, http.StatusInternalServerError, "internal")
		return
	}
	writeAlertConfig(w, cfg)
}

func upsertSetting(ctx context.Context, db *sql.DB, key, value string) error {
	_, err := db.ExecContext(ctx,
		`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
		 ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
		key, value)
	return err
}

// trimFloat renders a JSON number like JS String(n): integers without a
// fractional part, otherwise the shortest decimal form.
func trimFloat(n float64) string {
	return strconv.FormatFloat(n, 'f', -1, 64)
}

func writeAlertConfig(w http.ResponseWriter, cfg alerts.Config) {
	apperr.WriteJSON(w, http.StatusOK, map[string]any{
		"enabled":          cfg.Enabled,
		"lowThresholdPct":  cfg.LowThresholdPct,
		"resetSoonMinutes": cfg.ResetSoonMinutes,
	})
}

func nullString(v sql.NullString) *string {
	if !v.Valid {
		return nil
	}
	return &v.String
}
