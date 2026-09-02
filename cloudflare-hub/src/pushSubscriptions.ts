import type { Context } from "hono";
import type { Env } from "./index";
import { readAlertConfig } from "./alerts";
import { sendTestPush } from "./push";

/** 推送订阅与告警设置的 HTTP handlers */

function bad(c: Context, msg: string): Response {
  return c.json({ error: "bad_request", detail: msg }, 400);
}

/** GET /push/vapid-public-key —— 前端订阅 web push 前取应用公钥 */
export async function vapidKey(c: Context<{ Bindings: Env }>): Promise<Response> {
  return c.json({ key: c.env.VAPID_PUBLIC_KEY ?? null });
}

/** POST /push/subscriptions —— body { platform, endpoint, keys?, environment? }
 *  web 的 endpoint 是 push endpoint URL，ios 的 endpoint 是 APNs device token。按 endpoint upsert。 */
export async function subscribe(c: Context<{ Bindings: Env }>): Promise<Response> {
  const body = (await c.req.json().catch(() => null)) as {
    platform?: unknown;
    endpoint?: unknown;
    keys?: { p256dh?: unknown; auth?: unknown };
    environment?: unknown;
  } | null;
  const platform = body?.platform;
  if (platform !== "web" && platform !== "ios") return bad(c, `bad platform: ${String(platform)}`);
  const endpoint = typeof body?.endpoint === "string" ? body.endpoint.trim() : "";
  if (!endpoint || endpoint.length > 4096) return bad(c, "endpoint required");

  let keysJson: string | null = null;
  let environment = "";
  if (platform === "web") {
    if (!/^https:\/\//.test(endpoint)) return bad(c, "web endpoint 必须是 https 地址");
    const { p256dh, auth } = body?.keys ?? {};
    if (typeof p256dh !== "string" || !p256dh || typeof auth !== "string" || !auth) {
      return bad(c, "web 订阅需要 keys.p256dh 与 keys.auth");
    }
    keysJson = JSON.stringify({ p256dh, auth });
  } else {
    if (!/^[a-f0-9]{64,256}$/i.test(endpoint)) return bad(c, "iOS endpoint 必须是 APNs device token");
    if (body?.environment === undefined) {
      // Backward compatibility for an older app that did not report its signing environment.
      environment = c.env.APNS_USE_SANDBOX === "1" ? "sandbox" : "production";
    } else if (body.environment === "sandbox" || body.environment === "production") {
      environment = body.environment;
    } else {
      return bad(c, "iOS environment 必须是 sandbox 或 production");
    }
  }

  await c.env.DB.prepare(
    `INSERT INTO push_subscriptions (platform, endpoint, keys_json, environment, active, last_error)
     VALUES (?,?,?,?,1,NULL)
     ON CONFLICT (endpoint) DO UPDATE SET
       platform = excluded.platform,
       keys_json = excluded.keys_json,
       environment = excluded.environment,
       active = 1,
       last_error = CASE
         WHEN push_subscriptions.platform = excluded.platform
          AND push_subscriptions.keys_json IS excluded.keys_json
          AND push_subscriptions.environment = excluded.environment
         THEN push_subscriptions.last_error
         ELSE NULL
       END,
       updated_at = datetime('now')`,
  )
    .bind(platform, endpoint, keysJson, environment)
    .run();
  return c.json({ ok: true, environment: environment || null });
}

/** DELETE /push/subscriptions —— body { endpoint }；不存在也返回 ok */
export async function unsubscribe(c: Context<{ Bindings: Env }>): Promise<Response> {
  const body = (await c.req.json().catch(() => null)) as { endpoint?: unknown } | null;
  const endpoint = typeof body?.endpoint === "string" ? body.endpoint.trim() : "";
  if (!endpoint) return bad(c, "endpoint required");
  await c.env.DB.batch([
    c.env.DB.prepare(
      `DELETE FROM push_deliveries
        WHERE subscription_id IN (SELECT id FROM push_subscriptions WHERE endpoint = ?)`,
    ).bind(endpoint),
    c.env.DB.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).bind(endpoint),
  ]);
  return c.json({ ok: true });
}

interface SubscriptionStatusRow {
  platform: string;
  environment: string;
  active: number;
  created_at: string;
  updated_at: string;
  last_success_at: string | null;
  last_error: string | null;
  delivery_status: string | null;
  delivery_attempts: number | null;
  delivery_last_attempt_at: string | null;
  delivery_sent_at: string | null;
  delivery_http_status: number | null;
  delivery_last_error: string | null;
}

/** POST /push/subscriptions/status —— body { endpoint }，避免 token/endpoint 出现在 URL 日志中。 */
export async function subscriptionStatus(c: Context<{ Bindings: Env }>): Promise<Response> {
  const body = (await c.req.json().catch(() => null)) as { endpoint?: unknown } | null;
  const endpoint = typeof body?.endpoint === "string" ? body.endpoint.trim() : "";
  if (!endpoint) return bad(c, "endpoint required");
  const row = await c.env.DB.prepare(
    `SELECT s.platform, s.environment, s.active, s.created_at, s.updated_at,
            s.last_success_at, s.last_error,
            d.status AS delivery_status, d.attempts AS delivery_attempts,
            d.last_attempt_at AS delivery_last_attempt_at, d.sent_at AS delivery_sent_at,
            d.http_status AS delivery_http_status, d.last_error AS delivery_last_error
       FROM push_subscriptions s
       LEFT JOIN push_deliveries d ON d.id = (
         SELECT id FROM push_deliveries WHERE subscription_id = s.id ORDER BY id DESC LIMIT 1
       )
      WHERE s.endpoint = ?`,
  )
    .bind(endpoint)
    .first<SubscriptionStatusRow>();
  if (!row) return c.json({ subscription: null });
  return c.json({
    subscription: {
      platform: row.platform,
      environment: row.platform === "ios" ? row.environment || null : null,
      active: Boolean(row.active),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastSuccessAt: row.last_success_at,
      lastError: row.last_error,
      latestDelivery: row.delivery_status
        ? {
            status: row.delivery_status,
            attempts: row.delivery_attempts ?? 0,
            lastAttemptAt: row.delivery_last_attempt_at,
            sentAt: row.delivery_sent_at,
            httpStatus: row.delivery_http_status,
            lastError: row.delivery_last_error,
          }
        : null,
    },
  });
}

/** POST /push/test —— 对已登记 endpoint 立即发送一条诊断通知。 */
export async function testPush(c: Context<{ Bindings: Env }>): Promise<Response> {
  const body = (await c.req.json().catch(() => null)) as { endpoint?: unknown } | null;
  const endpoint = typeof body?.endpoint === "string" ? body.endpoint.trim() : "";
  if (!endpoint) return bad(c, "endpoint required");
  const result = await sendTestPush(c.env, endpoint);
  if (!result) return c.json({ error: "not_found", detail: "订阅不存在，请重新开启通知" }, 404);
  return c.json({
    ok: result.ok,
    retryable: result.retryable,
    invalidSubscription: result.invalidSubscription,
    status: result.status,
    reason: result.reason,
    providerMessageId: result.providerMessageId,
  });
}

/** GET /alerts/settings */
export async function getAlertSettings(c: Context<{ Bindings: Env }>): Promise<Response> {
  return c.json(await readAlertConfig(c.env));
}

/** PUT /alerts/settings —— body { enabled?, lowThresholdPct?, resetSoonMinutes? }，只更新提交字段 */
export async function putAlertSettings(c: Context<{ Bindings: Env }>): Promise<Response> {
  const body = (await c.req.json().catch(() => null)) as {
    enabled?: unknown;
    lowThresholdPct?: unknown;
    resetSoonMinutes?: unknown;
  } | null;
  if (!body || typeof body !== "object") return bad(c, "invalid json body");

  const stmts: D1PreparedStatement[] = [];
  const upsert = (key: string, value: string) =>
    c.env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    ).bind(key, value);

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") return bad(c, "enabled 必须是布尔值");
    stmts.push(upsert("alert_enabled", body.enabled ? "1" : "0"));
  }
  if (body.lowThresholdPct !== undefined) {
    const n = Number(body.lowThresholdPct);
    if (!Number.isFinite(n) || n < 1 || n > 100) return bad(c, "lowThresholdPct 必须在 1-100 之间");
    stmts.push(upsert("alert_low_threshold_pct", String(n)));
  }
  if (body.resetSoonMinutes !== undefined) {
    const n = Number(body.resetSoonMinutes);
    if (!Number.isFinite(n) || n < 1 || n > 1440) return bad(c, "resetSoonMinutes 必须在 1-1440 之间");
    stmts.push(upsert("alert_reset_soon_minutes", String(n)));
  }
  if (stmts.length > 0) await c.env.DB.batch(stmts);

  return c.json(await readAlertConfig(c.env));
}
