package collector

import (
	"os"
	"path/filepath"
	"testing"

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
