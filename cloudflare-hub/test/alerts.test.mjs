// alerts.evaluate 纯函数单测：node --test test/alerts.test.mjs
// 先用 esbuild 打包 src/alerts.ts（连带 ./push 依赖），再 import 其中的 evaluate。
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdirSync } from "node:fs";

let evaluate;

// 设置项是“剩余百分比”；10% 剩余对应 90% 已用。
const CFG = { enabled: true, lowThresholdPct: 10, resetSoonMinutes: 60 };
const NOW = Date.parse("2026-08-27T07:00:00Z");

function snap(value, extra = {}) {
  return { value, unit: "percent", reset_at: null, captured_at: "2026-08-27T07:00:00Z", ...extra };
}

function pair(p, extra = {}) {
  return { provider: "kimi", metric: "weekly_used_pct", account: "默认", prev: null, latest: snap(0), ...p, ...extra };
}

before(async () => {
  mkdirSync("dist", { recursive: true });
  await build({
    entryPoints: ["src/alerts.ts"],
    bundle: true,
    format: "esm",
    outfile: "dist/alerts-test.mjs",
    platform: "browser",
    logLevel: "silent",
  });
  ({ evaluate } = await import("../dist/alerts-test.mjs"));
});

test("quota_low：上穿阈值触发", () => {
  const evs = evaluate([pair({ prev: snap(80), latest: snap(92, { reset_at: "2026-08-30T00:00:00Z" }) })], CFG, NOW);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].kind, "quota_low");
  assert.equal(evs[0].dedupeKey, "low|kimi|weekly_used_pct|默认|2026-08-30T00:00:00Z");
  assert.equal(evs[0].title, "Kimi 额度快用完");
  assert.equal(evs[0].body, "weekly_used_pct 剩余约 8%（已用 92%）");
});

test("quota_low：未达阈值不触发；恰好等于阈值触发", () => {
  assert.equal(evaluate([pair({ prev: snap(80), latest: snap(89) })], CFG, NOW).length, 0);
  const evs = evaluate([pair({ prev: snap(89), latest: snap(90) })], CFG, NOW);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].kind, "quota_low");
});

test("quota_low：prev 已在阈值之上不重复触发（上升沿）", () => {
  assert.equal(evaluate([pair({ prev: snap(91), latest: snap(93) })], CFG, NOW).length, 0);
});

test("quota_low：无 prev（首轮采集）不触发；metric 名含 _pct 时无 unit 也按百分比", () => {
  assert.equal(evaluate([pair({ latest: snap(95) })], CFG, NOW).length, 0);
  const evs = evaluate(
    [pair({ prev: snap(80, { unit: null }), latest: snap(95, { unit: null }) })],
    CFG,
    NOW,
  );
  assert.equal(evs.length, 1);
  assert.equal(evs[0].kind, "quota_low");
  assert.equal(evs[0].dedupeKey, "low|kimi|weekly_used_pct|默认|nr"); // 无 reset_at 用 nr
});

test("reset_soon：窗口内触发，body 含剩余分钟数", () => {
  const reset = "2026-08-27T07:30:00Z"; // 30 分钟后
  const evs = evaluate([pair({ latest: snap(10, { reset_at: reset }) })], CFG, NOW);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].kind, "reset_soon");
  assert.equal(evs[0].dedupeKey, `soon|kimi|weekly_used_pct|默认|${reset}`);
  assert.equal(evs[0].title, "Kimi 额度即将刷新");
  assert.ok(evs[0].body.includes("30 分钟"));
});

test("reset_soon：超出窗口或已过期不触发", () => {
  const beyond = snap(10, { reset_at: "2026-08-27T08:00:01Z" }); // 60 分 1 秒后
  assert.equal(evaluate([pair({ latest: beyond })], CFG, NOW).length, 0);
  const past = snap(10, { reset_at: "2026-08-27T06:59:00Z" });
  assert.equal(evaluate([pair({ latest: past })], CFG, NOW).length, 0);
});

test("无 reset_at 的 provider 只可能触发 quota_low", () => {
  const evs = evaluate([pair({ prev: snap(80), latest: snap(95) })], CFG, NOW);
  assert.deepEqual(evs.map((e) => e.kind), ["quota_low"]);
});

test("reset_done：高用量骤降触发，dedupeKey 用 captured_at 小时桶", () => {
  const evs = evaluate(
    [pair({ prev: snap(85), latest: snap(50, { captured_at: "2026-08-27T07:12:33Z" }) })],
    CFG,
    NOW,
  );
  assert.equal(evs.length, 1);
  assert.equal(evs[0].kind, "reset_done");
  assert.equal(evs[0].dedupeKey, "done|kimi|weekly_used_pct|默认|2026-08-27T07");
});

test("reset_done：降幅不足或 prev 低于 80 不触发", () => {
  assert.equal(evaluate([pair({ prev: snap(85), latest: snap(60) })], CFG, NOW).length, 0); // 降 25 < 30
  assert.equal(evaluate([pair({ prev: snap(79), latest: snap(10) })], CFG, NOW).length, 0); // prev < 80
});

test("scrape_error / scrape_warn 一律跳过", () => {
  const pairs = ["scrape_error", "scrape_warn"].map((metric) =>
    pair({ metric, prev: snap(1, { unit: null }), latest: snap(1, { unit: null, reset_at: "2026-08-27T07:30:00Z" }) }),
  );
  assert.equal(evaluate(pairs, CFG, NOW).length, 0);
});

test("enabled=false 返回空数组", () => {
  const pairs = [
    pair({ prev: snap(80), latest: snap(95, { reset_at: "2026-08-27T07:30:00Z" }) }),
    pair({ provider: "claude", metric: "session_used_pct", prev: snap(85), latest: snap(50) }),
  ];
  assert.equal(evaluate(pairs, { ...CFG, enabled: false }, NOW).length, 0);
});

test("同一 pair 可同时产生多类事件（如 quota_low + reset_soon）", () => {
  const evs = evaluate(
    [pair({ prev: snap(80), latest: snap(92, { reset_at: "2026-08-27T07:30:00Z" }) })],
    CFG,
    NOW,
  );
  assert.deepEqual(evs.map((e) => e.kind).sort(), ["quota_low", "reset_soon"]);
});
