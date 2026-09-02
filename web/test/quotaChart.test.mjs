import assert from "node:assert/strict";
import test from "node:test";
import {
  QUOTA_MAX_CONTINUOUS_GAP_MS,
  buildQuotaChartData,
} from "../src/quotaChart.ts";

const at = (minutes) => Date.UTC(2026, 7, 28, 0, minutes);
const point = (minutes, metric = "weekly_used_pct", value = minutes) => ({
  capturedAt: at(minutes),
  metric,
  value,
});

test("连续采集保持一条折线", () => {
  const data = buildQuotaChartData([point(0), point(15), point(30)]);

  assert.deepEqual(data.map((row) => row.t), [at(0), at(15), at(30)]);
  assert.equal(data.some((row) => row.weekly_used_pct === null), false);
});

test("超过两个采集周期时插入全 null 断点", () => {
  const data = buildQuotaChartData([
    point(0, "weekly_used_pct", 10),
    point(0, "session_used_pct", 20),
    point(180, "weekly_used_pct", 30),
    point(180, "session_used_pct", 40),
  ]);

  assert.equal(data.length, 3);
  assert.equal(data[1].t, at(90));
  assert.equal(data[1].weekly_used_pct, null);
  assert.equal(data[1].session_used_pct, null);
});

test("允许恰好 30 分钟的间隔，超过阈值才断开", () => {
  const continuous = buildQuotaChartData([point(0), point(30)]);
  const withSubMinuteJitter = buildQuotaChartData([
    point(0),
    { ...point(30), capturedAt: at(30) + 20_000 },
  ], QUOTA_MAX_CONTINUOUS_GAP_MS);

  assert.equal(continuous.length, 2);
  // 数据按分钟合并，秒级抖动不会被误判成断档。
  assert.equal(withSubMinuteJitter.length, 2);
  assert.equal(buildQuotaChartData([point(0), point(45)]).length, 3);
});

test("无效时间会被忽略，相同分钟的多指标会合并", () => {
  const data = buildQuotaChartData([
    point(0, "weekly_used_pct", 10),
    { capturedAt: at(0) + 20_000, metric: "session_used_pct", value: 25 },
    { capturedAt: Number.NaN, metric: "weekly_used_pct", value: 99 },
  ]);

  assert.deepEqual(data, [{ t: at(0), weekly_used_pct: 10, session_used_pct: 25 }]);
});
