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

// Cursor 解析 Cursor 本地状态库 state.vscdb 的 ai_usage 表。
// 注意：这是私有数据库，格式变动风险高，解析失败时静默返回（不影响其他采集器）。
type Cursor struct {
	DBPath string // 默认 ~/.cursor/state.vscdb；测试可注入
}

func (c *Cursor) Name() string { return "cursor" }

func (c *Cursor) dbPath() string {
	if c.DBPath != "" {
		return c.DBPath
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".cursor", "state.vscdb")
}

func (c *Cursor) Collect(cp *state.Checkpoint, agg *aggregate.Aggregator) error {
	path := c.dbPath()
	if _, err := os.Stat(path); err != nil {
		return nil // 未安装 Cursor
	}
	cpKey := "cursor:" + path
	prev, known := cp.Get(cpKey)
	var lastID int64
	if known {
		lastID = prev.Offset
	}

	db, err := sql.Open("sqlite3", "file:"+path+"?mode=ro&_busy_timeout=2000")
	if err != nil {
		return nil
	}
	defer db.Close()

	// 确认表结构存在（格式变动时直接跳过）
	var hasTable int
	if err := db.QueryRow(
		`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='ai_usage'`,
	).Scan(&hasTable); err != nil || hasTable == 0 {
		return nil
	}
	cols, err := tableColumns(db)
	if err != nil || !hasCol(cols, "id") || !hasCol(cols, "usage") {
		return nil
	}

	rows, err := db.Query(`SELECT id, created_at, provider, model, usage FROM ai_usage WHERE id > ? ORDER BY id ASC LIMIT 20000`, lastID)
	if err != nil {
		return nil
	}
	defer rows.Close()

	maxID := lastID
	for rows.Next() {
		var (
			id        int64
			createdAt string
			provider  sql.NullString
			model     sql.NullString
			usageJSON string
		)
		if err := rows.Scan(&id, &createdAt, &provider, &model, &usageJSON); err != nil {
			continue
		}
		if id > maxID {
			maxID = id
		}
		var u struct {
			InputTokens              int64 `json:"input_tokens"`
			OutputTokens             int64 `json:"output_tokens"`
			CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
			CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
		}
		if err := json.Unmarshal([]byte(usageJSON), &u); err != nil {
			continue
		}
		if u.InputTokens == 0 && u.OutputTokens == 0 {
			continue
		}
		agg.Add("cursor", "cursor", strings.TrimSpace(model.String), cursorTime(createdAt), aggregate.Usage{
			InputTokens:      u.InputTokens,
			OutputTokens:     u.OutputTokens,
			CacheReadTokens:  u.CacheReadInputTokens,
			CacheWriteTokens: u.CacheCreationInputTokens,
		})
	}
	cp.Set(cpKey, state.FileState{Offset: maxID})
	return nil
}

func tableColumns(db *sql.DB) ([]string, error) {
	rows, err := db.Query(`PRAGMA table_info(ai_usage)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var cols []string
	for rows.Next() {
		var (
			cid   int
			name  string
			ctype string
			notn  int
			dflt  sql.NullString
			pk    int
		)
		if err := rows.Scan(&cid, &name, &ctype, &notn, &dflt, &pk); err != nil {
			return nil, err
		}
		cols = append(cols, name)
	}
	return cols, nil
}

func hasCol(cols []string, want string) bool {
	for _, c := range cols {
		if c == want {
			return true
		}
	}
	return false
}

// cursorTime 兼容毫秒时间戳与 ISO 字符串。
func cursorTime(s string) time.Time {
	if ms, err := parseInt(s); err == nil {
		return time.UnixMilli(ms).UTC()
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t.UTC()
	}
	return time.Now().UTC()
}

func parseInt(s string) (int64, error) {
	var n int64
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return 0, errNotNumber
		}
		n = n*10 + int64(s[i]-'0')
	}
	return n, nil
}

var errNotNumber = &parseErr{}

type parseErr struct{}

func (*parseErr) Error() string { return "not a number" }
