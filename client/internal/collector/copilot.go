package collector

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"tokendash/client/internal/aggregate"
	"tokendash/client/internal/state"
)

// Copilot parses file-exported OpenTelemetry chat spans from GitHub Copilot
// CLI. Tool spans and cumulative metric records are intentionally ignored.
type Copilot struct {
	Root string // defaults to COPILOT_OTEL_FILE_EXPORTER_PATH or ~/.copilot/otel
}

func (c *Copilot) Name() string { return "copilot" }

func (c *Copilot) root() string {
	if c.Root != "" {
		return c.Root
	}
	if path := strings.TrimSpace(os.Getenv("COPILOT_OTEL_FILE_EXPORTER_PATH")); path != "" {
		return path
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".copilot", "otel")
}

func (c *Copilot) Collect(cp *state.Checkpoint, agg *aggregate.Aggregator) error {
	root := c.root()
	if fi, err := os.Stat(root); err == nil && !fi.IsDir() {
		scanJSONLFile(root, "copilot:", cp, func(line []byte) {
			addCopilotLine(line, agg)
		})
		return nil
	}
	err := walkJSONL(root, cp, "copilot:", func(line []byte) { addCopilotLine(line, agg) })
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

type copilotSpan struct {
	Type               string                     `json:"type"`
	Name               string                     `json:"name"`
	Timestamp          json.RawMessage            `json:"timestamp"`
	StartTime          json.RawMessage            `json:"startTime"`
	StartTime2         json.RawMessage            `json:"start_time"`
	StartTimeUnixNano  json.RawMessage            `json:"startTimeUnixNano"`
	StartTimeUnixNano2 json.RawMessage            `json:"start_time_unix_nano"`
	Attributes         map[string]json.RawMessage `json:"attributes"`
}

func addCopilotLine(line []byte, agg *aggregate.Aggregator) {
	var span copilotSpan
	if json.Unmarshal(line, &span) != nil {
		return
	}
	op := attrString(span.Attributes, "gen_ai.operation.name")
	if !strings.EqualFold(op, "chat") && !strings.HasPrefix(strings.ToLower(span.Name), "chat ") {
		return
	}
	model := attrString(span.Attributes, "gen_ai.response.model")
	input := attrInt64(span.Attributes, "gen_ai.usage.input_tokens")
	output := attrInt64(span.Attributes, "gen_ai.usage.output_tokens")
	cacheRead := attrInt64(span.Attributes, "gen_ai.usage.cache_read.input_tokens")
	cacheWrite := attrInt64(span.Attributes, "gen_ai.usage.cache_creation.input_tokens")
	if input == 0 && output == 0 && cacheRead == 0 && cacheWrite == 0 {
		return
	}
	agg.Add("copilot", "copilot-cli", model, parseCopilotTime(span.Timestamp, span.StartTime, span.StartTime2, span.StartTimeUnixNano, span.StartTimeUnixNano2), aggregate.Usage{
		InputTokens:      maxInt64(input),
		OutputTokens:     maxInt64(output),
		CacheReadTokens:  maxInt64(cacheRead),
		CacheWriteTokens: maxInt64(cacheWrite),
	})
}

func parseCopilotTime(values ...json.RawMessage) time.Time {
	for _, raw := range values {
		if len(raw) == 0 || string(raw) == "null" {
			continue
		}
		var s string
		if json.Unmarshal(raw, &s) == nil {
			if t, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(s)); err == nil {
				return t.UTC()
			}
			if n, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64); err == nil {
				return unixFlexible(n)
			}
		}
		var n json.Number
		if json.Unmarshal(raw, &n) == nil {
			if v, err := strconv.ParseInt(n.String(), 10, 64); err == nil {
				return unixFlexible(v)
			}
		}
	}
	return Now().UTC()
}

func unixFlexible(v int64) time.Time {
	// OTEL uses Unix nanoseconds; a few exporters use milliseconds.
	if v >= 1_000_000_000_000_000 {
		return time.Unix(0, v).UTC()
	}
	if v >= 1_000_000_000_000 {
		return time.UnixMilli(v).UTC()
	}
	return time.Unix(v, 0).UTC()
}

func attrString(attrs map[string]json.RawMessage, key string) string {
	raw, ok := attrs[key]
	if !ok {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return strings.TrimSpace(s)
	}
	return strings.Trim(strings.TrimSpace(string(raw)), `"`)
}

func attrInt64(attrs map[string]json.RawMessage, key string) int64 {
	raw, ok := attrs[key]
	if !ok {
		return 0
	}
	var n json.Number
	if json.Unmarshal(raw, &n) == nil {
		if v, err := strconv.ParseInt(n.String(), 10, 64); err == nil {
			return v
		}
		if v, err := strconv.ParseFloat(n.String(), 64); err == nil {
			return int64(v)
		}
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		v, _ := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
		return v
	}
	return 0
}
