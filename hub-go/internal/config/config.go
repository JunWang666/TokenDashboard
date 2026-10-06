// Package config loads hub configuration from environment variables.
package config

import (
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"
)

type Config struct {
	// Required: 32 random bytes encoded as base64 (AES-256 key, also the
	// internal shared credential).
	CredentialsKey string

	// Embedded SQLite database file path.
	DBPath string
	// HTTP listen address.
	ListenAddr string
	// Comma-separated allowed CORS origins. Empty means reflect any origin.
	CORSOrigins []string

	// Cloudflare Access (both empty => Access auth fails closed).
	AccessTeam string
	AccessAUD  string

	// Service-token client IDs (comma-separated) that map to runner role.
	RunnerServiceTokens []string

	// Local development bearer token (empty => dev-token auth skipped).
	DevToken string

	// How often the runner collects quota snapshots.
	CollectInterval time.Duration

	// Logto OIDC (empty endpoint => OIDC auth skipped).
	LogtoEndpoint string
	LogtoAudience string

	// Web Push (VAPID).
	VAPIDPublicKey  string
	VAPIDPrivateKey string
	VAPIDSubject    string

	// iOS push (APNs). APNSKeyP8 is the .p8 file contents including
	// BEGIN/END lines. APNSUseSandbox is any non-empty, non-"0"/"false" value.
	APNSKeyP8      string
	APNSKeyID      string
	APNSTeamID     string
	APNSUseSandbox bool
}

// Load reads configuration from the process environment.
func Load() (*Config, error) {
	key := os.Getenv("CREDENTIALS_KEY")
	if key == "" {
		return nil, errors.New("CREDENTIALS_KEY is required (32 bytes, base64 encoded)")
	}
	raw, err := base64.StdEncoding.DecodeString(key)
	if err != nil || len(raw) != 32 {
		return nil, errors.New("CREDENTIALS_KEY must be 32 bytes base64 encoded")
	}

	interval, err := time.ParseDuration(envOr("COLLECT_INTERVAL", "15m"))
	if err != nil {
		return nil, fmt.Errorf("COLLECT_INTERVAL: %w", err)
	}

	cfg := &Config{
		CredentialsKey:      key,
		DBPath:              envOr("DB_PATH", "./data/tokendash.db"),
		ListenAddr:          envOr("LISTEN_ADDR", ":8787"),
		CORSOrigins:         splitList(os.Getenv("CORS_ORIGINS")),
		AccessTeam:          os.Getenv("ACCESS_TEAM"),
		AccessAUD:           os.Getenv("ACCESS_AUD"),
		RunnerServiceTokens: splitList(os.Getenv("RUNNER_SERVICE_TOKENS")),
		DevToken:            os.Getenv("DEV_TOKEN"),
		CollectInterval:     interval,
		LogtoEndpoint:       os.Getenv("LOGTO_ENDPOINT"),
		LogtoAudience:       os.Getenv("LOGTO_AUDIENCE"),
		VAPIDPublicKey:      os.Getenv("VAPID_PUBLIC_KEY"),
		VAPIDPrivateKey:     os.Getenv("VAPID_PRIVATE_KEY"),
		VAPIDSubject:        os.Getenv("VAPID_SUBJECT"),
		APNSKeyP8:           os.Getenv("APNS_KEY_P8"),
		APNSKeyID:           os.Getenv("APNS_KEY_ID"),
		APNSTeamID:          os.Getenv("APNS_TEAM_ID"),
		APNSUseSandbox:      parseBool(os.Getenv("APNS_USE_SANDBOX")),
	}
	return cfg, nil
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// splitList splits a comma-separated env value into trimmed, non-empty items.
// An empty input yields a nil slice.
func splitList(s string) []string {
	var out []string
	for _, part := range strings.Split(s, ",") {
		if p := strings.TrimSpace(part); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func parseBool(s string) bool {
	s = strings.TrimSpace(strings.ToLower(s))
	return s != "" && s != "0" && s != "false"
}
