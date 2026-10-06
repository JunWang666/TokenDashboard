package server

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"tokendash/hub/internal/alerts"
	"tokendash/hub/internal/apperr"
	"tokendash/hub/internal/auth"
	"tokendash/hub/internal/runner"
)

func (s *Server) registerCollect(mux *http.ServeMux) {
	mux.Handle("POST /api/v1/collect", s.require(auth.RoleUser, auth.RoleClient)(http.HandlerFunc(s.handleCollect)))
}

// runnerCollector adapts the collect pipeline to the Collector hook run by the
// background loop (loop.go).
type runnerCollector struct {
	s *Server
}

// NewCollector builds the built-in runner collector for s. It is assigned to
// Server.Collector by cmd/hub; leaving it nil disables built-in collection.
func NewCollector(s *Server) Collector { return runnerCollector{s: s} }

// Collect runs one collection round: decrypt internal-runner credentials → run
// each provider's adapter (failures become scrape_error rows) → write
// quota_snapshots → notify the external runner webhook when configured.
// It returns the number of quota rows written, mirroring the TS collect().
func (c runnerCollector) Collect(ctx context.Context) (int, error) {
	n, err := c.s.collectOnce(ctx)
	if err != nil {
		return n, err
	}
	// 配置了 collect-webhook 时通知独立 runner；失败只记日志，不影响本轮采集。
	if result := c.s.notifyExternalRunner(ctx); result != nil && strings.HasPrefix(*result, "failed:") {
		c.s.Log.Warn("external runner webhook failed", "result", *result)
	}
	return n, nil
}

// collectOnce mirrors src/runner/index.ts collect(): pull credentials, run
// every adapter, report the snapshot rows. Returns the number of rows.
func (s *Server) collectOnce(ctx context.Context) (int, error) {
	entries, err := s.decryptCredentials(ctx, false) // 内置 runner：除 kimi/codex 外的全部
	if err != nil {
		return 0, err
	}

	var rows []quotaRow
	for _, e := range entries {
		if e.errMsg != "" {
			continue // TS collect() skips cred.__error__ entries
		}
		account := e.name
		if account == "" {
			account = "默认"
		}
		for _, r := range runner.Run(e.provider, e.flatten()) {
			rows = append(rows, quotaRow{
				Provider:   r.Provider,
				Metric:     r.Metric,
				Account:    account,
				Value:      r.Value,
				LimitValue: r.LimitValue,
				Unit:       r.Unit,
				ResetAt:    r.ResetAt,
			})
		}
	}

	if len(rows) > 0 {
		if err := s.writeQuotaRows(ctx, rows); err != nil {
			return 0, fmt.Errorf("ingest quota: %w", err)
		}
	}
	return len(rows), nil
}

// notifyExternalRunner mirrors settings.ts notifyRunner: POST the configured
// collect-webhook URL (10s timeout) with the decrypted secret as a Bearer
// token. Returns nil when unconfigured, else "triggered" / "failed: <原因>".
func (s *Server) notifyExternalRunner(ctx context.Context) *string {
	settings, err := s.readSettings(ctx)
	if err != nil {
		s.Log.Error("collect-webhook settings read failed", "err", err)
		return nil
	}
	webhookURL := settings[keyCollectWebhookURL]
	if webhookURL == "" {
		return nil
	}

	fail := func(msg string) *string { return &msg }
	headers := map[string]string{}
	if enc := settings[keyCollectWebhookSecret]; enc != "" {
		plain, err := s.Crypt.Decrypt(enc)
		if err != nil {
			return fail("failed: " + err.Error())
		}
		headers["Authorization"] = "Bearer " + string(plain)
	}

	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, http.MethodPost, webhookURL, nil)
	if err != nil {
		return fail("failed: " + err.Error())
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return fail("failed: " + err.Error())
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fail(fmt.Sprintf("failed: HTTP %d", res.StatusCode))
	}
	triggered := "triggered"
	return &triggered
}

// handleCollect mirrors index.ts POST /api/v1/collect (主动触发一轮额度采集，
// 配置了 webhook 时同步通知独立 runner).
func (s *Server) handleCollect(w http.ResponseWriter, r *http.Request) {
	n, err := s.collectOnce(r.Context())
	if err != nil {
		apperr.WriteJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	// TS: runAlertSweepSafely — the sweep failure is logged, never fails the request.
	if _, err := alerts.RunSweep(r.Context(), s.Store.DB(), s.Log); err != nil {
		s.Log.Error("alert sweep failed", "err", err)
	}
	runnerResult := s.notifyExternalRunner(r.Context())
	apperr.WriteJSON(w, http.StatusOK, map[string]any{"ok": true, "rows": n, "runner": runnerResult})
}

// handleTrigger mirrors index.ts GET /__trigger (手动触发一轮额度采集).
func (s *Server) handleTrigger(w http.ResponseWriter, r *http.Request) {
	n, err := s.collectOnce(r.Context())
	if err != nil {
		apperr.WriteJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	if _, err := alerts.RunSweep(r.Context(), s.Store.DB(), s.Log); err != nil {
		s.Log.Error("alert sweep failed", "err", err)
	}
	apperr.WriteJSON(w, http.StatusOK, map[string]any{"ok": true, "rows": n})
}
