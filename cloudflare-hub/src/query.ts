import type { Context } from "hono";
import type { Env } from "./index";

const GROUP_BY = new Set(["provider", "model", "day"]);
const INTERVALS = new Set(["hour", "day"]);

const TOKEN_COLS = `
  SUM(input_tokens)       AS input_tokens,
  SUM(output_tokens)      AS output_tokens,
  SUM(cache_read_tokens)  AS cache_read_tokens,
  SUM(cache_write_tokens) AS cache_write_tokens,
  SUM(cost_usd)           AS cost_usd,
  SUM(requests)           AS requests`;

const CURRENT_QUOTA_SQL = `SELECT q.* FROM quota_current q
  WHERE EXISTS (
    SELECT 1 FROM credentials c WHERE c.provider = q.provider AND c.name = q.account
  )
  ORDER BY q.provider, q.account, q.metric`;

interface QuotaGroup {
  provider: string;
  metric: string;
  account: string;
}

function bad(c: Context, msg: string): Response {
  return c.json({ error: "bad_request", detail: msg }, 400);
}

function range(c: Context): { from: string | null; to: string | null } {
  const from = c.req.query("from") ?? null;
  const to = c.req.query("to") ?? null;
  return { from, to };
}

/** GET /summary?from=&to=&group_by=provider|model|day */
export async function summary(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;
  const groupBy = c.req.query("group_by") ?? "provider";
  if (!GROUP_BY.has(groupBy)) return bad(c, `group_by must be one of: ${[...GROUP_BY]}`);
  const { from, to } = range(c);

  let groupExpr: string;
  let keyName: string;
  if (groupBy === "day") {
    groupExpr = "substr(bucket_hour,1,10)";
    keyName = "day";
  } else {
    groupExpr = groupBy;
    keyName = groupBy;
  }

  let sql = `SELECT ${groupExpr} AS key, ${TOKEN_COLS}
             FROM usage_hourly WHERE 1=1`;
  const args: (string | number)[] = [];
  if (from) {
    sql += " AND bucket_hour >= ?";
    args.push(from);
  }
  if (to) {
    sql += " AND bucket_hour < ?";
    args.push(to);
  }
  sql += ` GROUP BY ${groupExpr} ORDER BY key`;

  const { results } = await env.DB.prepare(sql).bind(...args).all<Record<string, unknown>>();
  const out = results.map((r) => ({
    key: r.key as string,
    input_tokens: Number(r.input_tokens ?? 0),
    output_tokens: Number(r.output_tokens ?? 0),
    cache_read_tokens: Number(r.cache_read_tokens ?? 0),
    cache_write_tokens: Number(r.cache_write_tokens ?? 0),
    cost_usd: Number(r.cost_usd ?? 0),
    requests: Number(r.requests ?? 0),
  }));
  return c.json({ group_by: groupBy, from, to, rows: out });
}

/** GET /usage/timeseries?from=&to=&interval=hour|day&group_by=provider|model */
export async function timeseries(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;
  const interval = c.req.query("interval") ?? "hour";
  const groupBy = c.req.query("group_by") ?? "provider";
  if (!INTERVALS.has(interval)) return bad(c, `interval must be one of: ${[...INTERVALS]}`);
  if (!GROUP_BY.has(groupBy)) return bad(c, `group_by must be one of: ${[...GROUP_BY]}`);
  const { from, to } = range(c);

  const timeExpr = interval === "day" ? "substr(bucket_hour,1,10)" : "bucket_hour";

  let sql = `SELECT ${timeExpr} AS time, ${groupBy} AS series, ${TOKEN_COLS}
             FROM usage_hourly WHERE 1=1`;
  const args: (string | number)[] = [];
  if (from) {
    sql += " AND bucket_hour >= ?";
    args.push(from);
  }
  if (to) {
    sql += " AND bucket_hour < ?";
    args.push(to);
  }
  sql += ` GROUP BY ${timeExpr}, ${groupBy} ORDER BY time`;

  const { results } = await env.DB.prepare(sql).bind(...args).all<Record<string, unknown>>();
  const rows = results.map((r) => ({
    time: r.time as string,
    series: r.series as string,
    input_tokens: Number(r.input_tokens ?? 0),
    output_tokens: Number(r.output_tokens ?? 0),
    cache_read_tokens: Number(r.cache_read_tokens ?? 0),
    cache_write_tokens: Number(r.cache_write_tokens ?? 0),
    cost_usd: Number(r.cost_usd ?? 0),
    requests: Number(r.requests ?? 0),
  }));
  return c.json({ interval, group_by: groupBy, from, to, rows });
}

/** GET /quota/current —— 每个 (provider, metric, account) 最新快照；只返回仍有凭证的 key */
export async function quotaCurrent(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;
  const { results } = await env.DB.prepare(CURRENT_QUOTA_SQL).all<Record<string, unknown>>();
  return c.json({
    rows: results.map((r) => ({
      provider: r.provider,
      metric: r.metric,
      account: r.account ?? "",
      value: Number(r.value),
      limit_value: r.limit_value == null ? null : Number(r.limit_value),
      unit: r.unit ?? null,
      reset_at: r.reset_at ?? null,
      captured_at: r.captured_at,
    })),
  });
}

/** GET /quota/history?provider=&metric=&account=&from=&to= */
export async function quotaHistory(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;
  const provider = c.req.query("provider");
  const metric = c.req.query("metric");
  const account = c.req.query("account");
  const { from, to } = range(c);

  // provider + metric 命中 idx_quota_latest 的前导列，可以直接安全查询。
  if (provider && metric) {
    const statement = quotaHistoryStatement(env.DB, { provider, metric, account }, from, to);
    const { results } = await statement.all<Record<string, unknown>>();
    return c.json({ rows: results.map(historyRow) });
  }

  // 宽查询必须带时间范围。先从很小的 quota_current 枚举分组，再对每组做精确索引查询；
  // 不能只写 WHERE captured_at >= ?，因为历史索引的前导列不是 captured_at。
  if (!from && !to) return bad(c, "from or to is required unless provider and metric are both specified");

  let groupSql = `SELECT q.provider, q.metric, q.account
                    FROM quota_current q
                   WHERE EXISTS (
                     SELECT 1 FROM credentials c WHERE c.provider = q.provider AND c.name = q.account
                   )`;
  const args: (string | number)[] = [];
  if (provider) {
    groupSql += " AND q.provider = ?";
    args.push(provider);
  }
  if (metric) {
    groupSql += " AND q.metric = ?";
    args.push(metric);
  }
  if (account !== undefined) {
    groupSql += " AND q.account = ?";
    args.push(account);
  }

  const { results: groups } = await env.DB.prepare(groupSql).bind(...args).all<QuotaGroup>();
  const rows: Record<string, unknown>[] = [];
  // 给 batch 留出余量；额度指标分组通常只有几十个，但不能让配置规模突破平台上限。
  for (let offset = 0; offset < groups.length; offset += 100) {
    const statements = groups
      .slice(offset, offset + 100)
      .map((group) => quotaHistoryStatement(env.DB, group, from, to));
    const results = await env.DB.batch<Record<string, unknown>>(statements);
    for (const result of results) rows.push(...result.results);
  }

  rows.sort((a, b) => {
    const byTime = String(a.captured_at).localeCompare(String(b.captured_at));
    return byTime || Number(a.snapshot_id) - Number(b.snapshot_id);
  });
  return c.json({ rows: rows.map(historyRow) });
}

function quotaHistoryStatement(
  db: D1Database,
  group: { provider: string; metric: string; account?: string },
  from: string | null,
  to: string | null,
): D1PreparedStatement {
  let sql = `SELECT id AS snapshot_id, provider, metric, account, value, limit_value, unit, reset_at, captured_at
               FROM quota_snapshots INDEXED BY idx_quota_latest
              WHERE provider = ? AND metric = ?`;
  const args: (string | number)[] = [group.provider, group.metric];
  if (group.account !== undefined) {
    sql += " AND account = ?";
    args.push(group.account);
  }
  if (from) {
    sql += " AND captured_at >= ?";
    args.push(from);
  }
  if (to) {
    sql += " AND captured_at < ?";
    args.push(to);
  }
  sql += " ORDER BY captured_at ASC, id ASC";
  return db.prepare(sql).bind(...args);
}

function historyRow(r: Record<string, unknown>): Record<string, unknown> {
  return {
    provider: r.provider,
    metric: r.metric,
    account: r.account,
    value: r.value,
    limit_value: r.limit_value,
    unit: r.unit,
    reset_at: r.reset_at,
    captured_at: r.captured_at,
  };
}

/** GET /bootstrap —— Overview 首屏聚合：今日逐小时用量 + 最新额度，一次请求 */
export async function bootstrap(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;
  const today = new Date().toISOString().slice(0, 10);
  const from = c.req.query("from") ?? `${today}T00`;
  const to = c.req.query("to") ?? null;
  const usageRange = to ? "WHERE bucket_hour >= ? AND bucket_hour < ?" : "WHERE bucket_hour >= ?";
  const usageArgs = to ? [from, to] : [from];

  const [tsRes, quotaRes] = await env.DB.batch([
    env.DB.prepare(
      `SELECT bucket_hour AS time, provider AS series, ${TOKEN_COLS}
       FROM usage_hourly ${usageRange}
       GROUP BY bucket_hour, provider ORDER BY time`,
    ).bind(...usageArgs),
    env.DB.prepare(CURRENT_QUOTA_SQL),
  ]);

  return c.json({
    ts: {
      interval: "hour",
      group_by: "provider",
      from,
      to,
      rows: ((tsRes.results ?? []) as Record<string, unknown>[]).map((r) => ({
        time: r.time as string,
        series: r.series as string,
        input_tokens: Number(r.input_tokens ?? 0),
        output_tokens: Number(r.output_tokens ?? 0),
        cache_read_tokens: Number(r.cache_read_tokens ?? 0),
        cache_write_tokens: Number(r.cache_write_tokens ?? 0),
        cost_usd: Number(r.cost_usd ?? 0),
        requests: Number(r.requests ?? 0),
      })),
    },
    quota: {
      rows: ((quotaRes.results ?? []) as Record<string, unknown>[]).map((r) => ({
        provider: r.provider,
        metric: r.metric,
        account: r.account ?? "",
        value: Number(r.value),
        limit_value: r.limit_value == null ? null : Number(r.limit_value),
        unit: r.unit ?? null,
        reset_at: r.reset_at ?? null,
        captured_at: r.captured_at,
      })),
    },
  });
}

/** GET /devices */
export async function devices(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;
  const { results } = await env.DB.prepare(
    `SELECT device_id, name, last_seen_at FROM devices ORDER BY last_seen_at DESC`,
  ).all<Record<string, unknown>>();
  return c.json({ rows: results });
}
