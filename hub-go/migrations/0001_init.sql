-- TokenDashboard hub 初始 schema

-- 用量，按小时聚合（客户端聚合后上报，天然幂等）
CREATE TABLE IF NOT EXISTS usage_hourly (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id          TEXT NOT NULL,
  provider           TEXT NOT NULL,
  source             TEXT NOT NULL,
  model              TEXT,
  bucket_hour        TEXT NOT NULL,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd           REAL    NOT NULL DEFAULT 0,
  requests           INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (device_id, provider, source, model, bucket_hour)
);
CREATE INDEX IF NOT EXISTS idx_usage_bucket ON usage_hourly (provider, bucket_hour);

-- plan 额度快照（runner 采集，append-only）
CREATE TABLE IF NOT EXISTS quota_snapshots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  provider    TEXT NOT NULL,
  metric      TEXT NOT NULL,
  value       REAL NOT NULL,
  limit_value REAL,
  unit        TEXT,
  reset_at    TEXT,
  captured_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_quota_latest ON quota_snapshots (provider, metric, captured_at DESC);

-- 设备心跳
CREATE TABLE IF NOT EXISTS devices (
  device_id    TEXT PRIMARY KEY,
  name         TEXT,
  last_seen_at TEXT
);

-- runner 凭证（加密存储：payload_enc 为 AES-256-GCM 密文的 base64）
CREATE TABLE IF NOT EXISTS credentials (
  provider    TEXT PRIMARY KEY,
  payload_enc TEXT NOT NULL,
  hint        TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by  TEXT
);
