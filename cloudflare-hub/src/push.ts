import type { Env } from "./index";
import type { AlertEvent } from "./alerts";
import { base64UrlEncode, buildWebPushRequest } from "./webPush";

/** Persisted alert: delivery rows reference this id, so a failed send can be retried. */
export interface PersistedAlertEvent extends AlertEvent {
  id: number;
}

interface Subscription {
  id: number;
  platform: "web" | "ios";
  endpoint: string;
  keys_json: string | null;
  environment: string;
  active: number;
}

interface DeliveryRow extends Subscription {
  delivery_id: number;
  event_id: number;
  attempts: number;
  title: string;
  body: string;
}

export interface PushSendResult {
  ok: boolean;
  retryable: boolean;
  invalidSubscription: boolean;
  status: number | null;
  reason: string;
  providerMessageId: string | null;
}

export interface PushDispatchSummary {
  processed: number;
  sent: number;
  retrying: number;
  failed: number;
}

const APNS_TOPIC = "com.gouzuang.TokenDashboard";
const MAX_ATTEMPTS = 8;
const RETRY_DELAYS_SECONDS = [60, 5 * 60, 15 * 60, 60 * 60, 3 * 60 * 60, 6 * 60 * 60, 12 * 60 * 60];

function bounded(value: string, max = 1000): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function safeError(error: unknown, redactions: string[] = []): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const value of redactions) {
    if (value) message = message.split(value).join("[redacted]");
  }
  return bounded(message);
}

function failedResult(reason: string, options: Partial<PushSendResult> = {}): PushSendResult {
  return {
    ok: false,
    retryable: false,
    invalidSubscription: false,
    status: null,
    reason: bounded(reason),
    providerMessageId: null,
    ...options,
  };
}

function configuredForWeb(env: Env): boolean {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);
}

function configuredForApns(env: Env): boolean {
  return Boolean(env.APNS_KEY_P8 && env.APNS_KEY_ID && env.APNS_TEAM_ID);
}

async function responseDetail(response: Response): Promise<string> {
  return bounded(await response.text().catch(() => ""));
}

async function sendWeb(
  env: Env,
  subscription: Subscription,
  payload: { title: string; body: string },
  fetchImpl: typeof fetch = fetch,
): Promise<PushSendResult> {
  if (!configuredForWeb(env)) {
    return failedResult("VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY/VAPID_SUBJECT 未配置", { retryable: true });
  }

  let keys: { p256dh?: string; auth?: string };
  try {
    keys = JSON.parse(subscription.keys_json ?? "{}") as { p256dh?: string; auth?: string };
  } catch {
    return failedResult("Web Push 订阅密钥不是有效 JSON", { invalidSubscription: true });
  }
  if (!keys.p256dh || !keys.auth) {
    return failedResult("Web Push 订阅缺少 p256dh/auth", { invalidSubscription: true });
  }

  let request;
  try {
    request = await buildWebPushRequest(
      { endpoint: subscription.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } },
      JSON.stringify(payload),
      {
        publicKey: env.VAPID_PUBLIC_KEY!,
        privateKey: env.VAPID_PRIVATE_KEY!,
        subject: env.VAPID_SUBJECT!,
      },
      { ttl: 3600 },
    );
  } catch (error) {
    const reason = safeError(error, [subscription.endpoint]);
    const invalidSubscription = /p256dh|auth secret|订阅/.test(reason);
    return failedResult(`Web Push 请求构造失败：${reason}`, {
      invalidSubscription,
      retryable: !invalidSubscription,
    });
  }

  try {
    const response = await fetchImpl(request.endpoint, {
      method: "POST",
      headers: request.headers,
      body: request.body,
    });
    if (response.ok) {
      return {
        ok: true,
        retryable: false,
        invalidSubscription: false,
        status: response.status,
        reason: "sent",
        providerMessageId: response.headers.get("location"),
      };
    }
    const detail = await responseDetail(response);
    const invalidSubscription = response.status === 404 || response.status === 410;
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    return failedResult(`Web Push HTTP ${response.status}${detail ? `: ${detail}` : ""}`, {
      status: response.status,
      invalidSubscription,
      retryable,
    });
  } catch (error) {
    return failedResult(`Web Push 网络错误：${safeError(error, [subscription.endpoint])}`, {
      retryable: true,
    });
  }
}

/** .p8 PEM 全文 → PKCS8 DER */
function pemToDer(pem: string): ArrayBuffer {
  const base64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** APNs provider token. A token is reused only inside one dispatch invocation. */
async function createApnsJwt(env: Env): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(env.APNS_KEY_P8!),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const encoder = new TextEncoder();
  const header = base64UrlEncode(encoder.encode(JSON.stringify({ alg: "ES256", kid: env.APNS_KEY_ID })));
  const claims = base64UrlEncode(
    encoder.encode(JSON.stringify({ iss: env.APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) })),
  );
  const unsigned = `${header}.${claims}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    encoder.encode(unsigned),
  );
  return `${unsigned}.${base64UrlEncode(new Uint8Array(signature))}`;
}

const INVALID_APNS_TOKEN_REASONS = new Set(["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"]);
const RETRYABLE_APNS_REASONS = new Set([
  "ExpiredProviderToken",
  "IdleTimeout",
  "InvalidProviderToken",
  "MissingProviderToken",
  "Shutdown",
  "TooManyProviderTokenUpdates",
  "TooManyRequests",
]);

export function apnsHostForEnvironment(environment: string, legacySandboxDefault: boolean): string {
  const sandbox = environment === "sandbox" || (environment !== "production" && legacySandboxDefault);
  return sandbox ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
}

function apnsHost(env: Env, subscription: Subscription): string {
  return apnsHostForEnvironment(subscription.environment, env.APNS_USE_SANDBOX === "1");
}

async function sendApns(
  env: Env,
  subscription: Subscription,
  payload: { title: string; body: string },
  jwt: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<PushSendResult> {
  if (!configuredForApns(env)) {
    return failedResult("APNS_KEY_P8/APNS_KEY_ID/APNS_TEAM_ID 未配置", { retryable: true });
  }
  if (!jwt) return failedResult("APNs provider token 生成失败", { retryable: true });

  try {
    const response = await fetchImpl(`${apnsHost(env, subscription)}/3/device/${subscription.endpoint}`, {
      method: "POST",
      headers: {
        authorization: `bearer ${jwt}`,
        "content-type": "application/json",
        "apns-topic": APNS_TOPIC,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-expiration": "0",
      },
      body: JSON.stringify({ aps: { alert: payload, sound: "default" } }),
    });
    const providerMessageId = response.headers.get("apns-id");
    if (response.ok) {
      return {
        ok: true,
        retryable: false,
        invalidSubscription: false,
        status: response.status,
        reason: "sent",
        providerMessageId,
      };
    }

    const detail = await responseDetail(response);
    let reason = "";
    try {
      const parsed = JSON.parse(detail) as { reason?: unknown };
      if (typeof parsed.reason === "string") reason = parsed.reason;
    } catch {
      // Keep the raw response below when APNs did not return JSON.
    }
    const invalidSubscription = response.status === 410 || INVALID_APNS_TOKEN_REASONS.has(reason);
    const retryable =
      RETRYABLE_APNS_REASONS.has(reason) ||
      response.status === 408 ||
      response.status === 429 ||
      response.status >= 500;
    return failedResult(`APNs HTTP ${response.status}${reason ? `: ${reason}` : detail ? `: ${detail}` : ""}`, {
      status: response.status,
      invalidSubscription,
      retryable,
      providerMessageId,
    });
  } catch (error) {
    return failedResult(`APNs 网络错误：${safeError(error, [subscription.endpoint])}`, {
      retryable: true,
    });
  }
}

async function recordSubscriptionResult(env: Env, subscription: Subscription, result: PushSendResult): Promise<void> {
  if (result.ok) {
    await env.DB.prepare(
      `UPDATE push_subscriptions
          SET active = 1, last_success_at = datetime('now'), last_error = NULL, updated_at = datetime('now')
        WHERE id = ?`,
    )
      .bind(subscription.id)
      .run();
    return;
  }
  await env.DB.prepare(
    `UPDATE push_subscriptions
        SET active = CASE WHEN ? THEN 0 ELSE active END,
            last_error = ?, updated_at = datetime('now')
      WHERE id = ?`,
  )
    .bind(result.invalidSubscription ? 1 : 0, bounded(result.reason), subscription.id)
    .run();
}

async function sendToSubscription(
  env: Env,
  subscription: Subscription,
  payload: { title: string; body: string },
  apnsJwt: Promise<string | null> | null,
): Promise<PushSendResult> {
  if (subscription.platform === "web") return sendWeb(env, subscription, payload);
  const jwt = apnsJwt ? await apnsJwt : null;
  return sendApns(env, subscription, payload, jwt);
}

/** Add one durable delivery row per active subscription and fresh alert. */
export async function enqueuePushDeliveries(env: Env, events: PersistedAlertEvent[]): Promise<void> {
  if (events.length === 0) return;
  await env.DB.batch(
    events.map((event) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO push_deliveries (event_id, subscription_id)
         SELECT ?, id FROM push_subscriptions WHERE active = 1`,
      ).bind(event.id),
    ),
  );
}

function logDelivery(delivery: DeliveryRow, result: PushSendResult, finalStatus: string): void {
  const entry = JSON.stringify({
    event: "push_delivery",
    deliveryId: delivery.delivery_id,
    eventId: delivery.event_id,
    subscriptionId: delivery.id,
    platform: delivery.platform,
    environment: delivery.platform === "ios" ? delivery.environment || "legacy-default" : undefined,
    attempt: delivery.attempts + 1,
    status: finalStatus,
    httpStatus: result.status,
    reason: result.reason,
    providerMessageId: result.providerMessageId,
  });
  if (result.ok) console.log(entry);
  else console.error(entry);
}

async function completeDelivery(
  env: Env,
  delivery: DeliveryRow,
  result: PushSendResult,
): Promise<"sent" | "retry" | "failed"> {
  const attempt = delivery.attempts + 1;
  if (result.ok) {
    await env.DB.prepare(
      `UPDATE push_deliveries
          SET status = 'sent', sent_at = datetime('now'), http_status = ?,
              provider_message_id = ?, last_error = NULL, updated_at = datetime('now')
        WHERE id = ?`,
    )
      .bind(result.status, result.providerMessageId, delivery.delivery_id)
      .run();
    return "sent";
  }

  if (result.retryable && !result.invalidSubscription && attempt < MAX_ATTEMPTS) {
    const delay = RETRY_DELAYS_SECONDS[Math.min(attempt - 1, RETRY_DELAYS_SECONDS.length - 1)];
    await env.DB.prepare(
      `UPDATE push_deliveries
          SET status = 'retry', next_attempt_at = datetime('now', ?), http_status = ?,
              provider_message_id = ?, last_error = ?, updated_at = datetime('now')
        WHERE id = ?`,
    )
      .bind(`+${delay} seconds`, result.status, result.providerMessageId, bounded(result.reason), delivery.delivery_id)
      .run();
    return "retry";
  }

  await env.DB.prepare(
    `UPDATE push_deliveries
        SET status = 'failed', http_status = ?, provider_message_id = ?, last_error = ?, updated_at = datetime('now')
      WHERE id = ?`,
  )
    .bind(result.status, result.providerMessageId, bounded(result.reason), delivery.delivery_id)
    .run();
  return "failed";
}

async function processDelivery(
  env: Env,
  delivery: DeliveryRow,
  apnsJwt: Promise<string | null> | null,
): Promise<"skipped" | "sent" | "retry" | "failed"> {
  // Claim before sending. A second overlapping cron sees zero changes and cannot double-send.
  const claim = await env.DB.prepare(
    `UPDATE push_deliveries
        SET status = 'sending', attempts = attempts + 1,
            last_attempt_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND (
        (status IN ('pending', 'retry') AND next_attempt_at <= datetime('now')) OR
        (status = 'sending' AND last_attempt_at <= datetime('now', '-10 minutes'))
      )`,
  )
    .bind(delivery.delivery_id)
    .run();
  if (claim.meta.changes === 0) return "skipped";

  let result: PushSendResult;
  try {
    result = await sendToSubscription(
      env,
      delivery,
      { title: delivery.title, body: delivery.body },
      apnsJwt,
    );
  } catch (error) {
    result = failedResult(safeError(error, [delivery.endpoint]), { retryable: true });
  }
  await recordSubscriptionResult(env, delivery, result);
  const status = await completeDelivery(env, delivery, result);
  logDelivery(delivery, result, status);
  return status;
}

/** Send all due delivery rows, including retries left behind by an earlier sweep. */
export async function dispatchPendingPushes(env: Env): Promise<PushDispatchSummary> {
  const { results } = await env.DB.prepare(
    `SELECT d.id AS delivery_id, d.event_id, d.attempts,
            s.id, s.platform, s.endpoint, s.keys_json, s.environment, s.active,
            e.title, e.body
       FROM push_deliveries d
       JOIN push_subscriptions s ON s.id = d.subscription_id
       JOIN alert_events e ON e.id = d.event_id
      WHERE s.active = 1 AND (
        (d.status IN ('pending', 'retry') AND d.next_attempt_at <= datetime('now')) OR
        (d.status = 'sending' AND d.last_attempt_at <= datetime('now', '-10 minutes'))
      )
      ORDER BY d.next_attempt_at, d.id
      LIMIT 100`,
  ).all<DeliveryRow>();

  const needsApns = results.some((row) => row.platform === "ios");
  const apnsJwt = needsApns
    ? configuredForApns(env)
      ? createApnsJwt(env).catch((error) => {
          console.error(
            JSON.stringify({
              event: "apns_provider_token_error",
              reason: bounded(error instanceof Error ? error.message : String(error)),
            }),
          );
          return null;
        })
      : Promise.resolve(null)
    : null;

  const settled = await Promise.allSettled(results.map((row) => processDelivery(env, row, apnsJwt)));
  const statuses = settled.map((result, index) => {
    if (result.status === "fulfilled") return result.value;
    console.error(
      JSON.stringify({
        event: "push_delivery_internal_error",
        deliveryId: results[index].delivery_id,
        subscriptionId: results[index].id,
        platform: results[index].platform,
        reason: bounded(result.reason instanceof Error ? result.reason.message : String(result.reason)),
      }),
    );
    return "failed" as const;
  });
  return {
    processed: statuses.filter((status) => status !== "skipped").length,
    sent: statuses.filter((status) => status === "sent").length,
    retrying: statuses.filter((status) => status === "retry").length,
    failed: statuses.filter((status) => status === "failed").length,
  };
}

/** Enqueue fresh alerts, then drain both fresh and previously failed/retryable sends. */
export async function dispatchPush(env: Env, events: PersistedAlertEvent[]): Promise<PushDispatchSummary> {
  await enqueuePushDeliveries(env, events);
  return dispatchPendingPushes(env);
}

/** Direct diagnostic send used by POST /push/test. It also updates subscription health. */
export async function sendTestPush(env: Env, endpoint: string): Promise<PushSendResult | null> {
  const subscription = await env.DB.prepare(
    `SELECT id, platform, endpoint, keys_json, environment, active
       FROM push_subscriptions WHERE endpoint = ?`,
  )
    .bind(endpoint)
    .first<Subscription>();
  if (!subscription) return null;

  const apnsJwt =
    subscription.platform === "ios" && configuredForApns(env)
      ? createApnsJwt(env).catch(() => null)
      : null;
  const result = await sendToSubscription(
    env,
    subscription,
    { title: "TokenDashboard 测试通知", body: "推送链路已连通" },
    apnsJwt ? Promise.resolve(apnsJwt) : null,
  );
  await recordSubscriptionResult(env, subscription, result);
  const entry = JSON.stringify({
    event: "push_test",
    subscriptionId: subscription.id,
    platform: subscription.platform,
    environment: subscription.platform === "ios" ? subscription.environment || "legacy-default" : undefined,
    ok: result.ok,
    httpStatus: result.status,
    reason: result.reason,
    providerMessageId: result.providerMessageId,
  });
  if (result.ok) console.log(entry);
  else console.error(entry);
  return result;
}
