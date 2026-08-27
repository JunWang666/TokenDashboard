// Package collector 定义数据源采集器接口与实现。
package collector

import (
	"time"

	"tokendash/client/internal/aggregate"
	"tokendash/client/internal/state"
)

// Collector 从本地日志增量读取用量。
// Collect 从 checkpoint 之后读取增量，返回聚合行与推进后的 checkpoint。
type Collector interface {
	Name() string
	Collect(cp *state.Checkpoint, agg *aggregate.Aggregator) error
}

// 返回当前时间（可注入测试）。
var Now = func() time.Time { return time.Now() }

// Registry 返回启用的采集器。
func Registry(enabled map[string]bool) []Collector {
	var out []Collector
	if enabled["claude_code"] {
		out = append(out, &ClaudeCode{})
	}
	if enabled["cursor"] {
		out = append(out, &Cursor{})
	}
	if enabled["codex"] {
		out = append(out, &Codex{})
	}
	if enabled["gemini"] {
		out = append(out, &Gemini{})
	}
	if enabled["opencode"] {
		out = append(out, &OpenCode{})
	}
	if enabled["copilot"] {
		out = append(out, &Copilot{})
	}
	return out
}
