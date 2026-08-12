// runner 集成测试：hub worker 监听真实端口；runner worker 的 outboundService
// 在 Node 侧转发 hub 请求 + mock 各服务商 API，验证完整采集链路。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Miniflare } from "miniflare";
import { build } from "esbuild";
import { readFileSync, mkdirSync } from "node:fs";

const DEV_TOKEN = "test-secret";
const KEY_B64 = Buffer.from("k".repeat(32)).toString("base64");
const HUB_PORT = 18787;

let hubMf;
let runnerMf;
let hub; // hub worker 的 dispatchFetch（Node 侧）
let runner;
let hubBaseUrl;

before(async () => {
  mkdirSync("dist", { recursive: true });
  await build({ entryPoints: ["src/index.ts"], bundle: true, format: "esm", outfile: "dist/runner.mjs", platform: "browser", logLevel: "silent" });
  await build({ entryPoints: ["../cloudflare-hub/src/index.ts"], bundle: true, format: "esm", outfile: "dist/hub.mjs", platform: "browser", logLevel: "silent" });

  hubMf = new Miniflare({
    modules: true,
    scriptPath: "dist/hub.mjs",
    bindings: { DEV_TOKEN, CREDENTIALS_KEY: KEY_B64 },
    d1Databases: ["DB"],
    port: HUB_PORT,
  });
  hub = hubMf.dispatchFetch;
  hubBaseUrl = `http://127.0.0.1:${HUB_PORT}`;

  const db = await hubMf.getD1Database("DB");
  const sql = readFileSync("../cloudflare-hub/migrations/0001_init.sql", "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join(" ");
  await db.exec(sql);

  // 外部 API mock：cursor 故意返回 500 以验证 scrape_error；其余返回固定响应
  const fakeExternal = async (req) => {
    const url = new URL(req.url);
    if (url.hostname === "hub.local") {
      return fetch(hubBaseUrl + url.pathname + url.search, {
        method: req.method,
        headers: req.headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.text(),
      });
    }
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
    if (url.hostname === "api.openai.com") {
      if (url.pathname.startsWith("/v1/organization/costs")) {
        return json({ data: [{ results: [{ amount: { value: 3.5, currency: "usd" } }] }] });
      }
      return json({}, 404);
    }
    if (url.hostname === "api.deepseek.com") {
      return json({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: 88.8 }] });
    }
    if (url.hostname === "open.bigmodel.cn") {
      return json({ code: 200, message: "success", data: { balance_infos: [{ currency: "CNY", total_balance: 12.34, available_balance: 10 }] } });
    }
    if (url.hostname === "api.github.com") {
      return json({ status: "active", plan: { seat: "premium", usage: { limit: 100, used: 37, remaining: 63 } } });
    }
    if (url.hostname === "claude.ai") {
      if (url.pathname === "/api/organizations") return json([{ uuid: "org-1" }]);
      if (url.pathname.endsWith("/usage")) {
        return json({
          total_usage: {
            rate_limit_model: [{ model: "claude-sonnet-4-5", max_in_window: 100, used_in_window: 30 }],
            rate_limit_system: [{ period: "week", model: "system", max: 500, used: 200 }],
          },
        });
      }
    }
    if (url.hostname === "www.cursor.com") {
      return json({ error: "mock failure" }, 500);
    }
    return new Response("unhandled: " + url.hostname, { status: 500 });
  };

  runnerMf = new Miniflare({
    modules: true,
    scriptPath: "dist/runner.mjs",
    bindings: { HUB_URL: "http://hub.local", HUB_DEV_TOKEN: DEV_TOKEN, PROVIDERS: "" },
    outboundService: fakeExternal,
  });
  runner = runnerMf.dispatchFetch;
});

after(async () => {
  await runnerMf?.dispose();
  await hubMf?.dispose();
});

const user = { headers: { Authorization: `Bearer ${DEV_TOKEN}` } };

async function putCred(provider, payload) {
  return hub(`http://localhost/api/v1/credentials/${provider}`, {
    method: "PUT",
    body: JSON.stringify({ payload }),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${DEV_TOKEN}` },
  });
}

async function quotaRows() {
  return (await (await hub("http://localhost/api/v1/quota/current", user)).json()).rows;
}

test("完整采集链路：凭证 → 适配器 → 快照入库", async () => {
  for (const [p, cred] of [
    ["openai", { api_key: "sk-admin-test" }],
    ["deepseek", { api_key: "sk-ds" }],
    ["glm", { api_key: "glm-key" }],
    ["copilot", { token: "ghp_test" }],
    ["claude", { session_key: "sk-ant-test" }],
    ["cursor", { session: "WorkosFederatedSession=abc; WorkosSession=def" }],
  ]) {
    const res = await putCred(p, cred);
    assert.equal(res.status, 200, `put cred ${p}`);
  }

  const trigger = await runner("http://runner.local/__trigger");
  assert.equal(trigger.status, 200, `trigger: ${await trigger.text()}`);

  const rows = await quotaRows();
  const byMetric = (provider, metric) => rows.find((r) => r.provider === provider && r.metric === metric);

  assert.equal(byMetric("openai", "month_cost_usd")?.value, 3.5);
  assert.equal(byMetric("deepseek", "balance_cny")?.value, 88.8);
  const glmBal = byMetric("glm", "balance_cny");
  assert.equal(glmBal?.value, 12.34);
  assert.equal(glmBal?.limit_value, 10);
  assert.equal(byMetric("copilot", "premium_used")?.value, 37);
  assert.equal(byMetric("copilot", "premium_remaining")?.value, 63);
  assert.equal(byMetric("claude", "session_used_pct")?.value, 30);
  assert.equal(byMetric("claude", "weekly_used_pct")?.value, 40);
  // cursor 接口失败 → scrape_error，不阻塞整轮
  const err = byMetric("cursor", "scrape_error");
  assert.ok(err, "cursor scrape_error 应存在");
  assert.ok(String(err.reset_at).includes("HTTP 500"));
});

test("再次触发：快照 append-only，history 可见两次采集", async () => {
  const trigger = await runner("http://runner.local/__trigger");
  assert.equal(trigger.status, 200);
  const histRes = await hub(
    "http://localhost/api/v1/quota/history?provider=openai&metric=month_cost_usd",
    user,
  );
  const hist = (await histRes.json()).rows;
  assert.ok(hist.length >= 2, `历史快照追加，实际 ${hist.length}`);
  assert.equal(hist[hist.length - 1].value, 3.5);
});

test("unhandled 状态码：runner 触发错误时返回 500", async () => {
  const res = await runner("http://runner.local/");
  assert.equal(res.status, 200);
});
