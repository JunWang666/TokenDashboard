package collector

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"tokendash/client/internal/aggregate"
	"tokendash/client/internal/state"
)

// ClaudeCode 解析 ~/.claude/projects/**/*.jsonl 的 assistant 消息 usage。
// 增量：按 inode+offset 记 checkpoint，追加写入的文件只读新尾部。
type ClaudeCode struct {
	Root string // 默认 ~/.claude/projects；测试可注入
}

func (c *ClaudeCode) Name() string { return "claude_code" }

func (c *ClaudeCode) root() string {
	if c.Root != "" {
		return c.Root
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude", "projects")
}

// Collect 扫描所有 *.jsonl 的增量。
func (c *ClaudeCode) Collect(cp *state.Checkpoint, agg *aggregate.Aggregator) error {
	root := c.root()
	if err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil // 跳过无法访问的目录
		}
		if d.IsDir() || !strings.HasSuffix(path, ".jsonl") {
			return nil
		}
		collectFile(c, cp, agg, path)
		return nil
	}); err != nil {
		if os.IsNotExist(err) {
			return nil // 目录不存在 = 未安装 Claude Code
		}
		return err
	}
	return nil
}

// claudeJsonlLine 匹配 Claude Code 日志行。
type claudeJsonlLine struct {
	Type    string `json:"type"`
	Message *struct {
		Model   string `json:"model"`
		Usage   *Usage `json:"usage"`
		Message *struct {
			Model string `json:"model"`
		} `json:"message"`
	} `json:"message"`
}

// Usage 是 claude-code 的 usage 字段结构。
type Usage struct {
	InputTokens              int64 `json:"input_tokens"`
	OutputTokens             int64 `json:"output_tokens"`
	CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
	CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
}

func (u *Usage) TotalInput() int64 {
	return u.InputTokens + u.CacheReadInputTokens + u.CacheCreationInputTokens
}

func collectFile(c *ClaudeCode, cp *state.Checkpoint, agg *aggregate.Aggregator, path string) {
	fi, err := os.Stat(path)
	if err != nil {
		return
	}
	inode := fileInode(fi)
	prev, known := cp.Get(path)
	if known && prev.Inode != inode {
		cp.Drop(path) // 文件被轮转/替换，从头读
		prev, known = cp.Get(path)
	}
	offset := int64(0)
	if known {
		offset = prev.Offset
	}
	// 文件被截断时回退到开头
	if known && prev.Size > fi.Size() {
		offset = 0
	}

	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	if offset > 0 {
		if _, err := f.Seek(offset, io.SeekStart); err != nil {
			return
		}
	}

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 4<<20), 4<<20)
	var bytesRead int64 = offset
	for sc.Scan() {
		line := sc.Bytes()
		bytesRead += int64(len(line)) + 1 // +1 换行
		row := parseClaudeLine(line)
		if row == nil {
			continue
		}
		agg.Add("claude", "claude-code", row.model, Now(), aggregate.Usage{
			InputTokens:      row.input,
			OutputTokens:     row.output,
			CacheReadTokens:  row.cacheRead,
			CacheWriteTokens: row.cacheWrite,
			CostUSD:          estimateClaudeCost(row.model, row.input, row.output, row.cacheRead, row.cacheWrite),
		})
	}

	if err := sc.Err(); err != nil {
		return
	}
	cp.Set(path, state.FileState{Inode: inode, Size: fi.Size(), Offset: bytesRead})
}

type parsedClaude struct {
	model      string
	input      int64
	output     int64
	cacheRead  int64
	cacheWrite int64
}

func parseClaudeLine(line []byte) *parsedClaude {
	var rec claudeJsonlLine
	if err := json.Unmarshal(line, &rec); err != nil {
		return nil
	}
	// 只取 assistant 消息；部分版本 usage 挂在外层 message，部分在 message.message
	if rec.Type != "assistant" {
		return nil
	}
	msg := rec.Message
	if msg == nil || msg.Usage == nil {
		return nil
	}
	model := msg.Model
	if model == "" && msg.Message != nil {
		model = msg.Message.Model
	}
	u := msg.Usage
	return &parsedClaude{
		model:      model,
		input:      u.InputTokens,
		output:     u.OutputTokens,
		cacheRead:  u.CacheReadInputTokens,
		cacheWrite: u.CacheCreationInputTokens,
	}
}

// estimateClaudeCost 按公开价目表估算（$/100 万 token，1:10 缓存读）。
func estimateClaudeCost(model string, in, out, cacheRead, cacheWrite int64) float64 {
	p := claudePrice(model)
	return float64(in)*p.input + float64(out)*p.output +
		float64(cacheRead)*p.cacheRead + float64(cacheWrite)*p.cacheWrite
}

type price struct{ input, output, cacheRead, cacheWrite float64 } // 每 token

func claudePrice(model string) price {
	m := strings.ToLower(model)
	switch {
	case strings.Contains(m, "opus"):
		return price{5e-6, 25e-6, 0.5e-6, 6.25e-6}
	case strings.Contains(m, "sonnet"):
		return price{3e-6, 15e-6, 0.3e-6, 3.75e-6}
	case strings.Contains(m, "haiku"):
		return price{1e-6, 5e-6, 0.1e-6, 1.25e-6}
	default:
		return price{3e-6, 15e-6, 0.3e-6, 3.75e-6}
	}
}

func fileInode(fi os.FileInfo) uint64 {
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		return st.Ino
	}
	return 0
}

var _ = fmt.Sprintf
