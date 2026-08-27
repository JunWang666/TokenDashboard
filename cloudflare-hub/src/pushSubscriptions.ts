import type { Context } from "hono";
import type { Env } from "./index";
import { readAlertConfig } from "./alerts";

/** 推送订阅与告警设置的 HTTP handlers */

function bad(c: Context, msg: string): Response {
  return c.json({ error: "bad_request", detail: msg }, 400);
}

/** GET /push/vapid-public-key —— 前端订阅 web push 前取应用公钥 */
export async function vapidKey(c: Context<{ Bindings: Env }>): Promise<Response> {
  return c.json({ key: c.env.VAPID_PUBLIC_KEY ?? null });
}

/** POST /push/subscriptions —— body { platform: "web"|"ios", endpoint, keys?: {p256dh, auth} }
 *  web 的 endpoint 是 push endpoint URL，ios 的 endpoint 是 APNs device token。按 endpoint upsert。 */
export async function subscribe(c: Context<{ Bindings: Env }>): Promise<Response> {
  const body = (await c.req.json().catch(() => null)) as {
    platform?: unknown;
    endpoint?: unknown;
    keys?: { p256dh?: unknown; auth?: unknown };
  } | null;
  const platform = body?.platform;
  if (platform !== "web" && platform !== "ios") return bad(c, `bad platform: ${String(platform)}`);
  const endpoint = typeof body?.endpoint === "string" ? body.endpoint.trim() : "";
  if (!endpoint || endpoint.length > 4096) return bad(c, "endpoint required");

  let keysJson: string | null = null;
  if (platform === "web") {
    if (!/^https:\/\//.test(endpoint)) return bad(c, "web endpoint 必须是 https 地址");
    const { p256dh, auth } = body?.keys ?? {};
    if (typeof p256dh !== "string" || !p256dh || typeof auth !== "string" || !auth) {
      return bad(c, "web 订阅需要 keys.p256dh 与 keys.auth");
    }
    keysJson = JSON.stringify({ p256dh, auth });
  }

  await c.env.DB.prepare(
    `INSERT INTO push_subscriptions (platform, endpoint, keys_json)
     VALUES (?,?,?)
     ON CONFLICT (endpoint) DO UPDATE SET
       platform = excluded.platform,
       keys_json = excluded.keys_json,
       updated_at = datetime('now')`,
  )
    .bind(platform, endpoint, keysJson)
    .run();
  return c.json({ ok: true });
}

/** DELETE /push/subscriptions —— body { endpoint }；不存在也返回 ok */
export async function unsubscribe(c: Context<{ Bindings: Env }>): Promise<Response> {
  const body = (await c.req.json().catch(() => null)) as { endpoint?: unknown } | null;
  const endpoint = typeof body?.endpoint === "string" ? body.endpoint.trim() : "";
  if (!endpoint) return bad(c, "endpoint required");
  await c.env.DB.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).bind(endpoint).run();
  return c.json({ ok: true });
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
