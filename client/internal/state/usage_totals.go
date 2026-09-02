package state

import (
	"encoding/json"
	"os"
	"sort"

	"tokendash/client/internal/aggregate"
)

// UsageTotals keeps the last successfully uploaded absolute value for every
// usage bucket. Collectors produce deltas, while the hub uses idempotent
// overwrite upserts, so each upload must contain an absolute bucket value.
type UsageTotals struct {
	Rows map[string]aggregate.Row `json:"rows"`
	path string
}

func LoadUsageTotals(path string) *UsageTotals {
	t := &UsageTotals{Rows: map[string]aggregate.Row{}, path: path}
	b, err := os.ReadFile(path)
	if err != nil {
		return t
	}
	if err := json.Unmarshal(b, t); err != nil || t.Rows == nil {
		t.Rows = map[string]aggregate.Row{}
	}
	t.path = path
	return t
}

// Overlay applies newer absolute rows, such as snapshots already waiting in
// the spool after a failed upload.
func (t *UsageTotals) Overlay(rows []aggregate.Row) {
	for _, row := range rows {
		t.Rows[usageRowKey(row)] = row
	}
}

// Add merges collector deltas and returns the new absolute values for only the
// buckets changed in this scan.
func (t *UsageTotals) Add(deltas []aggregate.Row) []aggregate.Row {
	changed := make(map[string]aggregate.Row, len(deltas))
	for _, delta := range deltas {
		key := usageRowKey(delta)
		row, ok := t.Rows[key]
		if !ok {
			row = aggregate.Row{
				Provider: delta.Provider, Source: delta.Source,
				Model: delta.Model, BucketHour: delta.BucketHour,
			}
		}
		row.InputTokens += delta.InputTokens
		row.OutputTokens += delta.OutputTokens
		row.CacheReadTokens += delta.CacheReadTokens
		row.CacheWriteTokens += delta.CacheWriteTokens
		row.CostUSD += delta.CostUSD
		row.Requests += delta.Requests
		t.Rows[key] = row
		changed[key] = row
	}
	return sortedUsageRows(changed)
}

func (t *UsageTotals) Save() error {
	if t.path == "" {
		return nil
	}
	b, err := json.MarshalIndent(struct {
		Rows map[string]aggregate.Row `json:"rows"`
	}{Rows: t.Rows}, "", "  ")
	if err != nil {
		return err
	}
	return atomicWrite(t.path, b)
}

// CoalesceUsageRows keeps the newest absolute snapshot for each bucket. The
// spool may contain older snapshots followed by a newer one after an outage.
func CoalesceUsageRows(rows []aggregate.Row) []aggregate.Row {
	latest := make(map[string]aggregate.Row, len(rows))
	for _, row := range rows {
		latest[usageRowKey(row)] = row
	}
	return sortedUsageRows(latest)
}

func sortedUsageRows(rows map[string]aggregate.Row) []aggregate.Row {
	out := make([]aggregate.Row, 0, len(rows))
	for _, row := range rows {
		out = append(out, row)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].BucketHour != out[j].BucketHour {
			return out[i].BucketHour < out[j].BucketHour
		}
		if out[i].Provider != out[j].Provider {
			return out[i].Provider < out[j].Provider
		}
		if out[i].Source != out[j].Source {
			return out[i].Source < out[j].Source
		}
		return out[i].Model < out[j].Model
	})
	return out
}

func usageRowKey(row aggregate.Row) string {
	return row.Provider + "\x00" + row.Source + "\x00" + row.Model + "\x00" + row.BucketHour
}

func UsageTotalsPath(stateDir string) string {
	return stateDir + string(os.PathSeparator) + "usage_totals.json"
}
