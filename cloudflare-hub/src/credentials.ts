import type { Context } from "hono";
import type { Env } from "./index";
import { PROVIDER_SET } from "./ingest";
import { encryptCredential, decryptCredential, credentialHint } from "./crypto";

function bad(c: Context, msg: string): Response {
  return c.json({ error: "bad_request", detail: msg }, 400);
}

function credentialName(name: unknown): string {
  return typeof name === "string" && name.trim() ? name.trim().slice(0, 50) : "默认";
}

function updatedBy(c: Context): string {
  const p = c.get("principal");
  const device = c.req.header("x-client-device");
  return p.type === "service" ? `client:${p.name}` : device ? `client:${device}` : `web:${p.name}`;
}

/** GET /credentials —— 列表（不含明文），每个服务商可有多把 key */
export async function list(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;
  const { results } = await env.DB.prepare(
    `SELECT provider, name, hint, updated_at, updated_by FROM credentials ORDER BY provider, name`,
  ).all<Record<string, unknown>>();
  return c.json({ rows: results });
}

/** PUT /credentials/:provider —— 写入/更新；body { name?, payload }，name 缺省 "默认" */
export async function put(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;
  const provider = c.req.param("provider") ?? "";
  if (!PROVIDER_SET.has(provider)) return bad(c, `unknown provider: ${provider}`);
  if (!env.CREDENTIALS_KEY) return c.json({ error: "server_misconfigured", detail: "CREDENTIALS_KEY not set" }, 500);

  const body = (await c.req.json().catch(() => null)) as { payload?: unknown; name?: unknown } | null;
  const payload = body?.payload;
  if (payload == null) return bad(c, "payload required (object or string)");
  const name = credentialName(body?.name);

  // 统一存成 JSON 对象，runner 侧拿到的一定是可解析的 Record<string,string>
  const plaintext = typeof payload === "string" ? JSON.stringify({ value: payload }) : JSON.stringify(payload);
  const payloadEnc = await encryptCredential(env.CREDENTIALS_KEY, plaintext);
  const hint = credentialHint(payload);

  const updater = updatedBy(c);

  await env.DB.prepare(
    `INSERT INTO credentials (provider, name, payload_enc, hint, updated_at, updated_by)
     VALUES (?,?,?,?, datetime('now'), ?)
     ON CONFLICT (provider, name) DO UPDATE SET
       payload_enc = excluded.payload_enc,
       hint = excluded.hint,
       updated_at = datetime('now'),
       updated_by = excluded.updated_by`,
  )
    .bind(provider, name, payloadEnc, hint, updater)
    .run();

  return c.json({ ok: true, provider, name, hint, updated_by: updater });
}

/** PATCH /credentials/:provider —— 局部更新已有凭证；body { name?, payload: { fields... } }。
 *
 * 未提交的字段保持不变。密文无法在 SQL 内原子合并，因此用旧密文作乐观锁；发生并发更新时
 * 重新读取、解密、合并，避免两个局部更新互相覆盖。 */
export async function patch(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;
  const provider = c.req.param("provider") ?? "";
  if (!PROVIDER_SET.has(provider)) return bad(c, `unknown provider: ${provider}`);
  if (!env.CREDENTIALS_KEY) return c.json({ error: "server_misconfigured", detail: "CREDENTIALS_KEY not set" }, 500);

  const body = (await c.req.json().catch(() => null)) as { payload?: unknown; name?: unknown } | null;
  if (!body?.payload || typeof body.payload !== "object" || Array.isArray(body.payload)) {
    return bad(c, "payload required (non-empty object)");
  }
  const changes = Object.entries(body.payload as Record<string, unknown>);
  if (changes.length === 0) return bad(c, "payload required (non-empty object)");

  const name = credentialName(body.name);
  const updater = updatedBy(c);
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await env.DB.prepare(
      `SELECT payload_enc FROM credentials WHERE provider = ? AND name = ?`,
    )
      .bind(provider, name)
      .first<{ payload_enc: string }>();
    if (!existing) return c.json({ error: "not_found", detail: `credential not found: ${provider}/${name}` }, 404);

    let current: unknown;
    try {
      current = JSON.parse(await decryptCredential(env.CREDENTIALS_KEY, existing.payload_enc));
    } catch {
      return c.json({ error: "credential_unreadable", detail: "stored credential cannot be decrypted" }, 500);
    }
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return c.json({ error: "credential_unreadable", detail: "stored credential is not an object" }, 500);
    }

    const merged = Object.fromEntries([
      ...Object.entries(current as Record<string, unknown>),
      ...changes,
    ]);
    const payloadEnc = await encryptCredential(env.CREDENTIALS_KEY, JSON.stringify(merged));
    const hint = credentialHint(merged);
    const result = await env.DB.prepare(
      `UPDATE credentials
       SET payload_enc = ?, hint = ?, updated_at = datetime('now'), updated_by = ?
       WHERE provider = ? AND name = ? AND payload_enc = ?`,
    )
      .bind(payloadEnc, hint, updater, provider, name, existing.payload_enc)
      .run();
    if (result.meta.changes === 1) {
      return c.json({ ok: true, provider, name, hint, updated_by: updater });
    }
  }

  return c.json({ error: "conflict", detail: "credential changed concurrently; retry the request" }, 409);
}

/** DELETE /credentials/:provider[?name=] —— 仅用户身份；带 name 删单把，否则删该服务商全部 */
export async function del(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;
  const provider = c.req.param("provider") ?? "";
  if (!PROVIDER_SET.has(provider)) return bad(c, `unknown provider: ${provider}`);
  const name = c.req.query("name");
  const res = name
    ? await env.DB.prepare(`DELETE FROM credentials WHERE provider = ? AND name = ?`).bind(provider, name).run()
    : await env.DB.prepare(`DELETE FROM credentials WHERE provider = ?`).bind(provider).run();
  // 连带清掉该 key 的额度快照，避免已删 key 的数据继续显示在总览/额度页
  if (name) {
    await env.DB.prepare(`DELETE FROM quota_snapshots WHERE provider = ? AND account = ?`).bind(provider, name).run();
  } else {
    await env.DB.prepare(`DELETE FROM quota_snapshots WHERE provider = ?`).bind(provider).run();
  }
  return c.json({ ok: true, deleted: res.meta.changes });
}

/** GET /internal/credentials —— 解密明文，仅 runner；{ provider: [ { name, ...credFields } ] }
 *
 * runner 分工由 hub 统一决定（调用方无需配置 PROVIDERS）：
 * 对端 WAF 拦截 Workers 出口请求的 provider（EXTERNAL_RUNNER_PROVIDERS）只发给外部 runner
 * （service token 进来的 Go runner），内置 runner（进程内 loopback）拿其余全部。 */
export const EXTERNAL_RUNNER_PROVIDERS: ReadonlySet<string> = new Set(["kimi", "codex"]);

export async function internalList(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;
  if (!env.CREDENTIALS_KEY) return c.json({ error: "server_misconfigured", detail: "CREDENTIALS_KEY not set" }, 500);
  const external = c.get("principal").name !== "internal-runner";
  const { results } = await env.DB.prepare(
    `SELECT provider, name, payload_enc FROM credentials ORDER BY provider, name`,
  ).all<{
    provider: string;
    name: string;
    payload_enc: string;
  }>();

  const out: Record<string, unknown[]> = {};
  for (const r of results) {
    if (external !== EXTERNAL_RUNNER_PROVIDERS.has(r.provider)) continue;
    const list = (out[r.provider] ??= []);
    try {
      const plain = await decryptCredential(env.CREDENTIALS_KEY, r.payload_enc);
      list.push({ name: r.name, ...JSON.parse(plain) });
    } catch (e) {
      list.push({ name: r.name, __error__: `decrypt failed: ${String(e)}` });
    }
  }
  return c.json(out);
}
