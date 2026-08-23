// runner 适配器单元测试：node --test test/
// 直接调用适配器 fetch，用假 fetch 模拟各服务商响应，验证解析逻辑与容错。
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdirSync } from "node:fs";

let kimi;
let codex;
let cursor;
let runAdapter;

before(async () => {
  mkdirSync("dist", { recursive: true });
  await build({
    entryPoints: ["src/runner/adapters.ts"],
    bundle: true,
    format: "esm",
    outfile: "dist/adapters.mjs",
    platform: "browser",
    logLevel: "silent",
  });
  ({ kimi, codex, cursor } = await import("../dist/adapters.mjs").then((m) => m.adapters));
  ({ runAdapter } = await import("../dist/adapters.mjs"));
});

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

test("kimi: 周额度 + 5 小时窗口解析", async () => {
  const f = async (url, init) => {
    assert.equal(url, "https://api.kimi.com/coding/v1/usages");
    assert.equal(init.headers.Authorization, "Bearer sk-kimi-test");
    return json({
      usage: { limit: "100", remaining: "40", resetTime: "2026-08-29T00:00:00Z" },
      limits: [
        {
          window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
          detail: { limit: "100", used: "25", remaining: "75", resetTime: "2026-08-23T20:00:00Z" },
        },
      ],
    });
  };
  const rows = await kimi.fetch({ api_key: "sk-kimi-test" }, f);
  const weekly = rows.find((r) => r.metric === "weekly_used_pct");
  assert.equal(weekly.value, 60);
  assert.equal(weekly.reset_at, "2026-08-29T00:00:00Z");
  const session = rows.find((r) => r.metric === "session_used_pct");
  assert.equal(session.value, 25);
  assert.equal(session.reset_at, "2026-08-23T20:00:00Z");
});

test("kimi: 配了 web_token 时追加月额度（DOMAIN_CODE 无余额退 DOMAIN_KIMI）", async () => {
  const domains = [];
  const f = async (url, init) => {
    if (url.endsWith("/usages")) return json({ usage: { limit: "100", remaining: "80" } });
    assert.ok(url.endsWith("MembershipService/GetSubscriptionStats"));
    assert.equal(init.headers["Connect-Protocol-Version"], "1");
    const domain = JSON.parse(init.body).domain;
    domains.push(domain);
    if (domain === "DOMAIN_CODE") return json({});
    return json({
      // 实测响应是 camelCase，且无 amount/amountLeft 绝对值
      subscriptionBalance: { amountUsedRatio: 0.25, expireTime: "2026-09-01T00:00:00Z" },
    });
  };
  const rows = await kimi.fetch({ api_key: "sk-kimi-test", web_token: "web-tok", stats_base_url: "https://stats.example" }, f);
  const monthly = rows.find((r) => r.metric === "monthly_used_pct");
  assert.equal(monthly.value, 25);
  assert.equal(monthly.reset_at, "2026-09-01T00:00:00Z");
  assert.equal(rows.find((r) => r.metric === "monthly_remaining"), undefined);
  assert.deepEqual(domains, ["DOMAIN_CODE", "DOMAIN_KIMI"]);
});

test("kimi: 月额度失败降级为 scrape_warn，不拖垮整卡", async () => {
  const f = async (url) => {
    if (url.endsWith("/usages")) return json({ usage: { limit: "100", remaining: "80" } });
    return json({}, 401); // web_token 过期
  };
  const rows = await runAdapter(
    "kimi",
    { api_key: "sk-kimi-test", web_token: "expired", stats_base_url: "https://stats.example" },
    f,
  );
  // 不应出现 scrape_error（整卡失败），周额度行保留 + scrape_warn 行
  assert.equal(rows.find((r) => r.metric === "scrape_error"), undefined);
  assert.equal(rows.find((r) => r.metric === "weekly_used_pct").value, 20);
  const warn = rows.find((r) => r.metric === "scrape_warn");
  assert.ok(warn, "应有 scrape_warn 行");
  assert.ok(String(warn.reset_at).includes("月额度采集失败"));
  assert.ok(String(warn.reset_at).includes("HTTP 401"));
});

test("kimi: 数值为数字形态 + 窗口只有 remaining 无 used", async () => {
  const f = async () =>
    json({
      usage: { limit: 200, remaining: 150, resetTime: "2026-08-30T00:00:00Z" },
      limits: [
        {
          window: { duration: 5, timeUnit: "TIME_UNIT_HOUR" },
          detail: { limit: 100, remaining: 90, resetTime: "2026-08-23T18:00:00Z" },
        },
      ],
    });
  const rows = await kimi.fetch({ api_key: "sk-kimi-test" }, f);
  assert.equal(rows.find((r) => r.metric === "weekly_used_pct").value, 25);
  assert.equal(rows.find((r) => r.metric === "session_used_pct").value, 10);
});

test("kimi: HTTP 错误抛出（由 runAdapter 转 scrape_error）", async () => {
  const rows = await runAdapter("kimi", { api_key: "bad" }, async () => json({}, 401));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].metric, "scrape_error");
  assert.ok(String(rows[0].reset_at).includes("HTTP 401"));
});

test("kimi/codex: cred.base_url 覆盖默认地址（自建转发绕 WAF）", async () => {
  const seen = [];
  const f = async (url) => {
    seen.push(url);
    if (url.includes("/usages")) return json({ usage: { limit: "100", remaining: "50" } });
    return json({ rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 } } });
  };
  await kimi.fetch({ api_key: "k", base_url: "https://relay.example.com/kimi/" }, f);
  await codex.fetch({ access_token: "t", base_url: "https://relay.example.com/backend-api" }, f);
  assert.equal(seen[0], "https://relay.example.com/kimi/usages"); // 末尾斜杠归一化
  assert.equal(seen[1], "https://relay.example.com/backend-api/wham/usage");
});

test("codex: 按 limit_window_seconds 识别 5 小时 / 周窗口", async () => {
  const f = async (url, init) => {
    assert.equal(url, "https://chatgpt.com/backend-api/wham/usage");
    assert.equal(init.headers.Authorization, "Bearer tok-test");
    assert.equal(init.headers["ChatGPT-Account-Id"], "acc-1");
    // 实测默认 UA 会被对端拦 403 HTML 页，必须带 codex CLI 风格 UA
    assert.match(init.headers["User-Agent"], /^codex_cli_rs\//);
    return json({
      plan_type: "plus",
      rate_limit: {
        primary_window: { used_percent: 42, limit_window_seconds: 18000, reset_at: 1786536977 },
        secondary_window: { used_percent: 7, limit_window_seconds: 604800, reset_at: 1787049600 },
      },
      credits: { has_credits: true, balance: "12.5" },
    });
  };
  const rows = await codex.fetch({ access_token: "tok-test", account_id: "acc-1" }, f);
  const session = rows.find((r) => r.metric === "session_used_pct");
  assert.equal(session.value, 42);
  assert.equal(session.reset_at, new Date(1786536977 * 1000).toISOString());
  assert.equal(rows.find((r) => r.metric === "weekly_used_pct").value, 7);
  assert.equal(rows.find((r) => r.metric === "credits_usd").value, 12.5);
});

test("codex: 周限额在 primary_window（pro 档）也能正确归类", async () => {
  const f = async () =>
    json({
      plan_type: "prolite",
      rate_limit: {
        primary_window: { used_percent: 81, limit_window_seconds: 604800, reset_at: 1786536977 },
        secondary_window: null,
      },
      credits: { has_credits: false, balance: "0" },
    });
  const rows = await codex.fetch({ access_token: "tok-test" }, f);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].metric, "weekly_used_pct");
  assert.equal(rows[0].value, 81);
});

test("codex: 401 提示 token 过期；缺凭证直接报错", async () => {
  const rows = await runAdapter("codex", { access_token: "expired" }, async () => json({}, 401));
  assert.equal(rows[0].metric, "scrape_error");
  assert.ok(String(rows[0].reset_at).includes("过期"));
  const noCred = await runAdapter("codex", {}, async () => json({}));
  assert.ok(String(noCred[0].reset_at).includes("access_token"));
});

test("cursor: 分项池 auto/api + 总占比解析", async () => {
  const f = async (url, init) => {
    assert.equal(url, "https://cursor.com/api/usage-summary");
    assert.equal(init.headers.Cookie, "WorkosCursorSessionToken=tok-test");
    return json({
      billingCycleEnd: "2026-09-01T00:00:00.000Z",
      individualUsage: {
        plan: { used: 1500, limit: 2000, remaining: 500, autoPercentUsed: 75, apiPercentUsed: 71.4, totalPercentUsed: 74 },
      },
    });
  };
  const rows = await cursor.fetch({ session: "WorkosCursorSessionToken=tok-test" }, f);
  const auto = rows.find((r) => r.metric === "auto_used_pct");
  assert.equal(auto.value, 75);
  assert.equal(auto.unit, "percent");
  assert.equal(auto.limit_value, 100);
  assert.equal(auto.reset_at, "2026-09-01");
  assert.equal(rows.find((r) => r.metric === "api_used_pct").value, 71.4);
  assert.equal(rows.find((r) => r.metric === "plan_used_pct").value, 74);
  assert.equal(rows.find((r) => r.metric === "requests_used").unit, "usd_cents");
});

test("cursor: 无分项字段时仍出总占比；缺 plan 抛错", async () => {
  const rows = await cursor.fetch({ session: "s" }, async () =>
    json({ individualUsage: { plan: { used: 100, limit: 2000, remaining: 1900, totalPercentUsed: 5 } } }),
  );
  assert.equal(rows.find((r) => r.metric === "auto_used_pct"), undefined);
  assert.equal(rows.find((r) => r.metric === "plan_used_pct").value, 5);
  const err = await runAdapter("cursor", { session: "s" }, async () => json({}));
  assert.equal(err[0].metric, "scrape_error");
});
