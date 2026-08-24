import type { Context } from "hono";
import type { Env } from "./index";
import { encryptCredential, decryptCredential } from "./crypto";

const KEY_URL = "collect_webhook_url";
const KEY_SECRET = "collect_webhook_secret"; // 加密存储，与凭证同级

async function readSettings(env: Env): Promise<Record<string, string>> {
  const { results } = await env.DB.prepare(`SELECT key, value FROM settings`).all<{ key: string; value: string }>();
  const out: Record<string, string> = {};
  for (const r of results) out[r.key] = r.value;
  return out;
}

/** GET /collect-webhook —— 返回当前配置（secret 不回传明文） */
export async function get(c: Context<{ Bindings: Env }>): Promise<Response> {
  const s = await readSettings(c.env);
  return c.json({ url: s[KEY_URL] ?? null, hasSecret: Boolean(s[KEY_SECRET]) });
}

/** PUT /collect-webhook —— body { url, secret? }；空 url 清除配置。
 *  secret 提供时覆盖；未提供且 url 不变时保留旧 secret；url 变化时清掉旧 secret。 */
export async function put(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;
  const body = (await c.req.json().catch(() => null)) as { url?: unknown; secret?: unknown } | null;
  const url = typeof body?.url === "string" ? body.url.trim() : "";
  const secret = typeof body?.secret === "string" ? body.secret.trim() : "";

  if (!url) {
    await env.DB.prepare(`DELETE FROM settings WHERE key IN (?, ?)`).bind(KEY_URL, KEY_SECRET).run();
    return c.json({ ok: true, url: null, hasSecret: false });
  }
  if (!/^https?:\/\//i.test(url)) {
    return c.json({ error: "bad_request", detail: "url 必须是 http(s) 地址" }, 400);
  }

  const old = await readSettings(env);
  const urlChanged = old[KEY_URL] !== url;

  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    ).bind(KEY_URL, url),
  ];
  if (secret) {
    if (!env.CREDENTIALS_KEY) return c.json({ error: "server_misconfigured", detail: "CREDENTIALS_KEY not set" }, 500);
    const enc = await encryptCredential(env.CREDENTIALS_KEY, secret);
    stmts.push(
      env.DB.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      ).bind(KEY_SECRET, enc),
    );
  } else if (urlChanged) {
    stmts.push(env.DB.prepare(`DELETE FROM settings WHERE key = ?`).bind(KEY_SECRET));
  }
  await env.DB.batch(stmts);

  return c.json({ ok: true, url, hasSecret: Boolean(secret || (!urlChanged && old[KEY_SECRET])) });
}

/** 点「立即采集」时通知公网可达的独立 runner。
 *  返回 null（未配置）/ "triggered" / "failed: <原因>"；runner 侧 202 即返回，采集异步完成。 */
export async function notifyRunner(env: Env): Promise<string | null> {
  const s = await readSettings(env);
  const url = s[KEY_URL];
  if (!url) return null;

  const headers: Record<string, string> = {};
  if (s[KEY_SECRET]) {
    if (!env.CREDENTIALS_KEY) return "failed: CREDENTIALS_KEY not set";
    try {
      headers["Authorization"] = `Bearer ${await decryptCredential(env.CREDENTIALS_KEY, s[KEY_SECRET])}`;
    } catch (e) {
      return `failed: ${String(e)}`;
    }
  }
  try {
    // 配置了 VPC 绑定时走 Cloudflare Tunnel 触达私网 runner（webhook URL 应填私网地址），否则走公网
    const fetcher: typeof fetch = env.RUNNER_VPC ? env.RUNNER_VPC.fetch.bind(env.RUNNER_VPC) : fetch;
    const res = await fetcher(url, { method: "POST", headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return `failed: HTTP ${res.status}`;
    return "triggered";
  } catch (e) {
    return `failed: ${String(e)}`;
  }
}
