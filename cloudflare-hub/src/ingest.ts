import type { Context } from "hono";
import type { Env } from "./index";

const PROVIDERS = ["claude", "openai", "copilot", "glm", "deepseek", "cursor", "codex", "kimi", "minimax", "zai", "anyrouter", "gemini", "opencode"] as const;
export const PROVIDER_SET: ReadonlySet<string> = new Set(PROVIDERS);

export const MAX_BATCH = 1000;

const HOUR_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/;

function bad(c: Context, msg: string): Response {
  return c.json({ error: "bad_request", detail: msg }, 400);
}

export async function postUsage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return bad(c, "invalid json body");
  const deviceId = (body as { device_id?: unknown }).device_id;
  if (typeof deviceId !== "string" || !deviceId.trim()) return bad(c, "device_id required");
  const rows = (body as { rows?: unknown }).rows;
  if (!Array.isArray(rows) || rows.length === 0) return bad(c, "rows required");
  if (rows.length > MAX_BATCH) return bad(c, `rows exceeds max batch ${MAX_BATCH}`);

  const stmts: D1PreparedStatement[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    if (typeof r.provider !== "string" || !PROVIDER_SET.has(r.provider)) return bad(c, `bad provider: ${r.provider}`);
    if (typeof r.source !== "string" || !r.source.trim()) return bad(c, "source required");
    const model = r.model == null ? null : String(r.model);
    if (typeof r.bucket_hour !== "string" || !HOUR_RE.test(r.bucket_hour)) {
      return bad(c, `bad bucket_hour: ${r.bucket_hour}`);
    }
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
    stmts.push(
      env.DB.prepare(
        `INSERT INTO usage_hourly
           (device_id, provider, source, model, bucket_hour,
            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, requests)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (device_id, provider, source, model, bucket_hour)
         DO UPDATE SET
           input_tokens = excluded.input_tokens,
           output_tokens = excluded.output_tokens,
           cache_read_tokens = excluded.cache_read_tokens,
           cache_write_tokens = excluded.cache_write_tokens,
           cost_usd = excluded.cost_usd,
           requests = excluded.requests`,
      )
        .bind(
          deviceId.trim(),
          r.provider,
          r.source,
          model,
          r.bucket_hour,
          num(r.input_tokens),
          num(r.output_tokens),
          num(r.cache_read_tokens),
          num(r.cache_write_tokens),
          num(r.cost_usd),
          num(r.requests),
        )
        ,
    );
  }

  const heartbeat = env.DB.prepare(
    `INSERT INTO devices (device_id, name, last_seen_at)
     VALUES (?,?, datetime('now'))
     ON CONFLICT (device_id) DO UPDATE SET name = excluded.name, last_seen_at = datetime('now')`,
  ).bind(deviceId.trim(), null);

  await env.DB.batch([heartbeat, ...stmts]);
  return c.json({ ok: true, device_id: deviceId.trim(), rows: rows.length });
}

export async function postQuota(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return bad(c, "invalid json body");
  const rows = (body as { rows?: unknown }).rows;
  if (!Array.isArray(rows) || rows.length === 0) return bad(c, "rows required");
  if (rows.length > MAX_BATCH) return bad(c, `rows exceeds max batch ${MAX_BATCH}`);

  const stmts: D1PreparedStatement[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    if (typeof r.provider !== "string" || !PROVIDER_SET.has(r.provider)) return bad(c, `bad provider: ${r.provider}`);
    if (typeof r.metric !== "string" || !r.metric.trim()) return bad(c, "metric required");
    const value = r.value;
    if (typeof value !== "number" || !Number.isFinite(value)) return bad(c, `bad value: ${value}`);
    const account = typeof r.account === "string" && r.account.trim() ? r.account.trim().slice(0, 50) : "";
    stmts.push(
      env.DB.prepare(
        `INSERT INTO quota_snapshots (provider, metric, account, value, limit_value, unit, reset_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
        .bind(
          r.provider,
          r.metric.trim(),
          account,
          value,
          r.limit_value == null ? null : Number(r.limit_value),
          r.unit == null ? null : String(r.unit),
          r.reset_at == null ? null : String(r.reset_at),
        )
        ,
    );
  }
  await env.DB.batch(stmts);
  return c.json({ ok: true, rows: rows.length });
}
