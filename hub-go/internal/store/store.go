// Package store opens the embedded SQLite database and applies migrations.
package store

import (
	"database/sql"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	_ "modernc.org/sqlite"

	"tokendash/hub/migrations"
)

const dsnPragmas = "?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)"

// Store wraps the SQLite database handle.
type Store struct {
	db *sql.DB
}

// Open opens (creating if necessary) the SQLite database at path, ensures the
// parent directory exists, and applies any pending migrations.
func Open(path string) (*Store, error) {
	if dir := filepath.Dir(path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("create db directory: %w", err)
		}
	}

	dsn := path
	if !strings.Contains(dsn, "?") {
		dsn += dsnPragmas
	} else {
		dsn += "&" + strings.TrimPrefix(dsnPragmas, "?")
	}

	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("ping sqlite: %w", err)
	}

	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return s, nil
}

// DB returns the underlying database handle.
func (s *Store) DB() *sql.DB { return s.db }

// Close closes the underlying database handle.
func (s *Store) Close() error { return s.db.Close() }

// migrate applies embedded .sql migrations in filename order, recording each
// applied version in schema_migrations.
func (s *Store) migrate() error {
	if _, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
		version    TEXT PRIMARY KEY,
		applied_at TEXT NOT NULL DEFAULT (datetime('now'))
	)`); err != nil {
		return err
	}

	names, err := fs.Glob(migrations.FS, "*.sql")
	if err != nil {
		return err
	}
	sort.Strings(names)

	for _, name := range names {
		version := strings.TrimSuffix(filepath.Base(name), ".sql")
		var exists int
		if err := s.db.QueryRow(`SELECT 1 FROM schema_migrations WHERE version = ?`, version).Scan(&exists); err == nil {
			continue
		} else if err != sql.ErrNoRows {
			return err
		}

		body, err := migrations.FS.ReadFile(name)
		if err != nil {
			return err
		}
		if _, err := s.db.Exec(string(body)); err != nil {
			return fmt.Errorf("apply %s: %w", version, err)
		}
		if _, err := s.db.Exec(`INSERT INTO schema_migrations (version) VALUES (?)`, version); err != nil {
			return err
		}
	}
	return nil
}
