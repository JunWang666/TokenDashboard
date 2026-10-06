package server

import (
	"context"
	"database/sql"
	"net/http"
	"sort"
	"time"

	"tokendash/hub/internal/apperr"
	"tokendash/hub/internal/auth"
)

const tokenCols = `
  SUM(input_tokens)       AS input_tokens,
  SUM(output_tokens)      AS output_tokens,
  SUM(cache_read_tokens)  AS cache_read_tokens,
  SUM(cache_write_tokens) AS cache_write_tokens,
  SUM(cost_usd)           AS cost_usd,
  SUM(requests)           AS requests`

const currentQuotaSQL = `SELECT q.* FROM quota_current q
  WHERE EXISTS (
    SELECT 1 FROM credentials c WHERE c.provider = q.provider AND c.name = q.account
  )
  ORDER BY q.provider, q.account, q.metric`

var groupBySet = map[string]bool{"provider": true, "model": true, "day": true}
var intervalSet = map[string]bool{"hour": true, "day": true}

// tokenTotals are the six aggregated numeric fields shared by summary,
// timeseries and bootstrap rows (JSON names match web/src/types.ts).
type tokenTotals struct {
	InputTokens      float64 `json:"input_tokens"`
	OutputTokens     float64 `json:"output_tokens"`
	CacheReadTokens  float64 `json:"cache_read_tokens"`
	CacheWriteTokens float64 `json:"cache_write_tokens"`
	CostUSD          float64 `json:"cost_usd"`
	Requests         float64 `json:"requests"`
}

type summaryRow struct {
	Key *string `json:"key"`
	tokenTotals
}

type summaryResponse struct {
	GroupBy string       `json:"group_by"`
	From    *string      `json:"from"`
	To      *string      `json:"to"`
	Rows    []summaryRow `json:"rows"`
}

type tsRow struct {
	Time   string  `json:"time"`
	Series *string `json:"series"`
	tokenTotals
}

type timeseriesResponse struct {
	Interval string  `json:"interval"`
	GroupBy  string  `json:"group_by"`
	From     *string `json:"from"`
	To       *string `json:"to"`
	Rows     []tsRow `json:"rows"`
}

type quotaRow struct {
	Provider   string   `json:"provider"`
	Metric     string   `json:"metric"`
	Account    string   `json:"account"`
	Value      float64  `json:"value"`
	LimitValue *float64 `json:"limit_value"`
	Unit       *string  `json:"unit"`
	ResetAt    *string  `json:"reset_at"`
	CapturedAt string   `json:"captured_at"`
}

type quotaCurrentResponse struct {
	Rows []quotaRow `json:"rows"`
}

// quotaHistoryRow matches web/src/types.ts QuotaHistoryRow — snapshot_id is
// used for ordering but not serialized (same as the TS historyRow).
type quotaHistoryRow struct {
	Provider   string   `json:"provider"`
	Metric     string   `json:"metric"`
	Account    string   `json:"account"`
	Value      float64  `json:"value"`
	LimitValue *float64 `json:"limit_value"`
	Unit       *string  `json:"unit"`
	ResetAt    *string  `json:"reset_at"`
	CapturedAt string   `json:"captured_at"`
	SnapshotID int64    `json:"-"`
}

func (s *Server) registerQuery(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/summary", s.require(auth.RoleUser, auth.RoleClient)(http.HandlerFunc(s.handleSummary)))
	mux.Handle("GET /api/v1/usage/timeseries", s.require(auth.RoleUser, auth.RoleClient)(http.HandlerFunc(s.handleTimeseries)))
	mux.Handle("GET /api/v1/quota/current", s.require(auth.RoleUser, auth.RoleClient)(http.HandlerFunc(s.handleQuotaCurrent)))
	mux.Handle("GET /api/v1/quota/history", s.require(auth.RoleUser, auth.RoleClient)(http.HandlerFunc(s.handleQuotaHistory)))
	mux.Handle("GET /api/v1/bootstrap", s.require(auth.RoleUser, auth.RoleClient)(http.HandlerFunc(s.handleBootstrap)))
	mux.Handle("GET /api/v1/devices", s.require(auth.RoleUser, auth.RoleClient)(http.HandlerFunc(s.handleDevices)))
}

// handleSummary mirrors query.ts summary: aggregate usage_hourly grouped by
// provider/model/day over an optional bucket_hour prefix range.
func (s *Server) handleSummary(w http.ResponseWriter, r *http.Request) {
	groupBy := r.URL.Query().Get("group_by")
	if groupBy == "" {
		groupBy = "provider"
	}
	if !groupBySet[groupBy] {
		bad(w, "group_by must be one of: provider,model,day")
		return
	}
	from, to := queryPtr(r, "from"), queryPtr(r, "to")

	groupExpr := groupBy
	if groupBy == "day" {
		groupExpr = "substr(bucket_hour,1,10)"
	}
	sqlStr := `SELECT ` + groupExpr + ` AS key, ` + tokenCols + `
             FROM usage_hourly WHERE 1=1`
	var args []any
	if from != nil {
		sqlStr += " AND bucket_hour >= ?"
		args = append(args, *from)
	}
	if to != nil {
		sqlStr += " AND bucket_hour < ?"
		args = append(args, *to)
	}
	sqlStr += ` GROUP BY ` + groupExpr + ` ORDER BY key`

	rows, err := s.Store.DB().QueryContext(r.Context(), sqlStr, args...)
	if err != nil {
		s.Log.Error("summary query failed", "err", err)
		apperr.Error(w, http.StatusInternalServerError, "internal")
		return
	}
	defer rows.Close()

	out := []summaryRow{}
	for rows.Next() {
		var sr summaryRow
		if err := rows.Scan(&sr.Key, &sr.InputTokens, &sr.OutputTokens, &sr.CacheReadTokens,
			&sr.CacheWriteTokens, &sr.CostUSD, &sr.Requests); err != nil {
			s.Log.Error("summary scan failed", "err", err)
			apperr.Error(w, http.StatusInternalServerError, "internal")
			return
		}
		out = append(out, sr)
	}
	if err := rows.Err(); err != nil {
		s.Log.Error("summary iterate failed", "err", err)
		apperr.Error(w, http.StatusInternalServerError, "internal")
		return
	}
	apperr.WriteJSON(w, http.StatusOK, summaryResponse{GroupBy: groupBy, From: from, To: to, Rows: out})
}

// handleTimeseries mirrors query.ts timeseries.
func (s *Server) handleTimeseries(w http.ResponseWriter, r *http.Request) {
	interval := r.URL.Query().Get("interval")
	if interval == "" {
		interval = "hour"
	}
	groupBy := r.URL.Query().Get("group_by")
	if groupBy == "" {
		groupBy = "provider"
	}
	if !intervalSet[interval] {
		bad(w, "interval must be one of: hour,day")
		return
	}
	if !groupBySet[groupBy] {
		bad(w, "group_by must be one of: provider,model,day")
		return
	}
	from, to := queryPtr(r, "from"), queryPtr(r, "to")

	tsRows, err := s.queryTimeseries(r.Context(), interval, groupBy, from, to)
	if err != nil {
		s.Log.Error("timeseries query failed", "err", err)
		apperr.Error(w, http.StatusInternalServerError, "internal")
		return
	}
	apperr.WriteJSON(w, http.StatusOK, timeseriesResponse{
		Interval: interval, GroupBy: groupBy, From: from, To: to, Rows: tsRows,
	})
}

// queryTimeseries is the shared timeseries read used by both the HTTP handler
// and bootstrap (bootstrap pins interval=hour, group_by=provider).
func (s *Server) queryTimeseries(ctx context.Context, interval, groupBy string, from, to *string) ([]tsRow, error) {
	timeExpr := "bucket_hour"
	if interval == "day" {
		timeExpr = "substr(bucket_hour,1,10)"
	}
	sqlStr := `SELECT ` + timeExpr + ` AS time, ` + groupBy + ` AS series, ` + tokenCols + `
             FROM usage_hourly WHERE 1=1`
	var args []any
	if from != nil {
		sqlStr += " AND bucket_hour >= ?"
		args = append(args, *from)
	}
	if to != nil {
		sqlStr += " AND bucket_hour < ?"
		args = append(args, *to)
	}
	sqlStr += ` GROUP BY ` + timeExpr + `, ` + groupBy + ` ORDER BY time`

	rows, err := s.Store.DB().QueryContext(ctx, sqlStr, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []tsRow{}
	for rows.Next() {
		var tr tsRow
		if err := rows.Scan(&tr.Time, &tr.Series, &tr.InputTokens, &tr.OutputTokens,
			&tr.CacheReadTokens, &tr.CacheWriteTokens, &tr.CostUSD, &tr.Requests); err != nil {
			return nil, err
		}
		out = append(out, tr)
	}
	return out, rows.Err()
}

// handleQuotaCurrent mirrors query.ts quotaCurrent: latest snapshot per
// (provider, metric, account), restricted to keys that still have a credential.
func (s *Server) handleQuotaCurrent(w http.ResponseWriter, r *http.Request) {
	rows, err := s.queryQuotaCurrent(r.Context())
	if err != nil {
		s.Log.Error("quota current query failed", "err", err)
		apperr.Error(w, http.StatusInternalServerError, "internal")
		return
	}
	apperr.WriteJSON(w, http.StatusOK, quotaCurrentResponse{Rows: rows})
}

func (s *Server) queryQuotaCurrent(ctx context.Context) ([]quotaRow, error) {
	rows, err := s.Store.DB().QueryContext(ctx, currentQuotaSQL)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []quotaRow{}
	for rows.Next() {
		var qr quotaRow
		if err := rows.Scan(&qr.Provider, &qr.Metric, &qr.Account, new(int64), // snapshot_id
			&qr.Value, &qr.LimitValue, &qr.Unit, &qr.ResetAt, &qr.CapturedAt,
			new(sql.NullInt64), new(sql.NullFloat64), new(sql.NullString), new(sql.NullString), new(sql.NullString), // previous_*
		); err != nil {
			return nil, err
		}
		out = append(out, qr)
	}
	return out, rows.Err()
}

// handleQuotaHistory mirrors query.ts quotaHistory: direct indexed query when
// provider+metric are given; otherwise a from/to range is required and groups
// are enumerated from quota_current before per-group indexed lookups.
func (s *Server) handleQuotaHistory(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	provider := q.Get("provider")
	metric := q.Get("metric")
	account := q.Get("account")
	hasAccount := q.Has("account")
	from, to := queryPtr(r, "from"), queryPtr(r, "to")

	// provider + metric 命中 idx_quota_latest 的前导列，可以直接安全查询。
	if provider != "" && metric != "" {
		rows, err := s.queryQuotaHistory(r.Context(), quotaGroup{Provider: provider, Metric: metric, Account: account, HasAccount: hasAccount}, from, to)
		if err != nil {
			s.Log.Error("quota history query failed", "err", err)
			apperr.Error(w, http.StatusInternalServerError, "internal")
			return
		}
		apperr.WriteJSON(w, http.StatusOK, map[string]any{"rows": rows})
		return
	}

	// 宽查询必须带时间范围；先从很小的 quota_current 枚举分组，再对每组做精确索引查询。
	if from == nil && to == nil {
		bad(w, "from or to is required unless provider and metric are both specified")
		return
	}

	groupSQL := `SELECT q.provider, q.metric, q.account
                    FROM quota_current q
                   WHERE EXISTS (
                     SELECT 1 FROM credentials c WHERE c.provider = q.provider AND c.name = q.account
                   )`
	var args []any
	if provider != "" {
		groupSQL += " AND q.provider = ?"
		args = append(args, provider)
	}
	if metric != "" {
		groupSQL += " AND q.metric = ?"
		args = append(args, metric)
	}
	if hasAccount {
		groupSQL += " AND q.account = ?"
		args = append(args, account)
	}

	groups, err := func() ([]quotaGroup, error) {
		rows, err := s.Store.DB().QueryContext(r.Context(), groupSQL, args...)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var out []quotaGroup
		for rows.Next() {
			var g quotaGroup
			g.HasAccount = true
			if err := rows.Scan(&g.Provider, &g.Metric, &g.Account); err != nil {
				return nil, err
			}
			out = append(out, g)
		}
		return out, rows.Err()
	}()
	if err != nil {
		s.Log.Error("quota history groups query failed", "err", err)
		apperr.Error(w, http.StatusInternalServerError, "internal")
		return
	}

	all := []quotaHistoryRow{}
	for _, g := range groups {
		rows, err := s.queryQuotaHistory(r.Context(), g, from, to)
		if err != nil {
			s.Log.Error("quota history query failed", "err", err)
			apperr.Error(w, http.StatusInternalServerError, "internal")
			return
		}
		all = append(all, rows...)
	}

	// TS sorts the merged rows by (captured_at, snapshot_id) ascending.
	sort.SliceStable(all, func(i, j int) bool {
		if all[i].CapturedAt != all[j].CapturedAt {
			return all[i].CapturedAt < all[j].CapturedAt
		}
		return all[i].SnapshotID < all[j].SnapshotID
	})
	apperr.WriteJSON(w, http.StatusOK, map[string]any{"rows": all})
}

type quotaGroup struct {
	Provider   string
	Metric     string
	Account    string
	HasAccount bool
}

// queryQuotaHistory runs the per-group indexed history lookup from query.ts
// quotaHistoryStatement.
func (s *Server) queryQuotaHistory(ctx context.Context, g quotaGroup, from, to *string) ([]quotaHistoryRow, error) {
	sqlStr := `SELECT id AS snapshot_id, provider, metric, account, value, limit_value, unit, reset_at, captured_at
               FROM quota_snapshots INDEXED BY idx_quota_latest
              WHERE provider = ? AND metric = ?`
	args := []any{g.Provider, g.Metric}
	if g.HasAccount {
		sqlStr += " AND account = ?"
		args = append(args, g.Account)
	}
	if from != nil {
		sqlStr += " AND captured_at >= ?"
		args = append(args, *from)
	}
	if to != nil {
		sqlStr += " AND captured_at < ?"
		args = append(args, *to)
	}
	sqlStr += " ORDER BY captured_at ASC, id ASC"

	rows, err := s.Store.DB().QueryContext(ctx, sqlStr, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []quotaHistoryRow{}
	for rows.Next() {
		var hr quotaHistoryRow
		if err := rows.Scan(&hr.SnapshotID, &hr.Provider, &hr.Metric, &hr.Account,
			&hr.Value, &hr.LimitValue, &hr.Unit, &hr.ResetAt, &hr.CapturedAt); err != nil {
			return nil, err
		}
		out = append(out, hr)
	}
	return out, rows.Err()
}

// handleBootstrap mirrors query.ts bootstrap: today's hourly per-provider
// timeseries plus the current quota, in one response.
func (s *Server) handleBootstrap(w http.ResponseWriter, r *http.Request) {
	from := queryPtr(r, "from")
	if from == nil {
		today := time.Now().UTC().Format("2006-01-02") + "T00"
		from = &today
	}
	to := queryPtr(r, "to")

	tsRows, err := s.queryTimeseries(r.Context(), "hour", "provider", from, to)
	if err != nil {
		s.Log.Error("bootstrap timeseries failed", "err", err)
		apperr.Error(w, http.StatusInternalServerError, "internal")
		return
	}
	quotaRows, err := s.queryQuotaCurrent(r.Context())
	if err != nil {
		s.Log.Error("bootstrap quota failed", "err", err)
		apperr.Error(w, http.StatusInternalServerError, "internal")
		return
	}
	apperr.WriteJSON(w, http.StatusOK, map[string]any{
		"ts": timeseriesResponse{
			Interval: "hour", GroupBy: "provider", From: from, To: to, Rows: tsRows,
		},
		"quota": quotaCurrentResponse{Rows: quotaRows},
	})
}

// handleDevices mirrors query.ts devices.
func (s *Server) handleDevices(w http.ResponseWriter, r *http.Request) {
	rows, err := s.Store.DB().QueryContext(r.Context(),
		`SELECT device_id, name, last_seen_at FROM devices ORDER BY last_seen_at DESC`)
	if err != nil {
		s.Log.Error("devices query failed", "err", err)
		apperr.Error(w, http.StatusInternalServerError, "internal")
		return
	}
	defer rows.Close()

	type deviceRow struct {
		DeviceID   string  `json:"device_id"`
		Name       *string `json:"name"`
		LastSeenAt *string `json:"last_seen_at"`
	}
	out := []deviceRow{}
	for rows.Next() {
		var d deviceRow
		if err := rows.Scan(&d.DeviceID, &d.Name, &d.LastSeenAt); err != nil {
			s.Log.Error("devices scan failed", "err", err)
			apperr.Error(w, http.StatusInternalServerError, "internal")
			return
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		s.Log.Error("devices iterate failed", "err", err)
		apperr.Error(w, http.StatusInternalServerError, "internal")
		return
	}
	apperr.WriteJSON(w, http.StatusOK, map[string]any{"rows": out})
}
