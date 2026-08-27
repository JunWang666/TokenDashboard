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

// Gemini parses Gemini CLI session snapshots under tmp/*/chats/*.json.
// Unlike JSONL logs, these files contain a growing messages array, so Offset
// stores the number of messages already consumed.
type Gemini struct {
	Root string // defaults to GEMINI_CLI_HOME or ~/.gemini
}

func (c *Gemini) Name() string { return "gemini" }

func (c *Gemini) root() string {
	if c.Root != "" {
		return c.Root
	}
	if root := strings.TrimSpace(os.Getenv("GEMINI_CLI_HOME")); root != "" {
		return root
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".gemini")
}

func (c *Gemini) Collect(cp *state.Checkpoint, agg *aggregate.Aggregator) error {
	root := filepath.Join(c.root(), "tmp")
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil || d == nil {
			return nil
		}
		if d.IsDir() || !strings.HasSuffix(strings.ToLower(path), ".json") || !strings.Contains(filepath.ToSlash(path), "/chats/") {
			return nil
		}
		collectGeminiFile(path, cp, agg)
		return nil
	})
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

type geminiSession struct {
	Messages []geminiMessage `json:"messages"`
}

type geminiMessage struct {
	Type      string       `json:"type"`
	Model     string       `json:"model"`
	Timestamp string       `json:"timestamp"`
	Tokens    geminiTokens `json:"tokens"`
}

type geminiTokens struct {
	Input     int64 `json:"input"`
	Output    int64 `json:"output"`
	Cached    int64 `json:"cached"`
	CacheRead int64 `json:"cache_read"`
}

func collectGeminiFile(path string, cp *state.Checkpoint, agg *aggregate.Aggregator) {
	fi, err := os.Stat(path)
	if err != nil {
		return
	}
	inode := fileInode(fi)
	prev, known := cp.Get("gemini:" + path)
	start := int64(0)
	if known && prev.Inode == inode && prev.Offset >= 0 {
		start = prev.Offset
	}
	if known && prev.Inode != inode {
		start = 0
	}

	b, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var session geminiSession
	if json.Unmarshal(b, &session) != nil {
		return
	}
	if start > int64(len(session.Messages)) {
		start = 0 // file was rewritten/compacted
	}
	for _, msg := range session.Messages[start:] {
		if !strings.EqualFold(strings.TrimSpace(msg.Type), "gemini") {
			continue
		}
		cached := maxNonNegative(msg.Tokens.Cached, msg.Tokens.CacheRead)
		input := maxInt64(msg.Tokens.Input)
		output := maxInt64(msg.Tokens.Output)
		if input == 0 && output == 0 && cached == 0 {
			continue
		}
		agg.Add("gemini", "gemini-cli", msg.Model, geminiTime(msg.Timestamp, fi.ModTime()), aggregate.Usage{
			InputTokens:     input,
			OutputTokens:    output,
			CacheReadTokens: cached,
		})
	}
	cp.Set("gemini:"+path, state.FileState{Inode: inode, Size: fi.Size(), Offset: int64(len(session.Messages))})
}

func geminiTime(raw string, fallback time.Time) time.Time {
	if t, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(raw)); err == nil {
		return t.UTC()
	}
	if !fallback.IsZero() {
		return fallback.UTC()
	}
	return Now().UTC()
}
