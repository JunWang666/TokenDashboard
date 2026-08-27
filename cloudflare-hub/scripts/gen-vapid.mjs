// 生成 VAPID 密钥对（web push 用）。用法：
//   node scripts/gen-vapid.mjs
// 输出 VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY（base64url），私钥按提示写入 Worker secret。

import { webcrypto } from "node:crypto";

const { subtle } = webcrypto;
const kp = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const pub = new Uint8Array(await subtle.exportKey("raw", kp.publicKey)); // 65B 未压缩点
const jwk = await subtle.exportKey("jwk", kp.privateKey);

const publicKey = Buffer.from(pub).toString("base64url");
const privateKey = jwk.d; // hub 端用公钥补 x/y，私钥只需存 d

console.log("VAPID_PUBLIC_KEY=" + publicKey);
console.log("VAPID_PRIVATE_KEY=" + privateKey);
console.log("");
console.log("公钥写入 .dev.vars / wrangler vars，私钥用 secret 保存：");
console.log("  npx wrangler secret put VAPID_PRIVATE_KEY --config ../wrangler.jsonc");
console.log("可选：VAPID_SUBJECT=mailto:you@example.com（推送服务的联系方式）");
