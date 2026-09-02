// Package state 保存采集 checkpoint（每个日志文件的 inode/offset）与最近同步状态。
package state

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type FileState struct {
	Inode  uint64 `json:"inode"`
	Size   int64  `json:"size"`
	Offset int64  `json:"offset"`
	Model  string `json:"model,omitempty"`
}

// Checkpoint 记录每个数据源每个文件的读取进度。
// key = 文件绝对路径；source 前缀隔离不同采集器。
type Checkpoint struct {
	mu    sync.Mutex
	Files map[string]FileState `json:"files"`
	path  string               `json:"-"`
}

func NewCheckpoint(path string) *Checkpoint {
	return &Checkpoint{Files: map[string]FileState{}, path: path}
}

func LoadCheckpoint(path string) *Checkpoint {
	cp := NewCheckpoint(path)
	b, err := os.ReadFile(path)
	if err != nil {
		return cp
	}
	// Current format wraps the file map so the on-disk schema can evolve.
	// Older clients wrote the map directly; keep loading that format so an
	// upgrade never causes a full history rescan.
	var current struct {
		Files map[string]FileState `json:"files"`
	}
	if err := json.Unmarshal(b, &current); err == nil && current.Files != nil {
		cp.Files = current.Files
		return cp
	}
	var legacy map[string]FileState
	if err := json.Unmarshal(b, &legacy); err == nil && legacy != nil {
		cp.Files = legacy
	}
	return cp
}

func (cp *Checkpoint) Get(path string) (FileState, bool) {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	s, ok := cp.Files[path]
	return s, ok
}

func (cp *Checkpoint) Set(path string, s FileState) {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	cp.Files[path] = s
}

func (cp *Checkpoint) Drop(path string) {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	delete(cp.Files, path)
}

func (cp *Checkpoint) Count() int {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	return len(cp.Files)
}

// Save 原子写盘。
func (cp *Checkpoint) Save() error {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	if cp.path == "" {
		return nil
	}
	b, err := json.MarshalIndent(struct {
		Files map[string]FileState `json:"files"`
	}{Files: cp.Files}, "", "  ")
	if err != nil {
		return err
	}
	return atomicWrite(cp.path, b)
}

type LastSync struct {
	At        time.Time `json:"at"`
	Rows      int       `json:"rows"`
	Error     string    `json:"error,omitempty"`
	HubStatus int       `json:"hub_status"`
}

func (s LastSync) OK() bool { return s.Error == "" }

func LoadLastSync(dir string) (*LastSync, error) {
	var ls LastSync
	b, err := os.ReadFile(filepath.Join(dir, "last_sync.json"))
	if err != nil {
		return &LastSync{}, nil
	}
	if err := json.Unmarshal(b, &ls); err != nil {
		return &LastSync{}, nil
	}
	return &ls, nil
}

func SaveLastSync(dir string, ls LastSync) error {
	b, err := json.MarshalIndent(ls, "", "  ")
	if err != nil {
		return err
	}
	return atomicWrite(filepath.Join(dir, "last_sync.json"), b)
}

func atomicWrite(path string, b []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func FormatNow() string { return time.Now().UTC().Format(time.RFC3339) }

func CheckpointPath(stateDir string) string { return filepath.Join(stateDir, "checkpoint.json") }

func EnsureDir(dir string) error {
	return os.MkdirAll(dir, 0o755)
}

var _ = fmt.Sprintf
