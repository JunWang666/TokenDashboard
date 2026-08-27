import type { Context } from "hono";
import type { Env } from "./index";
import type { AlertEvent } from "./alerts";
import { encryptCredential, decryptCredential } from "./crypto";

/** 第三方通知渠道：飞书自定义机器人 webhook + Bark。配置存 settings 表，密钥加密（与凭证同级）。 */

const KEY_FEISHU_URL = "feishu_webhook_url";
const KEY_FEISHU_SECRET = "feishu_webhook_secret"; // 加密存储（机器人签名校验密钥，可选）
const KEY_BARK_SERVER = "bark_server";
const KEY_BARK_KEY = "bark_key"; // 加密存储（设备 key）

export interface NotifyConfig {
  feishu: { url: string; secret: string | null } | null;
  bark: { server: string; key: string } | null;
}

async function readSettings(env: Env, keys: string[]): Promise<Record<string, string>> {
  const { results } = await env.DB.prepare(
    `SELECT key, value FROM settings WHERE key IN (${keys.map(() => "?").join(",")})`,
  )
    .bind(...keys)
    .all<{ key: string; value: string }>();
  const out: Record<string, string> = {};
  for (const r of results) out[r.key] = r.value;
  return out;
}

/** 读通知渠道配置并解密密钥；未配置的渠道为 null */
export async function readNotifyConfig(env: Env): Promise<NotifyConfig> {
  const s = await readSettings(env, [KEY_FEISHU_URL, KEY_FEISHU_SECRET, KEY_BARK_SERVER, KEY_BARK_KEY]);
  const dec = async (enc: string | undefined): Promise<string | null> => {
    if (!enc) return null;
    if (!env.CREDENTIALS_KEY) throw new Error("CREDENTIALS_KEY not set");
    return decryptCredential(env.CREDENTIALS_KEY, enc);
  };
  return {
    feishu: s[KEY_FEISHU_URL] ? { url: s[KEY_FEISHU_URL], secret: await dec(s[KEY_FEISHU_SECRET]) } : null,
    bark: s[KEY_BARK_SERVER] && s[KEY_BARK_KEY] ? { server: s[KEY_BARK_SERVER], key: (await dec(s[KEY_BARK_KEY]))! } : null,
  };
}

/** 飞书自定义机器人签名：HmacSHA256(key=`${timestamp}\n${secret}`, data="") 的 base64 */
export async function feishuSign(secret: string, timestamp: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`${timestamp}\n${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new Uint8Array(0));
  const bytes = new Uint8Array(sig);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export async function sendFeishu(
  feishu: { url: string; secret: string | null },
  ev: AlertEvent,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const payload: Record<string, unknown> = {
    msg_type: "text",
    content: { text: `${ev.title}\n${ev.body}` },
  };
  if (feishu.secret) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    payload.timestamp = timestamp;
    payload.sign = await feishuSign(feishu.secret, timestamp);
  }
  const res = await fetchImpl(feishu.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json().catch(() => null)) as { code?: number; StatusCode?: number; msg?: string } | null;
  if (!res.ok || (data && data.code !== 0 && data.StatusCode !== 0)) {
    throw new Error(`feishu webhook: HTTP ${res.status} ${data?.msg ?? ""}`);
  }
}

export async function sendBark(
  bark: { server: string; key: string },
  ev: AlertEvent,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const url = `${bark.server.replace(/\/+$/, "")}/${bark.key}`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: ev.title, body: ev.body, group: "TokenDashboard" }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json().catch(() => null)) as { code?: number; message?: string } | null;
  if (!res.ok || (data && data.code !== 200)) {
    throw new Error(`bark: HTTP ${res.status} ${data?.message ?? ""}`);
  }
}

/** 把新告警事件发到所有已配置的第三方渠道；单渠道失败只 log */
export async function dispatchNotify(env: Env, events: AlertEvent[]): Promise<void> {
  if (events.length === 0) return;
  const cfg = await readNotifyConfig(env);
  if (!cfg.feishu && !cfg.bark) return;
  const tasks: Promise<void>[] = [];
  for (const ev of events) {
    if (cfg.feishu) tasks.push(sendFeishu(cfg.feishu, ev).catch((e) => console.error("notify feishu:", e)));
    if (cfg.bark) tasks.push(sendBark(cfg.bark, ev).catch((e) => console.error("notify bark:", e)));
  }
  await Promise.allSettled(tasks);
}

// ---------- 配置 API ----------

/** GET /notify-channels —— 返回当前配置（密钥不回传明文） */
export async function getChannels(c: Context<{ Bindings: Env }>): Promise<Response> {
  const s = await readSettings(c.env, [KEY_FEISHU_URL, KEY_FEISHU_SECRET, KEY_BARK_SERVER, KEY_BARK_KEY]);
  return c.json({
    feishu: { url: s[KEY_FEISHU_URL] ?? null, hasSecret: Boolean(s[KEY_FEISHU_SECRET]) },
    bark: { server: s[KEY_BARK_SERVER] ?? null, hasKey: Boolean(s[KEY_BARK_KEY]) },
  });
}

function upsertStmt(env: Env, key: string, value: string): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).bind(key, value);
}

/** PUT /notify-channels —— body { feishu?: { url, secret? }, bark?: { server, key? } }。
 *  某渠道未出现在 body 中则不动；url/server 为空串则清除该渠道。
 *  secret/key 提供时覆盖；url/server 变化且未提供新密钥时清掉旧密钥（沿用 collect-webhook 语义）。 */
export async function putChannels(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;
  const body = (await c.req.json().catch(() => null)) as {
    feishu?: { url?: unknown; secret?: unknown };
    bark?: { server?: unknown; key?: unknown };
  } | null;
  if (!body || (body.feishu === undefined && body.bark === undefined)) {
    return c.json({ error: "bad_request", detail: "body 需包含 feishu 或 bark 字段" }, 400);
  }

  const old = await readSettings(env, [KEY_FEISHU_URL, KEY_FEISHU_SECRET, KEY_BARK_SERVER, KEY_BARK_KEY]);
  const stmts: D1PreparedStatement[] = [];

  if (body.feishu !== undefined) {
    const url = typeof body.feishu.url === "string" ? body.feishu.url.trim() : "";
    const secret = typeof body.feishu.secret === "string" ? body.feishu.secret.trim() : "";
    if (!url) {
      stmts.push(env.DB.prepare(`DELETE FROM settings WHERE key IN (?, ?)`).bind(KEY_FEISHU_URL, KEY_FEISHU_SECRET));
    } else if (!/^https?:\/\//i.test(url)) {
      return c.json({ error: "bad_request", detail: "feishu.url 必须是 http(s) 地址" }, 400);
    } else {
      stmts.push(upsertStmt(env, KEY_FEISHU_URL, url));
      if (secret) {
        if (!env.CREDENTIALS_KEY) return c.json({ error: "server_misconfigured", detail: "CREDENTIALS_KEY not set" }, 500);
        stmts.push(upsertStmt(env, KEY_FEISHU_SECRET, await encryptCredential(env.CREDENTIALS_KEY, secret)));
      } else if (old[KEY_FEISHU_URL] !== url) {
        stmts.push(env.DB.prepare(`DELETE FROM settings WHERE key = ?`).bind(KEY_FEISHU_SECRET));
      }
    }
  }

  if (body.bark !== undefined) {
    const server = typeof body.bark.server === "string" ? body.bark.server.trim().replace(/\/+$/, "") : "";
    const key = typeof body.bark.key === "string" ? body.bark.key.trim() : "";
    if (!server) {
      stmts.push(env.DB.prepare(`DELETE FROM settings WHERE key IN (?, ?)`).bind(KEY_BARK_SERVER, KEY_BARK_KEY));
    } else if (!/^https?:\/\//i.test(server)) {
      return c.json({ error: "bad_request", detail: "bark.server 必须是 http(s) 地址" }, 400);
    } else if (!key && !old[KEY_BARK_KEY]) {
      return c.json({ error: "bad_request", detail: "首次配置 bark 需提供 key" }, 400);
    } else {
      stmts.push(upsertStmt(env, KEY_BARK_SERVER, server));
      if (key) {
        if (!env.CREDENTIALS_KEY) return c.json({ error: "server_misconfigured", detail: "CREDENTIALS_KEY not set" }, 500);
        stmts.push(upsertStmt(env, KEY_BARK_KEY, await encryptCredential(env.CREDENTIALS_KEY, key)));
      } else if (old[KEY_BARK_SERVER] !== server) {
        stmts.push(env.DB.prepare(`DELETE FROM settings WHERE key = ?`).bind(KEY_BARK_KEY));
      }
    }
  }

  if (stmts.length > 0) await env.DB.batch(stmts);
  return getChannels(c);
}
