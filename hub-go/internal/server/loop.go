package server

import (
	"context"
	"time"

	"tokendash/hub/internal/alerts"
	"tokendash/hub/internal/notify"
)

// Collector is the quota-collection hook invoked by the background loop (the
// built-in runner collector in collect.go); when nil, collection is skipped
// with a debug log. Collect returns the number of quota rows written,
// mirroring the TS collect() return value.
type Collector interface {
	Collect(ctx context.Context) (int, error)
}

// RunBackground starts the periodic collect → alert-sweep → push-dispatch →
// notify cycle on a ticker with s.Cfg.CollectInterval (the Go equivalent of
// the TS Worker's scheduled event). It returns immediately; the loop stops
// when ctx is cancelled.
func (s *Server) RunBackground(ctx context.Context) {
	interval := s.Cfg.CollectInterval
	if interval <= 0 {
		interval = 15 * time.Minute
	}
	ticker := time.NewTicker(interval)
	go func() {
		for {
			select {
			case <-ctx.Done():
				ticker.Stop()
				return
			case <-ticker.C:
				s.runCycle(ctx)
			}
		}
	}()
}

// runCycle executes one sweep of the background loop. Every step is isolated:
// a failure is logged and does not abort the remaining steps, matching the
// independent try/catch blocks in index.ts scheduled.
func (s *Server) runCycle(ctx context.Context) {
	if s.Collector != nil {
		n, err := s.Collector.Collect(ctx)
		if err != nil {
			s.Log.Error("collect failed", "err", err)
		} else {
			s.Log.Info("collect done", "rows", n)
		}
	} else {
		s.Log.Debug("collector not configured, skipping collect")
	}

	// Alert sweep: evaluate quota_current, persist new events, enqueue deliveries.
	events, err := alerts.RunSweep(ctx, s.Store.DB(), s.Log)
	if err != nil {
		s.Log.Error("alert sweep failed", "err", err)
	}

	// Drain fresh deliveries plus retries left behind by an earlier sweep.
	summary, err := s.pushSender().DispatchPending(ctx, s.Store.DB())
	if err != nil {
		s.Log.Error("push dispatch failed", "err", err)
	} else if summary.Processed > 0 {
		s.Log.Info("push dispatch done",
			"processed", summary.Processed, "sent", summary.Sent,
			"retrying", summary.Retrying, "failed", summary.Failed)
	}

	// Fan fresh events out to Feishu/Bark (only when there are new events,
	// mirroring index.ts calling dispatchNotify with the fresh list).
	if len(events) > 0 {
		notify.Dispatch(ctx, s.Store.DB(), s.Crypt, s.Log, events)
	}
}
