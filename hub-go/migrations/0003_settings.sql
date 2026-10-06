-- 0003: 通用设置表（当前用于 collect webhook：点「立即采集」时通知公网可达的独立 runner）
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
