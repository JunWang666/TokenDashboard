-- 0006: 物化每个额度指标的最新/上一条快照，避免读路径反复扫描整张历史表。
--
-- 仅从尾部最多 10,000 条快照回填，迁移成本有硬上限；之后由 trigger 在写入时 O(1) 维护。
CREATE TABLE IF NOT EXISTS quota_current (
  provider             TEXT NOT NULL,
  metric               TEXT NOT NULL,
  account              TEXT NOT NULL DEFAULT '',
  snapshot_id          INTEGER NOT NULL,
  value                REAL NOT NULL,
  limit_value          REAL,
  unit                 TEXT,
  reset_at             TEXT,
  captured_at          TEXT NOT NULL,
  previous_snapshot_id INTEGER,
  previous_value       REAL,
  previous_unit        TEXT,
  previous_reset_at    TEXT,
  previous_captured_at TEXT,
  PRIMARY KEY (provider, metric, account)
);

WITH recent AS (
  SELECT id, provider, metric, account, value, limit_value, unit, reset_at, captured_at,
         ROW_NUMBER() OVER (PARTITION BY provider, metric, account ORDER BY id DESC) AS rn
    FROM (
      SELECT id, provider, metric, account, value, limit_value, unit, reset_at, captured_at
        FROM quota_snapshots
       ORDER BY id DESC
       LIMIT 10000
    )
)
INSERT OR REPLACE INTO quota_current (
  provider, metric, account, snapshot_id, value, limit_value, unit, reset_at, captured_at,
  previous_snapshot_id, previous_value, previous_unit, previous_reset_at, previous_captured_at
)
SELECT provider,
       metric,
       account,
       MAX(CASE WHEN rn = 1 THEN id END),
       MAX(CASE WHEN rn = 1 THEN value END),
       MAX(CASE WHEN rn = 1 THEN limit_value END),
       MAX(CASE WHEN rn = 1 THEN unit END),
       MAX(CASE WHEN rn = 1 THEN reset_at END),
       MAX(CASE WHEN rn = 1 THEN captured_at END),
       MAX(CASE WHEN rn = 2 THEN id END),
       MAX(CASE WHEN rn = 2 THEN value END),
       MAX(CASE WHEN rn = 2 THEN unit END),
       MAX(CASE WHEN rn = 2 THEN reset_at END),
       MAX(CASE WHEN rn = 2 THEN captured_at END)
  FROM recent
 WHERE rn <= 2
 GROUP BY provider, metric, account;

CREATE TRIGGER IF NOT EXISTS trg_quota_snapshots_current
AFTER INSERT ON quota_snapshots
BEGIN
  INSERT INTO quota_current (
    provider, metric, account, snapshot_id, value, limit_value, unit, reset_at, captured_at,
    previous_snapshot_id, previous_value, previous_unit, previous_reset_at, previous_captured_at
  )
  VALUES (
    NEW.provider, NEW.metric, NEW.account, NEW.id, NEW.value, NEW.limit_value, NEW.unit, NEW.reset_at, NEW.captured_at,
    NULL, NULL, NULL, NULL, NULL
  )
  ON CONFLICT (provider, metric, account) DO UPDATE SET
    previous_snapshot_id = quota_current.snapshot_id,
    previous_value = quota_current.value,
    previous_unit = quota_current.unit,
    previous_reset_at = quota_current.reset_at,
    previous_captured_at = quota_current.captured_at,
    snapshot_id = excluded.snapshot_id,
    value = excluded.value,
    limit_value = excluded.limit_value,
    unit = excluded.unit,
    reset_at = excluded.reset_at,
    captured_at = excluded.captured_at
  WHERE excluded.snapshot_id > quota_current.snapshot_id;
END;
