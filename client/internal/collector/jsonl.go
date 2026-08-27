package collector

import (
	"bufio"
	"io"
	"os"
	"path/filepath"
	"strings"

	"tokendash/client/internal/state"
)

// walkJSONL walks a directory tree and incrementally feeds appended JSONL
// records to onLine. The checkpoint is advanced only after the complete file
// has been scanned successfully.
func walkJSONL(root string, cp *state.Checkpoint, prefix string, onLine func([]byte)) error {
	return walkJSONLWithState(root, cp, prefix, func(line []byte, _ *string) { onLine(line) })
}

func walkJSONLWithModel(root string, cp *state.Checkpoint, prefix string, onLine func([]byte, *string)) error {
	return walkJSONLWithState(root, cp, prefix, onLine)
}

func walkJSONLWithState(root string, cp *state.Checkpoint, prefix string, onLine func([]byte, *string)) error {
	return filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil || d == nil {
			return nil
		}
		if d.IsDir() || !strings.HasSuffix(strings.ToLower(path), ".jsonl") {
			return nil
		}
		scanJSONLFileWithState(path, prefix, cp, onLine)
		return nil
	})
}

func scanJSONLFile(path, prefix string, cp *state.Checkpoint, onLine func([]byte)) {
	scanJSONLFileWithState(path, prefix, cp, func(line []byte, _ *string) { onLine(line) })
}

func scanJSONLFileWithModel(path, prefix string, cp *state.Checkpoint, onLine func([]byte, *string)) {
	scanJSONLFileWithState(path, prefix, cp, onLine)
}

func scanJSONLFileWithState(path, prefix string, cp *state.Checkpoint, onLine func([]byte, *string)) {
	fi, err := os.Stat(path)
	if err != nil {
		return
	}
	inode := fileInode(fi)
	key := prefix + path
	prev, known := cp.Get(key)
	if known && prev.Inode != inode {
		cp.Drop(key)
		prev, known = cp.Get(key)
	}
	offset := int64(0)
	model := ""
	if known {
		offset = prev.Offset
		model = prev.Model
		if prev.Size > fi.Size() {
			offset = 0
			model = ""
		}
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
	bytesRead := offset
	for sc.Scan() {
		line := append([]byte(nil), sc.Bytes()...)
		bytesRead += int64(len(line)) + 1
		onLine(line, &model)
	}
	if sc.Err() != nil {
		return
	}
	cp.Set(key, state.FileState{Inode: inode, Size: fi.Size(), Offset: bytesRead, Model: model})
}
