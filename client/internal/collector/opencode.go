package collector

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "github.com/mattn/go-sqlite3"

	"tokendash/client/internal/aggregate"
	"tokendash/client/internal/state"
)

// OpenCode parses both the current SQLite store and the legacy per-message
// JSON files. SQLite is preferred when a supported message table is present;
// this avoids counting migrated legacy messages twice.
type OpenCode struct {
	Root string // defaults to XDG_DATA_HOME/opencode or ~/.local/share/opencode
}

func (c *OpenCode) Name() string { return "opencode" }

func (c *OpenCode) roots() []string {
	if c.Root != "" {
		return []string{c.Root}
	}
	home, _ := os.UserHomeDir()
	roots := []string{}
	if base := strings.TrimSpace(os.Getenv("XDG_DATA_HOME")); base != "" {
		roots = append(roots, filepath.Join(base, "opencode"))
	}
	roots = append(roots, filepath.Join(home, ".local", "share", "opencode"))
	if runtimeRoot := filepath.Join(home, "Library", "Application Support", "opencode"); runtimeRoot != roots[len(roots)-1] {
		roots = append(roots, runtimeRoot)
	}
	return roots
}

func (c *OpenCode) Collect(cp *state.Checkpoint, agg *aggregate.Aggregator) error {
	for _, root := range c.roots() {
		dbSupported := false
		for _, name := range []string{"opencode.db", "opencode-stable.db", "opencode-next.db"} {
			path := filepath.Join(root, name)
			handled, err := collectOpenCodeDB(path, cp, agg)
			if err != nil {
				return err
			}
			dbSupported = dbSupported || handled
		}
		if !dbSupported {
			if err := collectOpenCodeJSON(filepath.Join(root, "storage", "message"), cp, agg); err != nil && !os.IsNotExist(err) {
				return err
			}
		}
	}
	return nil
}

type openCodeMessage struct {
	ID         string          `json:"id"`
	Role       string          `json:"role"`
	ModelID    string          `json:"modelID"`
	ProviderID string          `json:"providerID"`
	Model      *openCodeModel  `json:"model"`
	Cost       float64         `json:"cost"`
	Tokens     *openCodeTokens `json:"tokens"`
	Time       *openCodeTime   `json:"time"`
}

type openCodeModel struct {
	ID         string `json:"id"`
	ProviderID string `json:"providerID"`
}

type openCodeTokens struct {
	Input     int64          `json:"input"`
	Output    int64          `json:"output"`
	Reasoning int64          `json:"reasoning"`
	Cache     *openCodeCache `json:"cache"`
}

type openCodeCache struct {
	Read  int64 `json:"read"`
	Write int64 `json:"write"`
}

type openCodeTime struct {
	Created   float64 `json:"created"`
	Completed float64 `json:"completed"`
}

type parsedOpenCode struct {
	id          string
	provider    string
	model       string
	input       int64
	output      int64
	cacheRead   int64
	cacheWrite  int64
	cost        float64
	createdUnix int64
}

func parseOpenCodeMessage(data []byte, requireAssistant bool) *parsedOpenCode {
	var msg openCodeMessage
	if json.Unmarshal(data, &msg) != nil {
		return nil
	}
	if requireAssistant && !strings.EqualFold(strings.TrimSpace(msg.Role), "assistant") {
		return nil
	}
	if msg.Role != "" && !strings.EqualFold(msg.Role, "assistant") {
		return nil
	}
	if msg.ModelID == "" && msg.Model != nil {
		msg.ModelID = msg.Model.ID
	}
	if msg.ProviderID == "" && msg.Model != nil {
		msg.ProviderID = msg.Model.ProviderID
	}
	if strings.TrimSpace(msg.ModelID) == "" || msg.Tokens == nil || msg.Time == nil {
		return nil
	}
	if msg.Tokens.Input <= 0 && msg.Tokens.Output <= 0 && msg.Tokens.Reasoning <= 0 && (msg.Tokens.Cache == nil || (msg.Tokens.Cache.Read <= 0 && msg.Tokens.Cache.Write <= 0)) {
		return nil
	}
	var cacheRead, cacheWrite int64
	if msg.Tokens.Cache != nil {
		cacheRead = maxInt64(msg.Tokens.Cache.Read)
		cacheWrite = maxInt64(msg.Tokens.Cache.Write)
	}
	return &parsedOpenCode{
		id:          msg.ID,
		provider:    normalizeOpenCodeProvider(msg.ProviderID, msg.ModelID),
		model:       strings.TrimSpace(msg.ModelID),
		input:       maxInt64(msg.Tokens.Input),
		output:      maxInt64(msg.Tokens.Output),
		cacheRead:   cacheRead,
		cacheWrite:  cacheWrite,
		cost:        maxFloat(msg.Cost),
		createdUnix: int64(msg.Time.Created),
	}
}

func normalizeOpenCodeProvider(raw, model string) string {
	p := strings.ToLower(strings.TrimSpace(raw))
	m := strings.ToLower(strings.TrimSpace(model))
	switch {
	case strings.Contains(p, "anthropic") || strings.HasPrefix(m, "claude"):
		return "claude"
	case strings.Contains(p, "openai") || strings.HasPrefix(m, "gpt-") || strings.HasPrefix(m, "o1") || strings.HasPrefix(m, "o3") || strings.HasPrefix(m, "o4"):
		return "openai"
	case strings.Contains(p, "google") || strings.Contains(p, "gemini") || strings.HasPrefix(m, "gemini"):
		return "gemini"
	case strings.Contains(p, "deepseek") || strings.HasPrefix(m, "deepseek"):
		return "deepseek"
	case strings.Contains(p, "moonshot") || strings.Contains(p, "kimi") || strings.HasPrefix(m, "kimi"):
		return "kimi"
	case strings.Contains(p, "minimax") || strings.HasPrefix(m, "minimax"):
		return "minimax"
	case p == "glm" || strings.Contains(p, "zhipu"):
		return "glm"
	case p == "zai" || strings.Contains(p, "z.ai"):
		return "zai"
	case p == "copilot" || strings.Contains(p, "github"):
		return "copilot"
	case p == "cursor":
		return "cursor"
	case strings.Contains(p, "anyrouter.top"):
		return "anyrouter_top"
	case p == "anyrouter" || strings.Contains(p, "anyrouter"):
		return "anyrouter"
	case p == "claude" || p == "openai" || p == "gemini" || p == "deepseek" || p == "kimi" || p == "minimax" || p == "glm" || p == "zai" || p == "codex" || p == "copilot" || p == "cursor" || p == "anyrouter" || p == "anyrouter_top":
		return p
	default:
		return "opencode"
	}
}

func collectOpenCodeJSON(root string, cp *state.Checkpoint, agg *aggregate.Aggregator) error {
	return filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil || d == nil {
			return nil
		}
		if d.IsDir() || !strings.HasSuffix(strings.ToLower(path), ".json") {
			return nil
		}
		fi, err := os.Stat(path)
		if err != nil {
			return nil
		}
		key := "opencode:json:" + path
		prev, known := cp.Get(key)
		inode := fileInode(fi)
		if known && prev.Inode == inode && prev.Size == fi.Size() && prev.Offset > 0 {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		if row := parseOpenCodeMessage(data, true); row != nil {
			addOpenCodeRow(agg, row, openCodeTimeValue(row.createdUnix))
		}
		cp.Set(key, state.FileState{Inode: inode, Size: fi.Size(), Offset: 1})
		return nil
	})
}

func collectOpenCodeDB(path string, cp *state.Checkpoint, agg *aggregate.Aggregator) (bool, error) {
	fi, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, nil
	}
	db, err := sql.Open("sqlite3", "file:"+path+"?mode=ro&_busy_timeout=2000")
	if err != nil {
		return false, nil
	}
	defer db.Close()

	if hasSQLiteRows(db, "session_message") {
		return true, collectOpenCodeTable(db, path, "session_message", cp, agg, true, fi)
	}
	if hasSQLiteRows(db, "message") {
		return true, collectOpenCodeTable(db, path, "message", cp, agg, false, fi)
	}
	return false, nil
}

func hasSQLiteTable(db *sql.DB, name string) bool {
	var count int
	if db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?`, name).Scan(&count) != nil {
		return false
	}
	return count > 0
}

func hasSQLiteRows(db *sql.DB, name string) bool {
	if !hasSQLiteTable(db, name) {
		return false
	}
	var count int
	if db.QueryRow("SELECT COUNT(*) FROM "+name).Scan(&count) != nil {
		return false
	}
	return count > 0
}

func collectOpenCodeTable(db *sql.DB, path, table string, cp *state.Checkpoint, agg *aggregate.Aggregator, hasType bool, fi os.FileInfo) error {
	key := "opencode:sqlite:" + path + ":" + table
	prev, known := cp.Get(key)
	inode := fileInode(fi)
	lastRowID := int64(0)
	if known && prev.Inode == inode && prev.Size <= fi.Size() {
		lastRowID = prev.Offset
	}
	var rows *sql.Rows
	var err error
	if hasType {
		rows, err = db.Query(`SELECT rowid, id, type, data FROM session_message WHERE rowid > ? AND type = 'assistant' ORDER BY rowid ASC LIMIT 20000`, lastRowID)
	} else {
		rows, err = db.Query(`SELECT rowid, id, data FROM message WHERE rowid > ? ORDER BY rowid ASC LIMIT 20000`, lastRowID)
	}
	if err != nil {
		return nil // private schema: skip this source when it changes
	}
	defer rows.Close()
	maxRowID := lastRowID
	seen := map[string]struct{}{}
	for rows.Next() {
		var rowID int64
		var id, data string
		var typ string
		if hasType {
			if rows.Scan(&rowID, &id, &typ, &data) != nil {
				continue
			}
		} else if rows.Scan(&rowID, &id, &data) != nil {
			continue
		}
		if rowID > maxRowID {
			maxRowID = rowID
		}
		row := parseOpenCodeMessage([]byte(data), !hasType)
		if row == nil {
			continue
		}
		if row.id == "" {
			row.id = id
		}
		if _, ok := seen[row.id]; ok {
			continue
		}
		seen[row.id] = struct{}{}
		addOpenCodeRow(agg, row, openCodeTimeValue(row.createdUnix))
	}
	if err := rows.Err(); err != nil {
		return nil
	}
	cp.Set(key, state.FileState{Inode: inode, Size: fi.Size(), Offset: maxRowID})
	return nil
}

func addOpenCodeRow(agg *aggregate.Aggregator, row *parsedOpenCode, at time.Time) {
	agg.Add(row.provider, "opencode", row.model, at, aggregate.Usage{
		InputTokens:      row.input,
		OutputTokens:     row.output,
		CacheReadTokens:  row.cacheRead,
		CacheWriteTokens: row.cacheWrite,
		CostUSD:          row.cost,
	})
}

func openCodeTimeValue(unixMillis int64) time.Time {
	if unixMillis > 0 {
		return time.UnixMilli(unixMillis).UTC()
	}
	return Now().UTC()
}

func maxFloat(v float64) float64 {
	if v < 0 {
		return 0
	}
	return v
}
