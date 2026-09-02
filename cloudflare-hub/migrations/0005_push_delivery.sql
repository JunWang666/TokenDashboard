-- 0005: 推送环境与逐订阅投递状态。告警事件先持久化，再由可重试队列投递。
ALTER TABLE push_subscriptions ADD COLUMN environment TEXT NOT NULL DEFAULT '';
ALTER TABLE push_subscriptions ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
ALTER TABLE push_subscriptions ADD COLUMN last_success_at TEXT;
ALTER TABLE push_subscriptions ADD COLUMN last_error TEXT;

CREATE TABLE IF NOT EXISTS push_deliveries (
  id                  INTEGER PRIMARY KEY,
  event_id            INTEGER NOT NULL REFERENCES alert_events(id) ON DELETE CASCADE,
  subscription_id     INTEGER NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'sending', 'retry', 'sent', 'failed')),
  attempts            INTEGER NOT NULL DEFAULT 0,
  next_attempt_at     TEXT NOT NULL DEFAULT (datetime('now')),
  last_attempt_at     TEXT,
  sent_at             TEXT,
  http_status         INTEGER,
  provider_message_id TEXT,
  last_error          TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (event_id, subscription_id)
);

CREATE INDEX IF NOT EXISTS idx_push_deliveries_due
  ON push_deliveries (status, next_attempt_at, id);
CREATE INDEX IF NOT EXISTS idx_push_deliveries_subscription
  ON push_deliveries (subscription_id, id DESC);
