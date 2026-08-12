import type { Context } from "hono";
import type { Env } from "./index";
import { PROVIDER_SET } from "./ingest";
import { encryptCredential, decryptCredential, credentialHint } from "./crypto";

function bad(c: Context, msg: string): Response {
  return c.json({ error: "bad_request", detail: msg }, 400);
}

/** GET /credentials —— 列表（不含明文） */
export async function list(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;
  const { results } = await env.DB.prepare(
    `SELECT provider, hint, updated_at, updated_by FROM credentials ORDER BY provider`,
  ).all<Record<string, unknown>>();
  return c.json({ rows: results });
}

/** PUT /credentials/:provider —— 写入/更新（明文 JSON 入参，hub 加密存储） */
export async function put(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;
  const provider = c.req.param("provider") ?? "";
  if (!PROVIDER_SET.has(provider)) return bad(c, `unknown provider: ${provider}`);
  if (!env.CREDENTIALS_KEY) return c.json({ error: "server_misconfigured", detail: "CREDENTIALS_KEY not set" }, 500);

  const body = await c.req.json().catch(() => null);
  const payload = (body as { payload?: unknown } | null)?.payload;
  if (payload == null) return bad(c, "payload required (object or string)");

  // 统一存成 JSON 对象，runner 侧拿到的一定是可解析的 Record<string,string>
  const plaintext = typeof payload === "string" ? JSON.stringify({ value: payload }) : JSON.stringify(payload);
  const payloadEnc = await encryptCredential(env.CREDENTIALS_KEY, plaintext);
  const hint = credentialHint(payload);

  const p = c.get("principal");
  const device = c.req.header("x-client-device");
  const updatedBy = p.type === "service" ? `client:${p.name}` : device ? `client:${device}` : `web:${p.name}`;

  await env.DB.prepare(
    `INSERT INTO credentials (provider, payload_enc, hint, updated_at, updated_by)
     VALUES (?,?,?, datetime('now'), ?)
     ON CONFLICT (provider) DO UPDATE SET
       payload_enc = excluded.payload_enc,
       hint = excluded.hint,
       updated_at = datetime('now'),
       updated_by = excluded.updated_by`,
  )
    .bind(provider, payloadEnc, hint, updatedBy)
    .run();

  return c.json({ ok: true, provider, hint, updated_by: updatedBy });
}

/** DELETE /credentials/:provider —— 仅用户身份 */
export async function del(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;
  const provider = c.req.param("provider") ?? "";
  if (!PROVIDER_SET.has(provider)) return bad(c, `unknown provider: ${provider}`);
  const res = await env.DB.prepare(`DELETE FROM credentials WHERE provider = ?`).bind(provider).run();
  return c.json({ ok: true, deleted: res.meta.changes });
}

/** GET /internal/credentials —— 解密明文，仅 runner */
export async function internalList(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;
  if (!env.CREDENTIALS_KEY) return c.json({ error: "server_misconfigured", detail: "CREDENTIALS_KEY not set" }, 500);
  const { results } = await env.DB.prepare(`SELECT provider, payload_enc FROM credentials`).all<{
    provider: string;
    payload_enc: string;
  }>();

  const out: Record<string, unknown> = {};
  for (const r of results) {
    try {
      const plain = await decryptCredential(env.CREDENTIALS_KEY, r.payload_enc);
      out[r.provider] = JSON.parse(plain);
    } catch (e) {
      out[r.provider] = { __error__: `decrypt failed: ${String(e)}` };
    }
  }
  return c.json(out);
}
