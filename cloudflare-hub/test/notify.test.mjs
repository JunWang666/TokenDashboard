// notify 渠道发送单测：node --test test/notify.test.mjs
// esbuild 打包 src/notify.ts（连带 ./crypto），用 stub fetch 验证飞书/Bark 的请求构造与错误处理。
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { build } from "esbuild";
import { mkdirSync } from "node:fs";

let feishuSign, sendFeishu, sendBark;

const EV = {
  dedupeKey: "low|kimi|weekly_used_pct|默认|nr",
  kind: "quota_low",
  provider: "kimi",
  metric: "weekly_used_pct",
  account: "默认",
  title: "Kimi 额度快用完",
  body: "weekly_used_pct 已用 92%",
};

/** 捕获请求的 stub fetch，返回指定响应 */
function stubFetch(response, captured = {}) {
  return async (url, init) => {
    captured.url = url;
    captured.init = init;
    captured.body = JSON.parse(init.body);
    return { ok: response.ok ?? true, status: response.status ?? 200, json: async () => response.json };
  };
}

before(async () => {
  mkdirSync("dist", { recursive: true });
  await build({
    entryPoints: ["src/notify.ts"],
    bundle: true,
    format: "esm",
    outfile: "dist/notify-test.mjs",
    platform: "browser",
    logLevel: "silent",
  });
  ({ feishuSign, sendFeishu, sendBark } = await import("../dist/notify-test.mjs"));
});

test("feishuSign 与 node:crypto HMAC 一致", async () => {
  const ts = "1725000000";
  const secret = "test-secret";
  const expected = createHmac("sha256", `${ts}\n${secret}`).update("").digest("base64");
  assert.equal(await feishuSign(secret, ts), expected);
});

test("sendFeishu：无签名时只发 text 消息", async () => {
  const c = {};
  await sendFeishu({ url: "https://open.feishu.cn/bot/xxx", secret: null }, EV, stubFetch({ json: { code: 0 } }, c));
  assert.equal(c.body.msg_type, "text");
  assert.equal(c.body.content.text, "Kimi 额度快用完\nweekly_used_pct 已用 92%");
  assert.equal(c.body.sign, undefined);
  assert.equal(c.body.timestamp, undefined);
});

test("sendFeishu：有 secret 时带 timestamp+sign", async () => {
  const c = {};
  const secret = "abc123";
  await sendFeishu({ url: "https://open.feishu.cn/bot/xxx", secret }, EV, stubFetch({ json: { code: 0 } }, c));
  assert.ok(c.body.timestamp);
  const expected = createHmac("sha256", `${c.body.timestamp}\n${secret}`).update("").digest("base64");
  assert.equal(c.body.sign, expected);
});

test("sendFeishu：code 非 0 抛错", async () => {
  await assert.rejects(
    () => sendFeishu({ url: "https://open.feishu.cn/bot/xxx", secret: null }, EV, stubFetch({ json: { code: 19021, msg: "sign match fail" } })),
    /feishu webhook/,
  );
});

test("sendBark：URL 拼接与 payload", async () => {
  const c = {};
  await sendBark({ server: "https://api.day.app/", key: "devkey" }, EV, stubFetch({ json: { code: 200 } }, c));
  assert.equal(c.url, "https://api.day.app/devkey"); // 末尾斜杠归一化
  assert.equal(c.body.title, EV.title);
  assert.equal(c.body.body, EV.body);
  assert.equal(c.body.group, "TokenDashboard");
});

test("sendBark：code 非 200 抛错", async () => {
  await assert.rejects(
    () => sendBark({ server: "https://api.day.app", key: "bad" }, EV, stubFetch({ json: { code: 400, message: "bad key" } })),
    /bark/,
  );
});
