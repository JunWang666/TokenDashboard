// Package spool 提供落地的待上传队列（JSONL），作为离线缓冲：采集先落 spool，
// 上传成功后删除已确认的行；失败保留待下次重试。
package spool

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"tokendash/client/internal/aggregate"
)

const maxSpoolBytes = 8 << 20 // 8MB 滚动阈值

type Spool struct {
	path string
}

func New(dir string) *Spool {
	return &Spool{path: filepath.Join(dir, "spool.jsonl")}
}

// Append 追加一批行。
func (s *Spool) Append(rows []aggregate.Row) error {
	if len(rows) == 0 {
		return nil
	}
	if fi, err := os.Stat(s.path); err == nil && fi.Size() > maxSpoolBytes {
		if err := s.Rotate(); err != nil {
			return err
		}
	}
	f, err := os.OpenFile(s.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	enc := json.NewEncoder(f)
	for i := range rows {
		if err := enc.Encode(rows[i]); err != nil {
			return err
		}
	}
	return nil
}

// Drain 读取全部未上传行并清空文件（上传方在成功后才调用）。
func (s *Spool) Drain() ([]aggregate.Row, error) {
	f, err := os.Open(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var rows []aggregate.Row
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1024*1024), 1024*1024)
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var r aggregate.Row
		if err := json.Unmarshal(line, &r); err != nil {
			continue // 跳过损坏行
		}
		rows = append(rows, r)
	}
	f.Close()
	if err := sc.Err(); err != nil {
		return nil, err
	}
	if err := os.Truncate(s.path, 0); err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	return rows, nil
}

// Count 返回积压行数。
func (s *Spool) Count() (int, error) {
	f, err := os.Open(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}
	defer f.Close()
	n := 0
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1024*1024), 1024*1024)
	for sc.Scan() {
		if len(sc.Bytes()) > 0 {
			n++
		}
	}
	return n, sc.Err()
}

func (s *Spool) Rotate() error {
	if err := os.Remove(s.path + ".old"); err != nil && !os.IsNotExist(err) {
		return err
	}
	return os.Rename(s.path, s.path+".old")
}

func (s *Spool) Path() string { return s.path }

var _ = fmt.Sprintf
