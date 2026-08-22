import { Hono } from "hono";
import { cors } from "hono/cors";
import { authMiddleware, requireRole } from "./auth";
import * as ingest from "./ingest";
import * as query from "./query";
import * as credentials from "./credentials";
import { collect } from "./runner/index";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ACCESS_TEAM?: string;
  ACCESS_AUD?: string;
  CREDENTIALS_KEY?: string;
  RUNNER_SERVICE_TOKENS?: string;
  CORS_ORIGINS?: string;
  DEV_TOKEN?: string;
  // runner（采集器，与本 Worker 合并部署）
  HUB_URL: string;
  CF_ACCESS_CLIENT_ID?: string;
  CF_ACCESS_CLIENT_SECRET?: string;
}

const app = new Hono<{ Bindings: Env }>();

app.use(
  "*",
  cors({
    origin: (origin: string, c) => {
      const allowed = (c.env.CORS_ORIGINS ?? "")
        .split(",")
        .map((s: string) => s.trim())
        .filter(Boolean);
      if (allowed.length === 0) return origin ?? ""; // 未配置时反射任意来源（个人使用默认，生产应配置）
      if (origin && allowed.includes(origin)) return origin;
      return "";
    },
    credentials: true,
  }),
);

app.get("/healthz", (c) => c.json({ ok: true, ts: new Date().toISOString() }));

const api = new Hono<{ Bindings: Env }>();
api.use("*", authMiddleware);

api.post("/ingest/usage", requireRole("user", "client"), ingest.postUsage);
api.post("/ingest/quota", requireRole("runner"), ingest.postQuota);

api.get("/summary", requireRole("user", "client"), query.summary);
api.get("/bootstrap", requireRole("user", "client"), query.bootstrap);
api.get("/usage/timeseries", requireRole("user", "client"), query.timeseries);
api.get("/quota/current", requireRole("user", "client"), query.quotaCurrent);
api.get("/quota/history", requireRole("user", "client"), query.quotaHistory);
api.get("/devices", requireRole("user", "client"), query.devices);

api.get("/credentials", requireRole("user", "client"), credentials.list);
api.put("/credentials/:provider", requireRole("user", "client"), credentials.put);
api.delete("/credentials/:provider", requireRole("user"), credentials.del);
api.get("/internal/credentials", requireRole("runner"), credentials.internalList);

/** 主动触发一轮额度采集（登录用户/客户端可用） */
api.post("/collect", requireRole("user", "client"), async (c) => {
  try {
    const n = await collect(c.env, localFetch(c.env, c.executionCtx));
    return c.json({ ok: true, rows: n });
  } catch (e) {
    return c.json({ ok: false, error: String(e) }, 500);
  }
});

app.route("/api/v1", api);

/** 合并部署下 runner 的 loopback：打向 HUB_URL 的请求直接进本 Worker，不走公网回环 */
function localFetch(env: Env, ctx: ExecutionContext): typeof fetch {
  return (input, init) => {
    const req = new Request(input, init);
    const hubOrigin = env.HUB_URL ? new URL(env.HUB_URL).origin : null;
    if (hubOrigin && new URL(req.url).origin === hubOrigin) {
      const headers = new Headers(req.headers);
      headers.set("X-Tokendash-Internal", env.CREDENTIALS_KEY ?? "");
      return Promise.resolve(app.fetch(new Request(req, { headers }), env, ctx));
    }
    return fetch(req);
  };
}

/** 手动触发一轮额度采集（生产经 Access service token 保护） */
app.get("/__trigger", async (c) => {
  try {
    const n = await collect(c.env, localFetch(c.env, c.executionCtx));
    return c.json({ ok: true, rows: n });
  } catch (e) {
    return c.json({ ok: false, error: String(e) }, 500);
  }
});

// 其余路径交给静态资产（SPA；not_found_handling 兜底 index.html）
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

app.onError((err, c) => {
  console.error("hub error:", err);
  return c.json({ error: "internal_error", detail: String(err) }, 500);
});

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),
  /** cron：每 15 分钟采集一轮各服务商额度 */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          const n = await collect(env, localFetch(env, ctx));
          console.log(`tokendash: collected ${n} quota rows`);
        } catch (e) {
          console.error("tokendash collect:", e);
        }
      })(),
    );
  },
};
