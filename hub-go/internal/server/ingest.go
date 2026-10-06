package server

import (
	"context"
	"math"
	"net/http"
	"regexp"
	"strings"

	"tokendash/hub/internal/apperr"
	"tokendash/hub/internal/auth"
)

// providerSet is the ingest/credential provider whitelist, identical to
// ingest.ts PROVIDERS. Order matters for the "group_by must be one of" message.
var providerSet = map[string]bool{
	"claude": true, "openai": true, "copilot": true, "glm": true,
	"deepseek": true, "cursor": true, "codex": true, "kimi": true,
	"minimax": true, "zai": true, "anyrouter": true, "anyrouter_top": true,
	"gemini": true, "opencode": true,
}

const maxBatch = 1000

var hourRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$`)

func (s *Server) registerIngest(mux *http.ServeMux) {
	mux.Handle("POST /api/v1/ingest/usage", s.require(auth.RoleUser, auth.RoleClient, auth.RoleRunner)(http.HandlerFunc(s.handleIngestUsage)))
	mux.Handle("POST /api/v1/ingest/quota", s.require(auth.RoleRunner)(http.HandlerFunc(s.handleIngestQuota)))
}

type usageRow struct {
	Provider         string
	Source           string
	Model            *string
	BucketHour       string
	InputTokens      float64
	OutputTokens     float64
	CacheReadTokens  float64
	CacheWriteTokens float64
	CostUSD          float64
	Requests         float64
}

// handleIngestUsage mirrors ingest.ts postUsage: validate the batch, then run
// the device heartbeat and all upserts in one transaction.
//
// Like the TS implementation, a NULL model is bound as-is: SQLite treats NULLs
// as distinct in UNIQUE constraints, so ON CONFLICT never fires for NULL-model
// rows (each such row inserts a new row instead of overwriting).
func (s *Server) handleIngestUsage(w http.ResponseWriter, r *http.Request) {
	body, _ := decodeBody(r)
	if body == nil {
		bad(w, "invalid json body")
		return
	}
	deviceID, _ := body["device_id"].(string)
	if strings.TrimSpace(deviceID) == "" {
		bad(w, "device_id required")
		return
	}
	deviceID = strings.TrimSpace(deviceID)
	rowsVal, ok := body["rows"].([]any)
	if !ok {
		bad(w, "rows required")
		return
	}
	if len(rowsVal) > maxBatch {
		badf(w, "rows exceeds max batch %d", maxBatch)
		return
	}

	parsed := make([]usageRow, 0, len(rowsVal))
	for _, rv := range rowsVal {
		m, ok := rv.(map[string]any)
		if !ok {
			badf(w, "bad provider: %s", tsfmt(rv))
			return
		}
		provider, _ := m["provider"].(string)
		if !providerSet[provider] {
			badf(w, "bad provider: %s", tsfmt(m["provider"]))
			return
		}
		source, _ := m["source"].(string)
		if strings.TrimSpace(source) == "" {
			bad(w, "source required")
			return
		}
		var model *string
		if m["model"] != nil {
			ms := tsfmt(m["model"])
			model = &ms
		}
		bucketHour, _ := m["bucket_hour"].(string)
		if !hourRe.MatchString(bucketHour) {
			badf(w, "bad bucket_hour: %s", tsfmt(m["bucket_hour"]))
			return
		}
		parsed = append(parsed, usageRow{
			Provider:         provider,
			Source:           source,
			Model:            model,
			BucketHour:       bucketHour,
			InputTokens:      numOrZero(m["input_tokens"]),
			OutputTokens:     numOrZero(m["output_tokens"]),
			CacheReadTokens:  numOrZero(m["cache_read_tokens"]),
			CacheWriteTokens: numOrZero(m["cache_write_tokens"]),
			CostUSD:          numOrZero(m["cost_usd"]),
			Requests:         numOrZero(m["requests"]),
		})
	}

	db := s.Store.DB()
	tx, err := db.BeginTx(r.Context(), nil)
	if err != nil {
		apperr.Error(w, http.StatusInternalServerError, "internal")
		return
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(r.Context(),
		`INSERT INTO devices (device_id, name, last_seen_at)
		 VALUES (?,?, datetime('now'))
		 ON CONFLICT (device_id) DO UPDATE SET name = excluded.name, last_seen_at = datetime('now')`,
		deviceID, nil,
	); err != nil {
		apperr.Error(w, http.StatusInternalServerError, "internal")
		return
	}

	stmt, err := tx.PrepareContext(r.Context(),
		`INSERT INTO usage_hourly
		   (device_id, provider, source, model, bucket_hour,
		    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, requests)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?)
		 ON CONFLICT (device_id, provider, source, model, bucket_hour)
		 DO UPDATE SET
		   input_tokens = excluded.input_tokens,
		   output_tokens = excluded.output_tokens,
		   cache_read_tokens = excluded.cache_read_tokens,
		   cache_write_tokens = excluded.cache_write_tokens,
		   cost_usd = excluded.cost_usd,
		   requests = excluded.requests`,
	)
	if err != nil {
		apperr.Error(w, http.StatusInternalServerError, "internal")
		return
	}
	defer stmt.Close()

	for _, u := range parsed {
		if _, err := stmt.ExecContext(r.Context(),
			deviceID, u.Provider, u.Source, u.Model, u.BucketHour,
			u.InputTokens, u.OutputTokens, u.CacheReadTokens, u.CacheWriteTokens, u.CostUSD, u.Requests,
		); err != nil {
			apperr.Error(w, http.StatusInternalServerError, "internal")
			return
		}
	}

	if err := tx.Commit(); err != nil {
		apperr.Error(w, http.StatusInternalServerError, "internal")
		return
	}
	apperr.WriteJSON(w, http.StatusOK, map[string]any{"ok": true, "device_id": deviceID, "rows": len(rowsVal)})
}

// handleIngestQuota mirrors ingest.ts postQuota: append-only quota_snapshots
// inserts; quota_current is maintained by the trg_quota_snapshots_current trigger.
// The row type is the shared quotaRow declared in query.go.
func (s *Server) handleIngestQuota(w http.ResponseWriter, r *http.Request) {
	body, _ := decodeBody(r)
	if body == nil {
		bad(w, "invalid json body")
		return
	}
	rowsVal, ok := body["rows"].([]any)
	if !ok || len(rowsVal) == 0 {
		bad(w, "rows required")
		return
	}
	if len(rowsVal) > maxBatch {
		badf(w, "rows exceeds max batch %d", maxBatch)
		return
	}

	parsed := make([]quotaRow, 0, len(rowsVal))
	for _, rv := range rowsVal {
		m, ok := rv.(map[string]any)
		if !ok {
			badf(w, "bad provider: %s", tsfmt(rv))
			return
		}
		provider, _ := m["provider"].(string)
		if !providerSet[provider] {
			badf(w, "bad provider: %s", tsfmt(m["provider"]))
			return
		}
		metric, _ := m["metric"].(string)
		if strings.TrimSpace(metric) == "" {
			bad(w, "metric required")
			return
		}
		value, ok := m["value"].(float64)
		if !ok || math.IsNaN(value) || math.IsInf(value, 0) {
			badf(w, "bad value: %s", tsfmt(m["value"]))
			return
		}
		account := ""
		if a, ok := m["account"].(string); ok && strings.TrimSpace(a) != "" {
			account = trim50(strings.TrimSpace(a))
		}
		parsed = append(parsed, quotaRow{
			Provider:   provider,
			Metric:     strings.TrimSpace(metric),
			Account:    account,
			Value:      value,
			LimitValue: numOrNil(m["limit_value"]),
			Unit:       strOrNil(m["unit"]),
			ResetAt:    strOrNil(m["reset_at"]),
		})
	}

	if err := s.writeQuotaRows(r.Context(), parsed); err != nil {
		apperr.Error(w, http.StatusInternalServerError, "internal")
		return
	}
	apperr.WriteJSON(w, http.StatusOK, map[string]any{"ok": true, "rows": len(rowsVal)})
}

// writeQuotaRows appends quota rows to quota_snapshots in one transaction.
// It is the shared write path of handleIngestQuota and the built-in collector
// (which bypasses HTTP, mirroring the TS worker's loopback collect).
func (s *Server) writeQuotaRows(ctx context.Context, rows []quotaRow) error {
	db := s.Store.DB()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmt, err := tx.PrepareContext(ctx,
		`INSERT INTO quota_snapshots (provider, metric, account, value, limit_value, unit, reset_at)
		 VALUES (?,?,?,?,?,?,?)`,
	)
	if err != nil {
		return err
	}
	defer stmt.Close()

	for _, q := range rows {
		if _, err := stmt.ExecContext(ctx,
			q.Provider, q.Metric, q.Account, q.Value, q.LimitValue, q.Unit, q.ResetAt,
		); err != nil {
			return err
		}
	}

	return tx.Commit()
}
