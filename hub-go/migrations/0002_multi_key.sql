-- 0002: 多 key 支持
-- credentials 主键 (provider) → (provider, name)，每个服务商可存多把 key
CREATE TABLE IF NOT EXISTS credentials_new (
  provider    TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT '默认',
  payload_enc TEXT NOT NULL,
  hint        TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by  TEXT,
  PRIMARY KEY (provider, name)
);
INSERT INTO credentials_new (provider, name, payload_enc, hint, updated_at, updated_by)
  SELECT provider, '默认', payload_enc, hint, updated_at, updated_by FROM credentials;
DROP TABLE credentials;
ALTER TABLE credentials_new RENAME TO credentials;

-- quota_snapshots 加 account 维度（= credentials.name），每把 key 独立统计
ALTER TABLE quota_snapshots ADD COLUMN account TEXT NOT NULL DEFAULT '';
UPDATE quota_snapshots SET account = '默认' WHERE account = '';
DROP INDEX IF EXISTS idx_quota_latest;
CREATE INDEX IF NOT EXISTS idx_quota_latest ON quota_snapshots (provider, metric, account, captured_at DESC);
