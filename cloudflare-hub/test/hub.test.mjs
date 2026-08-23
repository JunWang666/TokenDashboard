// hub 集成测试：node --test test/
// 用 miniflare 在本地跑整个 worker（先 esbuild 打包），覆盖鉴权/角色、ingest、查询、凭证加解密。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Miniflare } from "miniflare";
import { build } from "esbuild";
import { readFileSync, mkdirSync } from "node:fs";

const DEV_TOKEN = "test-secret";
const KEY_B64 = Buffer.from("k".repeat(32)).toString("base64");

let mf;
let db;

before(async () => {
  mkdirSync("dist", { recursive: true });
  await build({
    entryPoints: ["src/index.ts"],
    bundle: true,
    format: "esm",
    outfile: "dist/worker.mjs",
    platform: "browser",
    logLevel: "silent",
  });
  mf = new Miniflare({
    modules: true,
    scriptPath: "dist/worker.mjs",
    bindings: {
      DEV_TOKEN,
      CREDENTIALS_KEY: KEY_B64,
      ACCESS_TEAM: "example-team",
      ACCESS_AUD: "aud-hub",
      RUNNER_SERVICE_TOKENS: "tokendash-runner",
    },
    d1Databases: ["DB"],
  });
  db = await mf.getD1Database("DB");
  // miniflare 的 D1 exec 逐行解析，压成单行语句
  for (const f of ["migrations/0001_init.sql", "migrations/0002_multi_key.sql"]) {
    const sql = readFileSync(f, "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join(" ");
    await db.exec(sql);
  }
});

after(async () => {
  await mf?.dispose();
});

const user = { headers: { Authorization: `Bearer ${DEV_TOKEN}` } };
const client = { headers: { Authorization: `Bearer ${DEV_TOKEN}:client` } };
const runner = { headers: { Authorization: `Bearer ${DEV_TOKEN}:runner` } };

const usageBody = {
  device_id: "macbook-m4",
  rows: [
    {
      provider: "claude",
      source: "claude-code",
      model: "claude-sonnet-4-5",
      bucket_hour: "2026-08-12T14:00:00Z",
      input_tokens: 12000,
      output_tokens: 3500,
      cache_read_tokens: 480000,
      cache_write_tokens: 20000,
      cost_usd: 0.31,
      requests: 14,
    },
    {
      provider: "deepseek",
      source: "opencode",
      model: "deepseek-v4",
      bucket_hour: "2026-08-12T14:00:00Z",
      input_tokens: 5000,
      output_tokens: 1000,
      cost_usd: 0.02,
      requests: 5,
    },
  ],
};

const get = (path, init) => mf.dispatchFetch(`http://localhost${path}`, init);
const post = (path, body, init) =>
  get(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
const put = (path, body, init) =>
  get(path, {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...init?.headers },
  });

test("healthz open", async () => {
  const res = await get("/healthz");
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test("rejects anonymous API calls", async () => {
  assert.equal((await get("/api/v1/summary")).status, 401);
  assert.equal((await get("/api/v1/summary", { headers: { Authorization: "Bearer nope" } })).status, 401);
});

test("role enforcement", async () => {
  assert.equal((await post("/api/v1/ingest/usage", usageBody, runner)).status, 403);
  assert.equal((await post("/api/v1/ingest/quota", { rows: [] }, user)).status, 403);
  assert.equal((await get("/api/v1/internal/credentials", user)).status, 403);
});

test("usage ingest as user + client, idempotent upsert", async () => {
  const r1 = await post("/api/v1/ingest/usage", usageBody, user);
  assert.equal(r1.status, 200);
  assert.equal((await r1.json()).rows, 2);

  // 重复上报（client 重试）不翻倍
  const r2 = await post("/api/v1/ingest/usage", usageBody, client);
  assert.equal(r2.status, 200);
  const s = await (await get("/api/v1/summary", user)).json();
  const claude = s.rows.find((r) => r.key === "claude");
  assert.equal(claude.input_tokens, 12000);
  assert.equal(claude.requests, 14);

  // devices 心跳
  const dev = await (await get("/api/v1/devices", user)).json();
  assert.ok(dev.rows.find((r) => r.device_id === "macbook-m4").last_seen_at);
});

test("summary group_by day + SQL 注入防护", async () => {
  const res = await get("/api/v1/summary?group_by=day", user);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.rows[0].key, "2026-08-12");
  const bad = await get("/api/v1/summary?group_by=provider;DROP TABLE usage_hourly", user);
  assert.equal(bad.status, 400);
});

test("timeseries hour/day", async () => {
  const res = await get(
    "/api/v1/usage/timeseries?interval=hour&group_by=provider&from=2026-08-12T00:00:00Z&to=2026-08-13T00:00:00Z",
    user,
  );
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.rows.length, 2);
  const day = await (await get("/api/v1/usage/timeseries?interval=day&group_by=model", user)).json();
  assert.equal(day.rows.find((r) => r.series === "claude-sonnet-4-5").requests, 14);
});

test("quota ingest (runner) + current/history (user)", async () => {
  // current/bootstrap 只展示仍有凭证的 key，先建凭证（默认名）
  await put("/api/v1/credentials/claude", { payload: { session_key: "sk-ant-test" } }, user);
  await put("/api/v1/credentials/openai", { payload: { api_key: "sk-test-quota" } }, user);

  const res = await post(
    "/api/v1/ingest/quota",
    {
      rows: [
        { provider: "claude", metric: "weekly_used_pct", account: "默认", value: 32.5, unit: "percent" },
        { provider: "openai", metric: "balance_usd", account: "默认", value: 12.34, unit: "usd" },
      ],
    },
    runner,
  );
  assert.equal(res.status, 200);

  const cur = await (await get("/api/v1/quota/current", user)).json();
  assert.equal(cur.rows.length, 2);
  assert.equal(cur.rows.find((r) => r.provider === "claude").value, 32.5);

  // 追加快照后 current 取最新
  await post(
    "/api/v1/ingest/quota",
    { rows: [{ provider: "claude", metric: "weekly_used_pct", account: "默认", value: 41, unit: "percent" }] },
    runner,
  );
  const cur2 = await (await get("/api/v1/quota/current", user)).json();
  assert.equal(cur2.rows.find((r) => r.provider === "claude").value, 41);

  const hist = await (await get("/api/v1/quota/history?provider=claude&metric=weekly_used_pct", user)).json();
  assert.deepEqual(hist.rows.map((r) => r.value), [32.5, 41]);

  // 清理凭证（连带清掉 quota 快照），避免影响后续 credentials 测试
  await get("/api/v1/credentials/claude", { method: "DELETE", headers: user.headers });
  await get("/api/v1/credentials/openai", { method: "DELETE", headers: user.headers });
  const after = await (await get("/api/v1/quota/current", user)).json();
  assert.equal(after.rows.length, 0);
});

test("credentials: put(hint only) / list / client put / delete 权限", async () => {
  const res = await put(
    "/api/v1/credentials/openai",
    { payload: { api_key: "sk-supersecret-1234" } },
    user,
  );
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.hint, "...1234");
  assert.equal(json.updated_by, "web:dev");

  await put("/api/v1/credentials/deepseek", { payload: { api_key: "sk-ds-secret" } }, client);
  const list = await (await get("/api/v1/credentials", user)).json();
  assert.equal(list.rows.length, 2);
  const openai = list.rows.find((r) => r.provider === "openai");
  assert.equal(openai.payload_enc, undefined);
  assert.equal(openai.hint, "...1234");

  // client service token 不能删
  assert.equal((await get("/api/v1/credentials/deepseek", { method: "DELETE", headers: client.headers })).status, 403);
  // user 可以删
  assert.equal((await get("/api/v1/credentials/deepseek", { method: "DELETE", headers: user.headers })).status, 200);
});

test("credentials: 字符串入参存 {value}；internal/credentials 按 runner 身份分工", async () => {
  await put("/api/v1/credentials/glm", { payload: "glm-plain-secret" }, user);
  await put("/api/v1/credentials/kimi", { payload: { api_key: "sk-kimi-ext" } }, user);

  // 外部 runner（service token / dev token）：只拿到对端 WAF 拦截 Workers 的 provider
  const ext = await (await get("/api/v1/internal/credentials", runner)).json();
  assert.deepEqual(Object.keys(ext), ["kimi"]);
  assert.equal(ext.kimi[0].api_key, "sk-kimi-ext");

  // 内置 runner（进程内 loopback，X-Tokendash-Internal）：拿其余 provider
  const internal = await (
    await get("/api/v1/internal/credentials", { headers: { "X-Tokendash-Internal": KEY_B64 } })
  ).json();
  assert.deepEqual(internal.glm, [{ name: "默认", value: "glm-plain-secret" }]);
  assert.equal(internal.openai[0].api_key, "sk-supersecret-1234");
  assert.equal(internal.kimi, undefined);
});

test("credentials: 多 key —— 同服务商存两把，独立列出/删除", async () => {
  await put("/api/v1/credentials/deepseek", { name: "备用", payload: { api_key: "sk-backup-9999" } }, user);
  await put("/api/v1/credentials/deepseek", { name: "主账号", payload: { api_key: "sk-main-1111" } }, user);

  const list = await (await get("/api/v1/credentials", user)).json();
  const ds = list.rows.filter((r) => r.provider === "deepseek").map((r) => r.name).sort();
  assert.deepEqual(ds, ["主账号", "备用"]);

  const internal = await (
    await get("/api/v1/internal/credentials", { headers: { "X-Tokendash-Internal": KEY_B64 } })
  ).json();
  assert.equal(internal.deepseek.length, 2);
  assert.ok(internal.deepseek.every((k) => k.name && k.api_key));

  // 按 name 删一把，另一把保留
  await get("/api/v1/credentials/deepseek?name=备用", { method: "DELETE", headers: user.headers });
  const after = await (await get("/api/v1/credentials", user)).json();
  assert.deepEqual(after.rows.filter((r) => r.provider === "deepseek").map((r) => r.name), ["主账号"]);

  // quota 按 account 独立统计
  await post(
    "/api/v1/ingest/quota",
    { rows: [
      { provider: "deepseek", metric: "balance_cny", account: "主账号", value: 50 },
      { provider: "deepseek", metric: "balance_cny", account: "备用", value: 20 },
    ] },
    runner,
  );
  const cur = await (await get("/api/v1/quota/current", user)).json();
  const bals = cur.rows.filter((r) => r.provider === "deepseek" && r.metric === "balance_cny");
  assert.equal(bals.find((r) => r.account === "主账号")?.value, 50);
  // 「备用」的凭证已删，其快照不再出现在 current
  assert.equal(bals.find((r) => r.account === "备用"), undefined);
});

test("新增套餐服务商: minimax / zai 凭证与额度均可入库", async () => {
  await put("/api/v1/credentials/minimax", { payload: { api_key: "sk-cp-minimax" } }, user);
  await put("/api/v1/credentials/zai", { payload: { api_key: "zai-plan-key" } }, user);

  const internal = await (
    await get("/api/v1/internal/credentials", { headers: { "X-Tokendash-Internal": KEY_B64 } })
  ).json();
  assert.equal(internal.minimax[0].api_key, "sk-cp-minimax");
  assert.equal(internal.zai[0].api_key, "zai-plan-key");

  const result = await post(
    "/api/v1/ingest/quota",
    { rows: [
      { provider: "minimax", metric: "weekly_used_pct", account: "默认", value: 35, unit: "percent" },
      { provider: "zai", metric: "session_used_pct", account: "默认", value: 42, unit: "percent" },
    ] },
    runner,
  );
  assert.equal(result.status, 200);
  const current = await (await get("/api/v1/quota/current", user)).json();
  assert.equal(current.rows.find((r) => r.provider === "minimax").value, 35);
  assert.equal(current.rows.find((r) => r.provider === "zai").value, 42);

  await get("/api/v1/credentials/minimax", { method: "DELETE", headers: user.headers });
  await get("/api/v1/credentials/zai", { method: "DELETE", headers: user.headers });
});
