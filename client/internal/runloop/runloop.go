// Package runloop 编排一次采集循环：收集 → 聚合 → 落 spool → 上传 → 记录状态。
package runloop

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"tokendash/client/internal/aggregate"
	"tokendash/client/internal/auth"
	"tokendash/client/internal/collector"
	"tokendash/client/internal/config"
	"tokendash/client/internal/spool"
	"tokendash/client/internal/state"
	"tokendash/client/internal/upload"
)

type Runner struct {
	Cfg      *config.Config
	Auth     *auth.Store
	StateDir string
	Client   *upload.Client
	Logf     func(format string, args ...any)

	// 测试缝隙：非空时覆盖采集器默认路径
	ClaudeRoot   string
	CursorDB     string
	CodexRoot    string
	GeminiRoot   string
	OpenCodeRoot string
	CopilotRoot  string
}

func New(cfg *config.Config, authStore *auth.Store) (*Runner, error) {
	dir, err := config.Dir()
	if err != nil {
		return nil, err
	}
	stateDir := filepath.Join(dir, "state")
	if err := state.EnsureDir(stateDir); err != nil {
		return nil, err
	}
	return &Runner{
		Cfg:      cfg,
		Auth:     authStore,
		StateDir: stateDir,
		Client:   upload.New(cfg, authStore),
		Logf:     func(f string, a ...any) { fmt.Printf(f+"\n", a...) },
	}, nil
}

// Once 执行一轮：采集并尝试上传。
func (r *Runner) Once() error {
	agg := aggregate.New()
	cp := state.LoadCheckpoint(state.CheckpointPath(r.StateDir))
	enabled := map[string]bool{
		"claude_code": r.Cfg.Sources.ClaudeCode,
		"cursor":      r.Cfg.Sources.Cursor,
		"codex":       r.Cfg.Sources.Codex,
		"gemini":      r.Cfg.Sources.Gemini,
		"opencode":    r.Cfg.Sources.OpenCode,
		"copilot":     r.Cfg.Sources.Copilot,
	}
	for _, c := range collector.Registry(enabled) {
		switch col := c.(type) {
		case *collector.ClaudeCode:
			if r.ClaudeRoot != "" {
				col.Root = r.ClaudeRoot
			}
		case *collector.Cursor:
			if r.CursorDB != "" {
				col.DBPath = r.CursorDB
			}
		case *collector.Codex:
			if r.CodexRoot != "" {
				col.Root = r.CodexRoot
			}
		case *collector.Gemini:
			if r.GeminiRoot != "" {
				col.Root = r.GeminiRoot
			}
		case *collector.OpenCode:
			if r.OpenCodeRoot != "" {
				col.Root = r.OpenCodeRoot
			}
		case *collector.Copilot:
			if r.CopilotRoot != "" {
				col.Root = r.CopilotRoot
			}
		}
		if err := c.Collect(cp, agg); err != nil {
			r.Logf("[%s] 采集失败: %v", c.Name(), err)
		}
	}
	if err := cp.Save(); err != nil {
		return err
	}

	rows := agg.Rows()
	if len(rows) > 0 {
		if err := spool.New(r.StateDir).Append(rows); err != nil {
			return fmt.Errorf("spool append: %w", err)
		}
	}
	r.Logf("本轮采集 %d 行", len(rows))
	return r.Upload()
}

// Upload 排空 spool 并上报心跳。
func (r *Runner) Upload() error {
	s := spool.New(r.StateDir)
	rows, err := s.Drain()
	if err != nil {
		return err
	}
	ls := state.LastSync{At: time.Now(), Rows: len(rows)}
	if len(rows) > 0 {
		n, err := r.Client.IngestUsage(rows)
		if err != nil {
			// 上传失败：行已经不在 spool（Drain 已清空）……
			// 为不丢数据，重新写回 spool。
			_ = s.Append(rows)
			ls.Error = err.Error()
			_ = state.SaveLastSync(r.StateDir, ls)
			return err
		}
		ls.Rows = n
	}
	// 心跳即使无新行也上报（驱动 devices 表）
	if err := r.Client.Heartbeat(); err != nil {
		if err == upload.ErrUnauthorized {
			ls.Error = "登录态失效"
			_ = state.SaveLastSync(r.StateDir, ls)
			return err
		}
		r.Logf("心跳失败: %v", err)
	}
	ls.Error = ""
	return state.SaveLastSync(r.StateDir, ls)
}

// Run 常驻循环。
func (r *Runner) Run(stop <-chan struct{}) error {
	if err := r.Cfg.Ensure(); err != nil {
		return err
	}
	interval, err := time.ParseDuration(r.Cfg.Interval)
	if err != nil || interval <= 0 {
		interval = 5 * time.Minute
	}
	for {
		if err := r.Once(); err != nil {
			r.Logf("本轮失败: %v", err)
		}
		select {
		case <-stop:
			return nil
		case <-time.After(interval):
		}
	}
}

// Status 返回采集状态（checkpoint 数、spool 积压、最近同步）。
func (r *Runner) Status() (map[string]any, error) {
	cp := state.LoadCheckpoint(state.CheckpointPath(r.StateDir))
	sp := spool.New(r.StateDir)
	backlog, err := sp.Count()
	if err != nil {
		return nil, err
	}
	ls, err := state.LoadLastSync(r.StateDir)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"checkpoint_files": cp.Count(),
		"spool_backlog":    backlog,
		"last_sync_at":     ls.At.UTC().Format(time.RFC3339),
		"last_sync_rows":   ls.Rows,
		"last_sync_error":  ls.Error,
		"has_auth":         r.Auth.HasAuth(),
		"device":           r.Cfg.DeviceName,
		"hub_url":          r.Cfg.HubURL,
		"interval":         r.Cfg.Interval,
		"state_dir":        r.StateDir,
		"sources": map[string]bool{
			"claude_code": r.Cfg.Sources.ClaudeCode,
			"cursor":      r.Cfg.Sources.Cursor,
			"codex":       r.Cfg.Sources.Codex,
			"gemini":      r.Cfg.Sources.Gemini,
			"opencode":    r.Cfg.Sources.OpenCode,
			"copilot":     r.Cfg.Sources.Copilot,
		},
	}, nil
}

var _ = os.Getenv
