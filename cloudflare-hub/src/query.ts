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

/** GET /quota/current —— 每个 (provider, metric) 最新快照 */
export async function quotaCurrent(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;
  const { results } = await env.DB.prepare(
    `SELECT q.* FROM quota_snapshots q
     INNER JOIN (
       SELECT provider, metric, MAX(id) AS id FROM quota_snapshots GROUP BY provider, metric
     ) m ON q.id = m.id
     ORDER BY q.provider, q.metric`,
  ).all<Record<string, unknown>>();
  return c.json({
    rows: results.map((r) => ({
      provider: r.provider,
      metric: r.metric,
      value: Number(r.value),
      limit_value: r.limit_value == null ? null : Number(r.limit_value),
      unit: r.unit ?? null,
      reset_at: r.reset_at ?? null,
      captured_at: r.captured_at,
    })),
  });
}

/** GET /quota/history?provider=&metric=&from=&to= */
export async function quotaHistory(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;
  const provider = c.req.query("provider");
  const metric = c.req.query("metric");
  const { from, to } = range(c);

  let sql = `SELECT provider, metric, value, limit_value, unit, reset_at, captured_at
             FROM quota_snapshots WHERE 1=1`;
  const args: (string | number)[] = [];
  if (provider) {
    sql += " AND provider = ?";
    args.push(provider);
  }
  if (metric) {
    sql += " AND metric = ?";
    args.push(metric);
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

  const { results } = await env.DB.prepare(sql).bind(...args).all<Record<string, unknown>>();
  return c.json({ rows: results });
}

/** GET /devices */
export async function devices(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;
  const { results } = await env.DB.prepare(
    `SELECT device_id, name, last_seen_at FROM devices ORDER BY last_seen_at DESC`,
  ).all<Record<string, unknown>>();
  return c.json({ rows: results });
}
