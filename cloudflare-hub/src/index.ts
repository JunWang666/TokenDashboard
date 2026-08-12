import { Hono } from "hono";
import { cors } from "hono/cors";
import { authMiddleware, requireRole } from "./auth";
import * as ingest from "./ingest";
import * as query from "./query";
import * as credentials from "./credentials";

export interface Env {
  DB: D1Database;
  ACCESS_TEAM?: string;
  ACCESS_AUD?: string;
  CREDENTIALS_KEY?: string;
  RUNNER_SERVICE_TOKENS?: string;
  CORS_ORIGINS?: string;
  DEV_TOKEN?: string;
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
api.get("/usage/timeseries", requireRole("user", "client"), query.timeseries);
api.get("/quota/current", requireRole("user", "client"), query.quotaCurrent);
api.get("/quota/history", requireRole("user", "client"), query.quotaHistory);
api.get("/devices", requireRole("user", "client"), query.devices);

api.get("/credentials", requireRole("user", "client"), credentials.list);
api.put("/credentials/:provider", requireRole("user", "client"), credentials.put);
api.delete("/credentials/:provider", requireRole("user"), credentials.del);
api.get("/internal/credentials", requireRole("runner"), credentials.internalList);

app.route("/api/v1", api);

app.onError((err, c) => {
  console.error("hub error:", err);
  return c.json({ error: "internal_error", detail: String(err) }, 500);
});

export default app;
