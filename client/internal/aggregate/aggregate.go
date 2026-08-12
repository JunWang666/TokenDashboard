// Package aggregate 把采集到的用量按 (provider, source, model, 小时桶) 聚合成上行行。
package aggregate

import (
	"sort"
	"time"
)

// Row 与 hub 的 usage_hourly 表对应。
type Row struct {
	Provider         string  `json:"provider"`
	Source           string  `json:"source"`
	Model            string  `json:"model,omitempty"`
	BucketHour       string  `json:"bucket_hour"`
	InputTokens      int64   `json:"input_tokens"`
	OutputTokens     int64   `json:"output_tokens"`
	CacheReadTokens  int64   `json:"cache_read_tokens"`
	CacheWriteTokens int64   `json:"cache_write_tokens"`
	CostUSD          float64 `json:"cost_usd"`
	Requests         int64   `json:"requests"`
}

type Aggregator struct {
	m map[string]*Row
}

func New() *Aggregator { return &Aggregator{m: map[string]*Row{}} }

// Add 累加一次用量事件。ts 用于定位小时桶。
func (a *Aggregator) Add(provider, source, model string, ts time.Time, usage Usage) {
	if model == "" {
		model = "unknown"
	}
	key := provider + "\x00" + source + "\x00" + model + "\x00" + hourBucket(ts)
	r, ok := a.m[key]
	if !ok {
		r = &Row{
			Provider: provider, Source: source, Model: model,
			BucketHour: hourBucket(ts),
		}
		a.m[key] = r
	}
	r.InputTokens += usage.InputTokens
	r.OutputTokens += usage.OutputTokens
	r.CacheReadTokens += usage.CacheReadTokens
	r.CacheWriteTokens += usage.CacheWriteTokens
	r.CostUSD += usage.CostUSD
	r.Requests++
}

// Usage 单次用量。
type Usage struct {
	InputTokens      int64
	OutputTokens     int64
	CacheReadTokens  int64
	CacheWriteTokens int64
	CostUSD          float64
}

// Rows 返回按时间排序的行。
func (a *Aggregator) Rows() []Row {
	rows := make([]Row, 0, len(a.m))
	for _, r := range a.m {
		rows = append(rows, *r)
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].BucketHour != rows[j].BucketHour {
			return rows[i].BucketHour < rows[j].BucketHour
		}
		return rows[i].Provider < rows[j].Provider
	})
	return rows
}

func hourBucket(ts time.Time) string {
	return ts.UTC().Truncate(time.Hour).Format("2006-01-02T15:04:05") + "Z"
}
