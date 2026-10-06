-- 0004: 额度告警推送 —— 推送订阅（web / iOS）与告警事件（dedupe_key 去重，同一事件只推一次）
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         INTEGER PRIMARY KEY,
  platform   TEXT NOT NULL,
  endpoint   TEXT NOT NULL UNIQUE,
  keys_json  TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS alert_events (
  id         INTEGER PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  kind       TEXT NOT NULL,
  provider   TEXT NOT NULL,
  metric     TEXT NOT NULL,
  account    TEXT NOT NULL DEFAULT '',
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
