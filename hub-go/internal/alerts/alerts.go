// Package alerts evaluates quota snapshots from the materialized quota_current
// table and persists deduplicated alert_events, mirroring cloudflare-hub's
// alerts.ts (quota_low / reset_soon / reset_done).
package alerts

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"math"
	"strings"
	"time"
)

// Config mirrors alerts.ts AlertConfig. Defaults: enabled, remaining 10%, 60 min.
type Config struct {
	Enabled          bool
	LowThresholdPct  float64
	ResetSoonMinutes float64
}

// Settings table keys, mirroring alerts.ts.
const (
	KeyEnabled       = "alert_enabled"
	KeyLowPct        = "alert_low_threshold_pct"
	KeySoonMin       = "alert_reset_soon_minutes"
	defaultLowPct    = 10.0
	defaultSoonMin   = 60.0
	resetSoonLayout  = "2006-01-02 15:04:05"
	resetDoneHourLen = 13 // captured_at[:13] — hourly bucket for dedupe
)

// Snapshot is a single quota reading (alerts.ts Snapshot).
type Snapshot struct {
	Value      float64
	Unit       *string
	ResetAt    *string
	CapturedAt string
}

// Pair holds the latest two snapshots for one (provider, metric, account).
type Pair struct {
	Provider string
	Metric   string
	Account  string
	Prev     *Snapshot
	Latest   Snapshot
}

// Event is a persisted alert_events row (fresh ones get an ID).
type Event struct {
	ID        int64
	DedupeKey string
	Kind      string
	Provider  string
	Metric    string
	Account   string
	Title     string
	Body      string
}

var skipMetrics = map[string]bool{"scrape_error": true, "scrape_warn": true}

// ReadConfig loads the alert settings; unset keys fall back to the defaults.
func ReadConfig(ctx context.Context, db *sql.DB) (Config, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT key, value FROM settings WHERE key IN (?, ?, ?)`, KeyEnabled, KeyLowPct, KeySoonMin)
	if err != nil {
		return Config{}, err
	}
	defer rows.Close()
	m := map[string]string{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return Config{}, err
		}
		m[k] = v
	}
	if err := rows.Err(); err != nil {
		return Config{}, err
	}
	num := func(v string, dft float64) float64 {
		var n float64
		if _, err := fmt.Sscanf(v, "%g", &n); err != nil {
			return dft
		}
		return n
	}
	return Config{
		Enabled:          m[KeyEnabled] != "0",
		LowThresholdPct:  num(m[KeyLowPct], defaultLowPct),
		ResetSoonMinutes: num(m[KeySoonMin], defaultSoonMin),
	}, nil
}

func providerLabel(provider string) string {
	if provider == "" {
		return provider
	}
	return strings.ToUpper(provider[:1]) + provider[1:]
}

func isPercent(s Snapshot, metric string) bool {
	return s.Unit != nil && *s.Unit == "percent" || strings.Contains(metric, "_pct")
}

// parseResetAt mirrors Date.parse on SQLite datetime strings. The TS Worker
// parses "YYYY-MM-DD HH:MM:SS" as local time; the hub runs with TZ=UTC.
func parseResetAt(v string) (time.Time, error) {
	if t, err := time.ParseInLocation(resetSoonLayout, v, time.UTC); err == nil {
		return t, nil
	}
	return time.Parse(time.RFC3339, v)
}

// Evaluate is the pure evaluation from alerts.ts evaluate(): for each pair,
// detect a low-quota crossing, an approaching reset_at and a cross-cycle drop.
// Dedupe keys: low → once per reset cycle, soon → per reset_at, done → hourly.
func Evaluate(pairs []Pair, cfg Config, now time.Time) []Event {
	if !cfg.Enabled {
		return nil
	}
	var out []Event
	for _, p := range pairs {
		if skipMetrics[p.Metric] {
			continue
		}
		label := providerLabel(p.Provider)
		pct := isPercent(p.Latest, p.Metric)
		base := p.Provider + "|" + p.Metric + "|" + p.Account

		usedThresholdPct := 100 - cfg.LowThresholdPct
		if pct && p.Prev != nil && p.Prev.Value < usedThresholdPct && p.Latest.Value >= usedThresholdPct {
			remainingPct := math.Max(0, 100-p.Latest.Value)
			resetAt := "nr"
			if p.Latest.ResetAt != nil {
				resetAt = *p.Latest.ResetAt
			}
			out = append(out, Event{
				DedupeKey: "low|" + base + "|" + resetAt,
				Kind:      "quota_low",
				Provider:  p.Provider,
				Metric:    p.Metric,
				Account:   p.Account,
				Title:     fmt.Sprintf("%s 额度快用完", label),
				Body:      fmt.Sprintf("%s 剩余约 %.0f%%（已用 %.0f%%）", p.Metric, math.Round(remainingPct), math.Round(p.Latest.Value)),
			})
		}

		if p.Latest.ResetAt != nil {
			if resetAt, err := parseResetAt(*p.Latest.ResetAt); err == nil {
				diff := resetAt.Sub(now)
				if diff > 0 && diff <= time.Duration(cfg.ResetSoonMinutes)*time.Minute {
					out = append(out, Event{
						DedupeKey: "soon|" + base + "|" + *p.Latest.ResetAt,
						Kind:      "reset_soon",
						Provider:  p.Provider,
						Metric:    p.Metric,
						Account:   p.Account,
						Title:     fmt.Sprintf("%s 额度即将刷新", label),
						Body:      fmt.Sprintf("%s 约 %.0f 分钟后重置", p.Metric, math.Round(float64(diff)/float64(time.Minute))),
					})
				}
			}
		}

		if pct && p.Prev != nil && p.Prev.Value >= 80 && p.Latest.Value <= p.Prev.Value-30 {
			bucket := p.Latest.CapturedAt
			if len(bucket) > resetDoneHourLen {
				bucket = bucket[:resetDoneHourLen]
			}
			out = append(out, Event{
				DedupeKey: "done|" + base + "|" + bucket,
				Kind:      "reset_done",
				Provider:  p.Provider,
				Metric:    p.Metric,
				Account:   p.Account,
				Title:     fmt.Sprintf("%s 额度已刷新", label),
				Body:      fmt.Sprintf("%s 从 %.0f%% 回落至 %.0f%%", p.Metric, math.Round(p.Prev.Value), math.Round(p.Latest.Value)),
			})
		}
	}
	return out
}

// RunSweep reads quota_current, evaluates, persists new events (INSERT OR
// IGNORE dedupe) and enqueues one push_deliveries row per active subscription
// per fresh event — mirroring alerts.ts runAlertSweep. It returns the fresh
// events so callers can fan out to third-party notify channels.
func RunSweep(ctx context.Context, db *sql.DB, log *slog.Logger) ([]Event, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT provider, metric, account, value, unit, reset_at, captured_at,
		        previous_snapshot_id, previous_value, previous_unit,
		        previous_reset_at, previous_captured_at
		   FROM quota_current`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var pairs []Pair
	for rows.Next() {
		var (
			p                           Pair
			value, prevValue            sql.NullFloat64
			unit, resetAt, prevUnit     sql.NullString
			prevResetAt, prevCapturedAt sql.NullString
			previousSnapshotID          sql.NullInt64
			capturedAt                  string
		)
		if err := rows.Scan(&p.Provider, &p.Metric, &p.Account, &value, &unit, &resetAt, &capturedAt,
			&previousSnapshotID, &prevValue, &prevUnit, &prevResetAt, &prevCapturedAt); err != nil {
			return nil, err
		}
		p.Latest = Snapshot{Value: value.Float64, CapturedAt: capturedAt}
		if unit.Valid {
			u := unit.String
			p.Latest.Unit = &u
		}
		if resetAt.Valid {
			r := resetAt.String
			p.Latest.ResetAt = &r
		}
		if previousSnapshotID.Valid {
			prev := Snapshot{Value: prevValue.Float64, CapturedAt: capturedAt}
			if prevCapturedAt.Valid {
				prev.CapturedAt = prevCapturedAt.String
			}
			if prevUnit.Valid {
				u := prevUnit.String
				prev.Unit = &u
			}
			if prevResetAt.Valid {
				r := prevResetAt.String
				prev.ResetAt = &r
			}
			p.Prev = &prev
		}
		pairs = append(pairs, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	cfg, err := ReadConfig(ctx, db)
	if err != nil {
		return nil, err
	}

	var fresh []Event
	for _, e := range Evaluate(pairs, cfg, time.Now()) {
		res, err := db.ExecContext(ctx,
			`INSERT OR IGNORE INTO alert_events (dedupe_key, kind, provider, metric, account, title, body)
			 VALUES (?,?,?,?,?,?,?)`,
			e.DedupeKey, e.Kind, e.Provider, e.Metric, e.Account, e.Title, e.Body)
		if err != nil {
			return fresh, err
		}
		affected, err := res.RowsAffected()
		if err != nil {
			return fresh, err
		}
		if affected == 0 {
			continue // already alerted this cycle
		}
		id, err := res.LastInsertId()
		if err != nil {
			return fresh, err
		}
		e.ID = id
		fresh = append(fresh, e)

		// One durable delivery row per active subscription (enqueuePushDeliveries).
		if _, err := db.ExecContext(ctx,
			`INSERT OR IGNORE INTO push_deliveries (event_id, subscription_id)
			 SELECT ?, id FROM push_subscriptions WHERE active = 1`, id); err != nil && log != nil {
			log.Error("enqueue push deliveries failed", "event_id", id, "err", err)
		}
	}
	return fresh, nil
}
