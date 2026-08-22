import type { QuotaRow } from "./types";
import { adapters, runAdapter } from "./adapters";

export interface Env {
  HUB_URL: string;
  CF_ACCESS_CLIENT_ID?: string;
  CF_ACCESS_CLIENT_SECRET?: string;
  HUB_DEV_TOKEN?: string;
}

/** 调用 hub 时的鉴权头：本地开发用 Bearer dev token，生产用 Access service token 头 */
function hubAuthHeaders(env: Env): Record<string, string> {
  if (env.HUB_DEV_TOKEN) return { Authorization: `Bearer ${env.HUB_DEV_TOKEN}:runner` };
  if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
    return {
      "CF-Access-Client-Id": env.CF_ACCESS_CLIENT_ID,
      "CF-Access-Client-Secret": env.CF_ACCESS_CLIENT_SECRET,
    };
  }
  throw new Error("runner: 需要 HUB_DEV_TOKEN 或 CF_ACCESS_CLIENT_ID/SECRET");
}

/** 一轮采集：拉凭证 → 各适配器（每把 key 独立采集并打 account 标签）→ 上报快照。返回写入行数 */
export async function collect(env: Env, f: typeof fetch = fetch): Promise<number> {
  const headers = hubAuthHeaders(env);

  const credRes = await f(`${env.HUB_URL}/api/v1/internal/credentials`, { headers });
  if (!credRes.ok) throw new Error(`hub internal/credentials: HTTP ${credRes.status}`);
  // { provider: [ { name, ...credFields } ] } —— 每个服务商可有多把 key
  const creds = (await credRes.json()) as Record<string, Array<Record<string, unknown> & { name?: string }>>;

  const rows: QuotaRow[] = [];
  for (const [provider, keys] of Object.entries(creds)) {
    if (!Array.isArray(keys)) continue;
    for (const cred of keys) {
      if (cred == null || cred.__error__) continue;
      const account = typeof cred.name === "string" && cred.name ? cred.name : "默认";
      for (const r of await runAdapter(provider, cred, f)) {
        r.account = account;
        rows.push(r);
      }
    }
  }

  if (rows.length > 0) {
    const ingestRes = await f(`${env.HUB_URL}/api/v1/ingest/quota`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ rows }),
    });
    if (!ingestRes.ok) throw new Error(`hub ingest/quota: HTTP ${ingestRes.status}`);
  }
  return rows.length;
}

export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          const n = await collect(env);
          console.log(`tokendash-runner: collected ${n} quota rows`);
        } catch (e) {
          console.error("tokendash-runner:", e);
        }
      })(),
    );
  },

  /** 手动触发：GET /__trigger（调试用；生产应被 Access 保护） */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__trigger" || url.pathname === "/") {
      try {
        const n = await collect(env);
        return Response.json({ ok: true, rows: n });
      } catch (e) {
        return Response.json({ ok: false, error: String(e) }, { status: 500 });
      }
    }
    return new Response("tokendash-runner", { status: 200 });
  },
};
