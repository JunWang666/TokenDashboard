package collector

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"

	"tokendash/client/internal/aggregate"
	"tokendash/client/internal/state"
)

// Codex parses Codex CLI session JSONL files. Codex persists per-turn usage
// in event_msg/token_count records, so the collector can safely consume only
// the appended tail of each session.
type Codex struct {
	Root string // defaults to CODEX_HOME or ~/.codex
}

func (c *Codex) Name() string { return "codex" }

func (c *Codex) root() string {
	if c.Root != "" {
		return c.Root
	}
	if root := strings.TrimSpace(os.Getenv("CODEX_HOME")); root != "" {
		return root
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".codex")
}

func (c *Codex) Collect(cp *state.Checkpoint, agg *aggregate.Aggregator) error {
	root := c.root()
	for _, dir := range []string{filepath.Join(root, "sessions"), filepath.Join(root, "archived_sessions")} {
		if err := walkJSONLWithModel(dir, cp, "codex:", func(line []byte, currentModel *string) {
			if model := parseCodexModel(line); model != "" {
				*currentModel = model
			}
			row := parseCodexLine(line)
			if row == nil {
				return
			}
			if row.model == "" {
				row.model = *currentModel
			}
			agg.Add("codex", "codex-cli", row.model, row.at, aggregate.Usage{
				InputTokens:      row.input,
				OutputTokens:     row.output,
				CacheReadTokens:  row.cacheRead,
				CacheWriteTokens: row.cacheWrite,
			})
		}); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

type codexLine struct {
	Type      string `json:"type"`
	Timestamp string `json:"timestamp"`
	Payload   struct {
		Type  string `json:"type"`
		Model string `json:"model"`
		Info  *struct {
			Model          string      `json:"model"`
			ModelName      string      `json:"model_name"`
			LastTokenUsage *codexUsage `json:"last_token_usage"`
			ModelInfo      *struct {
				Slug string `json:"slug"`
				ID   string `json:"id"`
			} `json:"model_info"`
		} `json:"info"`
	} `json:"payload"`
}

type codexUsage struct {
	InputTokens              int64 `json:"input_tokens"`
	OutputTokens             int64 `json:"output_tokens"`
	CachedInputTokens        int64 `json:"cached_input_tokens"`
	CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
	CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
}

type parsedCodex struct {
	model      string
	input      int64
	output     int64
	cacheRead  int64
	cacheWrite int64
	at         time.Time
}

func parseCodexLine(line []byte) *parsedCodex {
	var rec codexLine
	if json.Unmarshal(line, &rec) != nil || rec.Type != "event_msg" || rec.Payload.Type != "token_count" || rec.Payload.Info == nil {
		return nil
	}
	// total_token_usage is cumulative; only last_token_usage is safe to add as
	// an event. This mirrors tokscale's primary Codex accounting path and avoids
	// replaying the whole session total on every token_count event.
	u := rec.Payload.Info.LastTokenUsage
	if u == nil {
		return nil
	}
	cacheRead := maxNonNegative(u.CachedInputTokens, u.CacheReadInputTokens)
	cacheWrite := maxNonNegative(u.CacheCreationInputTokens, 0)
	model := strings.TrimSpace(rec.Payload.Model)
	if model == "" {
		model = strings.TrimSpace(rec.Payload.Info.Model)
	}
	if model == "" {
		model = strings.TrimSpace(rec.Payload.Info.ModelName)
	}
	if model == "" && rec.Payload.Info.ModelInfo != nil {
		model = strings.TrimSpace(rec.Payload.Info.ModelInfo.Slug)
		if model == "" {
			model = strings.TrimSpace(rec.Payload.Info.ModelInfo.ID)
		}
	}
	return &parsedCodex{
		model:      model,
		input:      maxInt64(u.InputTokens - cacheRead),
		output:     maxInt64(u.OutputTokens),
		cacheRead:  cacheRead,
		cacheWrite: cacheWrite,
		at:         parseRecordTime(rec.Timestamp),
	}
}

func parseCodexModel(line []byte) string {
	var rec codexLine
	if json.Unmarshal(line, &rec) != nil {
		return ""
	}
	if model := strings.TrimSpace(rec.Payload.Model); model != "" {
		return model
	}
	if rec.Payload.Info != nil {
		if model := strings.TrimSpace(rec.Payload.Info.Model); model != "" {
			return model
		}
		if model := strings.TrimSpace(rec.Payload.Info.ModelName); model != "" {
			return model
		}
		if rec.Payload.Info.ModelInfo != nil {
			if model := strings.TrimSpace(rec.Payload.Info.ModelInfo.Slug); model != "" {
				return model
			}
			if model := strings.TrimSpace(rec.Payload.Info.ModelInfo.ID); model != "" {
				return model
			}
		}
	}
	return ""
}

func parseRecordTime(raw string) time.Time {
	if t, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(raw)); err == nil {
		return t.UTC()
	}
	return Now().UTC()
}

func maxNonNegative(a, b int64) int64 {
	if a < 0 {
		a = 0
	}
	if b < 0 {
		b = 0
	}
	if a > b {
		return a
	}
	return b
}

func maxInt64(v int64) int64 {
	if v < 0 {
		return 0
	}
	return v
}
