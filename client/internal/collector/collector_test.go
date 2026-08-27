package collector

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	_ "github.com/mattn/go-sqlite3"

	"tokendash/client/internal/aggregate"
	"tokendash/client/internal/state"
)

func writeLine(t *testing.T, f *os.File, s string) {
	t.Helper()
	if _, err := f.WriteString(s + "\n"); err != nil {
		t.Fatal(err)
	}
}

func TestClaudeCodeIncremental(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "session.jsonl")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	writeLine(t, f, `{"type":"user","message":{}}`)
	writeLine(t, f, `{"type":"assistant","message":{"model":"claude-sonnet-4-5","usage":{"input_tokens":100,"output_tokens":20,"cache_read_input_tokens":500,"cache_creation_input_tokens":10}}}`)
	writeLine(t, f, `{"type":"assistant","message":{"model":"claude-opus-4-5","usage":{"input_tokens":200,"output_tokens":40}}}`)
	writeLine(t, f, `garbage-line-not-json`)

	cp := state.NewCheckpoint("")
	agg := aggregate.New()
	c := &ClaudeCode{Root: filepath.Dir(path)}
	if err := c.Collect(cp, agg); err != nil {
		t.Fatal(err)
	}
	rows := agg.Rows()
	if len(rows) != 2 {
		t.Fatalf("want 2 rows, got %d", len(rows))
	}
	sonnet := rows[0]
	if sonnet.Model != "claude-sonnet-4-5" || sonnet.InputTokens != 100 || sonnet.OutputTokens != 20 {
		t.Fatalf("bad sonnet row: %+v", sonnet)
	}
	if sonnet.CacheReadTokens != 500 || sonnet.CacheWriteTokens != 10 {
		t.Fatalf("bad cache: %+v", sonnet)
	}
	if sonnet.CostUSD <= 0 {
		t.Fatalf("cost should be estimated, got %v", sonnet.CostUSD)
	}
	if rows[1].Requests != 1 || sonnet.Requests != 1 {
		t.Fatal("requests should be 1 per assistant msg")
	}

	// 追加新行后再次采集：只读增量
	writeLine(t, f, `{"type":"assistant","message":{"model":"claude-sonnet-4-5","usage":{"input_tokens":7,"output_tokens":3}}}`)
	agg2 := aggregate.New()
	if err := c.Collect(cp, agg2); err != nil {
		t.Fatal(err)
	}
	rows2 := agg2.Rows()
	if len(rows2) != 1 || rows2[0].InputTokens != 7 {
		t.Fatalf("incremental collect wrong: %+v", rows2)
	}
}

func TestClaudeCodeNoDirectory(t *testing.T) {
	cp := state.NewCheckpoint("")
	agg := aggregate.New()
	c := &ClaudeCode{Root: filepath.Join(t.TempDir(), "nonexistent")}
	if err := c.Collect(cp, agg); err != nil {
		t.Fatal("missing dir should be ok, got", err)
	}
}

func TestClaudeCostPrices(t *testing.T) {
	cases := []struct {
		model string
		in    int64
		out   int64
		want  float64
	}{
		{"claude-sonnet-4-5", 1_000_000, 1_000_000, 18.0},
		{"claude-opus-4-5", 1_000_000, 1_000_000, 30.0},
	}
	for _, c := range cases {
		got := estimateClaudeCost(c.model, c.in, c.out, 0, 0)
		if got != c.want {
			t.Fatalf("%s: want %.2f got %.2f", c.model, c.want, got)
		}
	}
}

func TestCursorMissingDB(t *testing.T) {
	cp := state.NewCheckpoint("")
	agg := aggregate.New()
	c := &Cursor{DBPath: filepath.Join(t.TempDir(), "state.vscdb")}
	if err := c.Collect(cp, agg); err != nil {
		t.Fatal("missing db should be ok, got", err)
	}
}

func TestCodexIncremental(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "sessions")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "2026-08-27.jsonl")
	if err := os.WriteFile(path, []byte(
		`{"type":"event_msg","timestamp":"2026-08-27T01:02:03Z","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":120,"output_tokens":30,"cached_input_tokens":20},"model":"gpt-5"}}}`+"\n"+`{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":7,"output_tokens":3}}}}`+"\n",
	), 0o600); err != nil {
		t.Fatal(err)
	}
	cp := state.NewCheckpoint("")
	agg := aggregate.New()
	if err := (&Codex{Root: filepath.Dir(dir)}).Collect(cp, agg); err != nil {
		t.Fatal(err)
	}
	rows := agg.Rows()
	if len(rows) != 2 || rows[0].Provider != "codex" || rows[0].InputTokens != 100 || rows[0].CacheReadTokens != 20 {
		t.Fatalf("bad codex rows: %+v", rows)
	}
	if rows[1].Model != "gpt-5" || rows[1].OutputTokens != 3 {
		t.Fatalf("bad model fallback: %+v", rows[1])
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.WriteString(`{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":4,"output_tokens":2}}}}` + "\n")
	_ = f.Close()
	agg2 := aggregate.New()
	if err := (&Codex{Root: filepath.Dir(dir)}).Collect(cp, agg2); err != nil {
		t.Fatal(err)
	}
	rows = agg2.Rows()
	if len(rows) != 1 || rows[0].InputTokens != 4 || rows[0].OutputTokens != 2 {
		t.Fatalf("codex should be incremental: %+v", rows)
	}
}

func TestGeminiIncrementalMessages(t *testing.T) {
	root := filepath.Join(t.TempDir(), "gemini")
	path := filepath.Join(root, "tmp", "project", "chats", "session.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(messages string) {
		t.Helper()
		if err := os.WriteFile(path, []byte(`{"messages":[`+messages+`]}`), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write(`{"type":"gemini","model":"gemini-2.5-pro","tokens":{"input":100,"output":20,"cached":30}}`)
	cp := state.NewCheckpoint("")
	agg := aggregate.New()
	if err := (&Gemini{Root: root}).Collect(cp, agg); err != nil {
		t.Fatal(err)
	}
	rows := agg.Rows()
	if len(rows) != 1 || rows[0].Provider != "gemini" || rows[0].InputTokens != 100 || rows[0].CacheReadTokens != 30 {
		t.Fatalf("bad gemini row: %+v", rows)
	}
	write(`{"type":"gemini","model":"gemini-2.5-pro","tokens":{"input":100,"output":20,"cached":30}},` +
		`{"type":"gemini","model":"gemini-2.5-flash","tokens":{"input":9,"output":4}}`)
	agg2 := aggregate.New()
	if err := (&Gemini{Root: root}).Collect(cp, agg2); err != nil {
		t.Fatal(err)
	}
	rows = agg2.Rows()
	if len(rows) != 1 || rows[0].Model != "gemini-2.5-flash" || rows[0].InputTokens != 9 {
		t.Fatalf("gemini should read only appended message: %+v", rows)
	}
}

func TestCopilotChatSpansOnly(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "copilot.jsonl")
	content := `{"type":"span","name":"chat gpt-5","attributes":{"gen_ai.operation.name":"chat","gen_ai.response.model":"gpt-5","gen_ai.usage.input_tokens":1234,"gen_ai.usage.output_tokens":"56","gen_ai.usage.cache_read.input_tokens":10}}` + "\n" +
		`{"type":"span","name":"tool call","attributes":{"gen_ai.operation.name":"execute_tool","gen_ai.usage.input_tokens":999}}` + "\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	cp := state.NewCheckpoint("")
	agg := aggregate.New()
	if err := (&Copilot{Root: root}).Collect(cp, agg); err != nil {
		t.Fatal(err)
	}
	rows := agg.Rows()
	if len(rows) != 1 || rows[0].Provider != "copilot" || rows[0].InputTokens != 1234 || rows[0].OutputTokens != 56 || rows[0].CacheReadTokens != 10 {
		t.Fatalf("bad copilot row: %+v", rows)
	}
}

func TestOpenCodeSQLiteIncremental(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "opencode.db")
	db, err := sql.Open("sqlite3", path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL)`)
	if err != nil {
		t.Fatal(err)
	}
	message := `{"id":"msg-1","role":"assistant","modelID":"claude-sonnet-4","providerID":"anthropic","cost":0.12,"tokens":{"input":100,"output":20,"reasoning":3,"cache":{"read":40,"write":5}},"time":{"created":1787788800000}}`
	if _, err = db.Exec(`INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)`, "row-1", "session-1", message); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	cp := state.NewCheckpoint("")
	agg := aggregate.New()
	if err := (&OpenCode{Root: root}).Collect(cp, agg); err != nil {
		t.Fatal(err)
	}
	rows := agg.Rows()
	if len(rows) != 1 || rows[0].Provider != "claude" || rows[0].InputTokens != 100 || rows[0].CacheReadTokens != 40 || rows[0].CostUSD != 0.12 {
		t.Fatalf("bad opencode row: %+v", rows)
	}
	db, err = sql.Open("sqlite3", path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)`, "row-2", "session-1", `{"id":"msg-2","role":"assistant","model":{"id":"gpt-5","providerID":"openai"},"tokens":{"input":8,"output":2,"cache":{"read":0,"write":0}},"time":{"created":1787788860000}}`)
	if err != nil {
		t.Fatal(err)
	}
	_ = db.Close()
	agg2 := aggregate.New()
	if err := (&OpenCode{Root: root}).Collect(cp, agg2); err != nil {
		t.Fatal(err)
	}
	rows = agg2.Rows()
	if len(rows) != 1 || rows[0].Provider != "openai" || rows[0].InputTokens != 8 {
		t.Fatalf("opencode should be incremental: %+v", rows)
	}
}
