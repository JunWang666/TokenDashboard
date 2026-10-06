// Package push delivers alert events to web-push and APNs subscriptions with
// durable retries, mirroring cloudflare-hub's push.ts (claim-before-send,
// exponential backoff, invalid-subscription handling) and webPush.ts (RFC 8291
// aes128gcm encryption + RFC 8292 VAPID).
package push

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"tokendash/hub/internal/config"
)

// Subscription mirrors a push_subscriptions row.
type Subscription struct {
	ID          int64
	Platform    string // "web" | "ios"
	Endpoint    string
	KeysJSON    *string
	Environment string
	Active      bool
}

// Payload is the notification content sent to every platform.
type Payload struct {
	Title string `json:"title"`
	Body  string `json:"body"`
}

// SendResult classifies one send attempt, mirroring push.ts PushSendResult.
// Status and ProviderMessageID are nil-able for the wire (null in JSON).
type SendResult struct {
	OK                  bool
	Retryable           bool
	InvalidSubscription bool
	Status              *int
	Reason              string
	ProviderMessageID   *string
}

// DispatchSummary mirrors push.ts PushDispatchSummary.
type DispatchSummary struct {
	Processed int
	Sent      int
	Retrying  int
	Failed    int
}

const (
	maxAttempts       = 8
	apnsTopic         = "com.gouzuang.TokenDashboard"
	testPushTitle     = "TokenDashboard 测试通知"
	testPushBody      = "推送链路已连通"
	resultTruncateLen = 1000
)

// retryDelaySeconds is the backoff table from push.ts; index = attempt-1 (clamped).
var retryDelaySeconds = []int64{60, 300, 900, 3600, 10800, 21600, 43200}

func bounded(s string) string {
	if utf8.RuneCountInString(s) <= resultTruncateLen {
		return s
	}
	runes := []rune(s)
	return string(runes[:resultTruncateLen-1]) + "…"
}

func failedResult(reason string, opts ...func(*SendResult)) SendResult {
	r := SendResult{Reason: bounded(reason)}
	for _, opt := range opts {
		opt(&r)
	}
	return r
}

func withStatus(status int) func(*SendResult) {
	return func(r *SendResult) { r.Status = &status }
}

func withRetryable(r *SendResult) { r.Retryable = true }
func withInvalid(r *SendResult)   { r.InvalidSubscription = true }
func withMessageID(id string) func(*SendResult) {
	return func(r *SendResult) {
		if id != "" {
			r.ProviderMessageID = &id
		}
	}
}

// sentResult builds the success result shared by both platforms. A missing
// provider message id stays null, mirroring Headers.get() returning null.
func sentResult(status int, messageID string) SendResult {
	r := SendResult{OK: true, Status: &status, Reason: "sent"}
	if messageID != "" {
		r.ProviderMessageID = &messageID
	}
	return r
}

func safeError(err error, redactions ...string) string {
	msg := err.Error()
	for _, value := range redactions {
		if value != "" {
			msg = strings.ReplaceAll(msg, value, "[redacted]")
		}
	}
	return bounded(msg)
}

// Sender bundles the platform senders built from hub configuration. A nil
// web/apns sender means that platform is unconfigured (sends fail retryable,
// mirroring configuredForWeb/configuredForApns in push.ts).
type Sender struct {
	web            *WebSender
	apns           *APNSSender
	sandboxDefault bool
	httpClient     *http.Client
	log            *slog.Logger
}

// NewSender builds a Sender from the hub environment. Web push requires
// VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY/VAPID_SUBJECT; APNs requires
// APNS_KEY_P8/APNS_KEY_ID/APNS_TEAM_ID. Missing pieces leave that sender nil.
func NewSender(cfg *config.Config, log *slog.Logger) *Sender {
	s := &Sender{
		sandboxDefault: cfg.APNSUseSandbox,
		httpClient:     &http.Client{Timeout: 30 * time.Second},
		log:            log,
	}
	if cfg.VAPIDPublicKey != "" && cfg.VAPIDPrivateKey != "" && cfg.VAPIDSubject != "" {
		s.web = &WebSender{
			PublicKey:  cfg.VAPIDPublicKey,
			PrivateKey: cfg.VAPIDPrivateKey,
			Subject:    cfg.VAPIDSubject,
		}
	}
	if cfg.APNSKeyP8 != "" && cfg.APNSKeyID != "" && cfg.APNSTeamID != "" {
		apns, err := NewAPNSSender(cfg.APNSKeyP8, cfg.APNSKeyID, cfg.APNSTeamID)
		if err != nil {
			if log != nil {
				log.Error("apns sender init failed", "err", err)
			}
		} else {
			s.apns = apns
		}
	}
	return s
}

// sendToSubscription dispatches by platform, mirroring push.ts sendToSubscription.
func (s *Sender) sendToSubscription(ctx context.Context, sub Subscription, payload Payload) SendResult {
	if sub.Platform == "web" {
		return s.sendWeb(ctx, sub, payload)
	}
	return s.sendAPNS(ctx, sub, payload)
}

// SendTestPush mirrors push.ts sendTestPush: a direct diagnostic send that
// also updates subscription health. The bool is false when the endpoint is
// not registered.
func (s *Sender) SendTestPush(ctx context.Context, db *sql.DB, endpoint string) (*SendResult, bool) {
	var sub Subscription
	var keysJSON, environment sql.NullString
	err := db.QueryRowContext(ctx,
		`SELECT id, platform, endpoint, keys_json, environment, active
		   FROM push_subscriptions WHERE endpoint = ?`, endpoint).
		Scan(&sub.ID, &sub.Platform, &sub.Endpoint, &keysJSON, &environment, &sub.Active)
	if err == sql.ErrNoRows {
		return nil, false
	}
	if err != nil {
		r := failedResult(err.Error(), withRetryable)
		return &r, true
	}
	if keysJSON.Valid {
		sub.KeysJSON = &keysJSON.String
	}
	sub.Environment = environment.String

	result := s.sendToSubscription(ctx, sub, Payload{Title: testPushTitle, Body: testPushBody})
	if err := recordSubscriptionResult(ctx, db, sub, result); err != nil && s.log != nil {
		s.log.Error("record subscription result failed", "subscription_id", sub.ID, "err", err)
	}
	if s.log != nil {
		l := s.log.Info
		if !result.OK {
			l = s.log.Error
		}
		l("push_test", "subscription_id", sub.ID, "platform", sub.Platform,
			"ok", result.OK, "http_status", result.Status,
			"reason", result.Reason, "provider_message_id", result.ProviderMessageID)
	}
	return &result, true
}

// recordSubscriptionResult mirrors push.ts: success refreshes health, an
// invalid subscription deactivates it, anything else records last_error.
func recordSubscriptionResult(ctx context.Context, db *sql.DB, sub Subscription, result SendResult) error {
	if result.OK {
		_, err := db.ExecContext(ctx,
			`UPDATE push_subscriptions
			    SET active = 1, last_success_at = datetime('now'), last_error = NULL, updated_at = datetime('now')
			  WHERE id = ?`, sub.ID)
		return err
	}
	inactive := 0
	if result.InvalidSubscription {
		inactive = 1
	}
	_, err := db.ExecContext(ctx,
		`UPDATE push_subscriptions
		    SET active = CASE WHEN ? THEN 0 ELSE active END,
		        last_error = ?, updated_at = datetime('now')
		  WHERE id = ?`, inactive, bounded(result.Reason), sub.ID)
	return err
}

// completeDelivery mirrors push.ts: sent → 'sent', retryable with attempts
// left → 'retry' with backoff, otherwise → 'failed'.
func completeDelivery(ctx context.Context, db *sql.DB, deliveryID int64, attempts int, result SendResult) (string, error) {
	if result.OK {
		_, err := db.ExecContext(ctx,
			`UPDATE push_deliveries
			    SET status = 'sent', sent_at = datetime('now'), http_status = ?,
			        provider_message_id = ?, last_error = NULL, updated_at = datetime('now')
			  WHERE id = ?`,
			result.Status, result.ProviderMessageID, deliveryID)
		return "sent", err
	}

	if result.Retryable && !result.InvalidSubscription && attempts < maxAttempts {
		delay := retryDelaySeconds[min(int64(attempts)-1, int64(len(retryDelaySeconds)-1))]
		_, err := db.ExecContext(ctx,
			`UPDATE push_deliveries
			    SET status = 'retry', next_attempt_at = datetime('now', ?), http_status = ?,
			        provider_message_id = ?, last_error = ?, updated_at = datetime('now')
			  WHERE id = ?`,
			fmt.Sprintf("+%d seconds", delay), result.Status, result.ProviderMessageID,
			bounded(result.Reason), deliveryID)
		return "retry", err
	}

	_, err := db.ExecContext(ctx,
		`UPDATE push_deliveries
		    SET status = 'failed', http_status = ?, provider_message_id = ?, last_error = ?, updated_at = datetime('now')
		  WHERE id = ?`,
		result.Status, result.ProviderMessageID, bounded(result.Reason), deliveryID)
	return "failed", err
}

func logDelivery(log *slog.Logger, deliveryID, eventID, subscriptionID int64, platform, environment string, attempt int, finalStatus string, result SendResult) {
	if log == nil {
		return
	}
	l := log.Info
	if !result.OK {
		l = log.Error
	}
	env := ""
	if platform == "ios" {
		env = environment
		if env == "" {
			env = "legacy-default"
		}
	}
	l("push_delivery", "delivery_id", deliveryID, "event_id", eventID,
		"subscription_id", subscriptionID, "platform", platform, "environment", env,
		"attempt", attempt, "status", finalStatus,
		"http_status", result.Status, "reason", result.Reason,
		"provider_message_id", result.ProviderMessageID)
}
