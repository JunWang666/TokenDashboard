package spool

import (
	"os"
	"testing"
	"time"

	"tokendash/client/internal/aggregate"
)

func row(id string) aggregate.Row {
	return aggregate.Row{
		Provider:    "claude",
		Source:      "claude-code",
		Model:       id,
		BucketHour:  time.Now().UTC().Truncate(time.Hour).Format("2006-01-02T15:04:05") + "Z",
		InputTokens: 1,
		Requests:    1,
	}
}

func TestSpoolRoundtrip(t *testing.T) {
	s := New(t.TempDir())
	if n, _ := s.Count(); n != 0 {
		t.Fatal("empty spool should count 0")
	}
	if err := s.Append([]aggregate.Row{row("a"), row("b")}); err != nil {
		t.Fatal(err)
	}
	if n, _ := s.Count(); n != 2 {
		t.Fatalf("count want 2 got %d", n)
	}
	rows, err := s.Drain()
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("drain want 2 got %d", len(rows))
	}
	if n, _ := s.Count(); n != 0 {
		t.Fatal("drain should empty spool")
	}
}

func TestSpoolAppendDrainCycle(t *testing.T) {
	s := New(t.TempDir())
	if err := s.Append([]aggregate.Row{row("x")}); err != nil {
		t.Fatal(err)
	}
	rows, _ := s.Drain()
	if err := s.Append(rows); err != nil { // 失败重写回 spool
		t.Fatal(err)
	}
	if n, _ := s.Count(); n != 1 {
		t.Fatal("rewritten row should persist")
	}
}

func TestSpoolReadAllDoesNotClearUntilAck(t *testing.T) {
	s := New(t.TempDir())
	if err := s.Append([]aggregate.Row{row("pending")}); err != nil {
		t.Fatal(err)
	}
	rows, err := s.ReadAll()
	if err != nil || len(rows) != 1 {
		t.Fatalf("read pending rows: len=%d err=%v", len(rows), err)
	}
	if n, _ := s.Count(); n != 1 {
		t.Fatal("ReadAll should leave rows pending")
	}
	if err := s.Clear(); err != nil {
		t.Fatal(err)
	}
	if n, _ := s.Count(); n != 0 {
		t.Fatal("Clear should acknowledge pending rows")
	}
}

func TestSpoolCorruptLine(t *testing.T) {
	s := New(t.TempDir())
	if err := s.Append([]aggregate.Row{row("ok")}); err != nil {
		t.Fatal(err)
	}
	// 追加损坏行（模拟半写入）
	f, _ := os.OpenFile(s.path, os.O_APPEND|os.O_WRONLY, 0o600)
	f.WriteString("{\"not json\n")
	f.Close()
	rows, err := s.Drain()
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("corrupt line should be skipped, got %d rows", len(rows))
	}
}
