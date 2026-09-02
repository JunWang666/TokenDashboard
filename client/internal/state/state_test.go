package state

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"tokendash/client/internal/aggregate"
)

func TestCheckpointRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "checkpoint.json")
	want := FileState{Inode: 42, Size: 120, Offset: 80, Model: "gpt-test"}
	cp := NewCheckpoint(path)
	cp.Set("codex:/tmp/session.jsonl", want)
	if err := cp.Save(); err != nil {
		t.Fatal(err)
	}

	got, ok := LoadCheckpoint(path).Get("codex:/tmp/session.jsonl")
	if !ok || got != want {
		t.Fatalf("checkpoint round trip: got %+v, ok=%v; want %+v", got, ok, want)
	}
}

func TestUsageTotalsMergePendingAndDeltas(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage_totals.json")
	base := aggregate.Row{
		Provider: "claude", Source: "claude-code", Model: "sonnet", BucketHour: "2026-08-28T06:00:00Z",
		InputTokens: 40, OutputTokens: 8, Requests: 1,
	}
	totals := LoadUsageTotals(path)
	totals.Overlay([]aggregate.Row{base})
	if err := totals.Save(); err != nil {
		t.Fatal(err)
	}

	pending := base
	pending.InputTokens = 50
	pending.OutputTokens = 10
	pending.Requests = 2
	totals = LoadUsageTotals(path)
	totals.Overlay([]aggregate.Row{pending})
	changed := totals.Add([]aggregate.Row{{
		Provider: "claude", Source: "claude-code", Model: "sonnet", BucketHour: "2026-08-28T06:00:00Z",
		InputTokens: 5, OutputTokens: 1, Requests: 1,
	}})
	if len(changed) != 1 || changed[0].InputTokens != 55 || changed[0].OutputTokens != 11 || changed[0].Requests != 3 {
		t.Fatalf("unexpected cumulative row: %+v", changed)
	}
}

func TestCoalesceUsageRowsKeepsNewestAbsoluteValue(t *testing.T) {
	old := aggregate.Row{Provider: "codex", Source: "codex-cli", Model: "gpt", BucketHour: "2026-08-28T06:00:00Z", InputTokens: 10}
	latest := old
	latest.InputTokens = 25
	rows := CoalesceUsageRows([]aggregate.Row{old, latest})
	if len(rows) != 1 || rows[0].InputTokens != 25 {
		t.Fatalf("unexpected coalesced rows: %+v", rows)
	}
}

func TestCheckpointLoadsLegacyBareMap(t *testing.T) {
	path := filepath.Join(t.TempDir(), "checkpoint.json")
	want := FileState{Inode: 7, Size: 99, Offset: 99}
	b, err := json.Marshal(map[string]FileState{"/tmp/legacy.jsonl": want})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatal(err)
	}

	got, ok := LoadCheckpoint(path).Get("/tmp/legacy.jsonl")
	if !ok || got != want {
		t.Fatalf("legacy checkpoint: got %+v, ok=%v; want %+v", got, ok, want)
	}
}
