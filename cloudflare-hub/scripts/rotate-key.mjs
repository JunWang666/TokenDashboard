// 一次性凭证密钥轮换脚本：用旧密钥解密 D1 中全部凭证，再用新密钥重加密写回。
//
// 用法：
//   export CF_API_TOKEN=...   # 需要 D1 执行权限
//   export OLD_KEY=<base64 32B>
//   export NEW_KEY=<base64 32B>
//   node scripts/rotate-key.mjs --remote   # 或去掉 --remote 表示本地
//
// 步骤：wrangler d1 execute 导出 → 本地解密/重加密 → 生成 UPDATE 语句 → 执行。
// 注意：期间 hub 若被调用 decrypt 会失败（旧行未重写前短暂不一致），个人规模可忽略。

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";

const REMOTE = process.argv.includes("--remote") ? "--remote" : "";
const DB_NAME = "tokendash";
const OLD_KEY = Buffer.from(process.env.OLD_KEY ?? "", "base64");
const NEW_KEY = Buffer.from(process.env.NEW_KEY ?? "", "base64");
if (OLD_KEY.length !== 32 || NEW_KEY.length !== 32) {
  console.error("OLD_KEY / NEW_KEY must be 32-byte base64");
  process.exit(1);
}

function run(args) {
  const r = spawnSync("wrangler", ["d1", ...args], { encoding: "utf8" });
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout);
    process.exit(1);
  }
  return r.stdout;
}

const out = run([
  "execute",
  DB_NAME,
  ...(REMOTE ? ["--remote"] : []),
  "--command",
  "SELECT provider, payload_enc FROM credentials",
  "--json",
]);
const rows = JSON.parse(out);

if (rows.length === 0) {
  console.log("no credentials to rotate");
  process.exit(0);
}

const updates = [];
for (const r of rows) {
  const enc = Buffer.from(r.payload_enc, "base64");
  const nonce = enc.subarray(0, 12);
  const tag = enc.subarray(enc.length - 16);
  const ct = enc.subarray(12, enc.length - 16);
  const plain = crypto.createDecipheriv("aes-256-gcm", OLD_KEY, nonce);
  plain.setAuthTag(tag);
  const dec = Buffer.concat([plain.update(ct), plain.final()]).toString("utf8");

  const nonce2 = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", NEW_KEY, nonce2);
  const ct2 = Buffer.concat([cipher.update(dec, "utf8"), cipher.final()]);
  const payload = Buffer.concat([nonce2, ct2, cipher.getAuthTag()]).toString("base64");
  updates.push(
    `UPDATE credentials SET payload_enc = '${payload}' WHERE provider = '${r.provider}';`,
  );
}

fs.writeFileSync("/tmp/tokendash-rotate.sql", updates.join("\n"));
run([
  "execute",
  DB_NAME,
  ...(REMOTE ? ["--remote"] : []),
  "--file",
  "/tmp/tokendash-rotate.sql",
]);
console.log(`rotated ${updates.length} credential(s). Now update CREDENTIALS_KEY secret to NEW_KEY.`);
