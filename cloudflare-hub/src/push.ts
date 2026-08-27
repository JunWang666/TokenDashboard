import { buildPushHTTPRequest } from "@pushforge/builder";
import type { Env } from "./index";
import type { AlertEvent } from "./alerts";

/** 推送下发：web 走 VAPID/web-push（@pushforge/builder），iOS 走 APNs（手写 ES256 JWT，无依赖） */

interface Subscription {
  id: number;
  platform: string;
  endpoint: string; // web: push endpoint；ios: device token
  keys_json: string | null;
}

const APNS_TOPIC = "com.gouzuang.TokenDashboard";

function b64urlEncode(buf: Uint8Array): string {
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function removeSubscription(env: Env, id: number): Promise<void> {
  await env.DB.prepare(`DELETE FROM push_subscriptions WHERE id = ?`).bind(id).run();
}

/** VAPID 私钥仅存 d（base64url），从公钥（base64url 未压缩点）补 x/y 拼出 JWK */
function vapidPrivateJwk(env: Env): JsonWebKey {
  const pub = b64urlDecode(env.VAPID_PUBLIC_KEY!); // 65B：0x04 || x || y
  return {
    kty: "EC",
    crv: "P-256",
    x: b64urlEncode(pub.slice(1, 33)),
    y: b64urlEncode(pub.slice(33, 65)),
    d: env.VAPID_PRIVATE_KEY!,
    ext: true,
  };
}

async function sendWeb(env: Env, sub: Subscription, ev: AlertEvent): Promise<void> {
  const keys = JSON.parse(sub.keys_json ?? "{}") as { p256dh?: string; auth?: string };
  if (!keys.p256dh || !keys.auth) {
    console.error(`web push: subscription ${sub.id} 缺少 keys`);
    return;
  }
  const req = await buildPushHTTPRequest({
    privateJWK: vapidPrivateJwk(env),
    message: {
      payload: { title: ev.title, body: ev.body },
      adminContact: env.VAPID_SUBJECT!,
      options: { ttl: 3600 },
    },
    subscription: { endpoint: sub.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } },
  });
  const res = await fetch(req.endpoint, { method: "POST", headers: req.headers, body: req.body });
  if (res.status === 404 || res.status === 410) {
    await removeSubscription(env, sub.id); // 订阅已失效，清掉
  } else if (!res.ok) {
    console.error(`web push ${sub.id}: HTTP ${res.status}`);
  }
}

/** .p8 PEM 全文 → PKCS8 DER */
function pemToDer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** APNs provider token：ES256 JWT，有效期 1 小时内可复用 */
async function apnsJwt(env: Env): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(env.APNS_KEY_P8!),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const enc = new TextEncoder();
  const header = b64urlEncode(enc.encode(JSON.stringify({ alg: "ES256", kid: env.APNS_KEY_ID })));
  const claims = b64urlEncode(enc.encode(JSON.stringify({ iss: env.APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) })));
  const data = `${header}.${claims}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(data));
  return `${data}.${b64urlEncode(new Uint8Array(sig))}`;
}

async function sendApns(env: Env, sub: Subscription, ev: AlertEvent, jwt: string): Promise<void> {
  const host = env.APNS_USE_SANDBOX === "1" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
  const res = await fetch(`${host}/3/device/${sub.endpoint}`, {
    method: "POST",
    headers: {
      authorization: `bearer ${jwt}`,
      "apns-topic": APNS_TOPIC,
      "apns-push-type": "alert",
    },
    body: JSON.stringify({ aps: { alert: { title: ev.title, body: ev.body }, sound: "default" } }),
  });
  if (res.ok) return;
  const detail = await res.text().catch(() => "");
  if (res.status === 410 || (res.status === 400 && detail.includes("BadDeviceToken"))) {
    await removeSubscription(env, sub.id); // token 失效，清掉
  } else {
    console.error(`apns push ${sub.id}: HTTP ${res.status} ${detail}`);
  }
}

/** 逐订阅逐事件并发下发；单条失败只 log，不影响其他订阅 */
export async function dispatchPush(env: Env, events: AlertEvent[]): Promise<void> {
  if (events.length === 0) return;
  const { results } = await env.DB.prepare(
    `SELECT id, platform, endpoint, keys_json FROM push_subscriptions`,
  ).all<Subscription>();
  if (results.length === 0) return;

  const webReady = Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);
  const apnsReady = Boolean(env.APNS_KEY_P8 && env.APNS_KEY_ID && env.APNS_TEAM_ID);
  if (!webReady && results.some((s) => s.platform === "web")) {
    console.error("web push: VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY/VAPID_SUBJECT 未配置，跳过 web 订阅");
  }
  if (!apnsReady && results.some((s) => s.platform === "ios")) {
    console.error("apns push: APNS_KEY_P8/APNS_KEY_ID/APNS_TEAM_ID 未配置，跳过 ios 订阅");
  }

  // APNs JWT 同一轮内复用（iat 相同即可）
  const jwt = apnsReady ? await apnsJwt(env) : null;

  const tasks: Promise<void>[] = [];
  for (const sub of results) {
    if (sub.platform === "web" && !webReady) continue;
    if (sub.platform === "ios" && !apnsReady) continue;
    for (const ev of events) {
      tasks.push(
        (sub.platform === "ios" ? sendApns(env, sub, ev, jwt!) : sendWeb(env, sub, ev)).catch((e) =>
          console.error(`push ${sub.platform}/${sub.id}:`, e),
        ),
      );
    }
  }
  await Promise.allSettled(tasks);
}
