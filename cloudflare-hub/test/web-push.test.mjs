import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

async function loadModule(entryPoint = "src/webPush.ts") {
  const result = await build({
    entryPoints: [entryPoint],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    logLevel: "silent",
  });
  const source = result.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

test("APNs host follows each subscription environment", async () => {
  const { apnsHostForEnvironment } = await loadModule("src/push.ts");
  assert.equal(apnsHostForEnvironment("sandbox", false), "https://api.sandbox.push.apple.com");
  assert.equal(apnsHostForEnvironment("production", true), "https://api.push.apple.com");
  assert.equal(apnsHostForEnvironment("", true), "https://api.sandbox.push.apple.com");
  assert.equal(apnsHostForEnvironment("", false), "https://api.push.apple.com");
});

function concat(...parts) {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

async function hkdf(secret, salt, info, byteLength) {
  const key = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    key,
    byteLength * 8,
  ));
}

test("Web Push uses aes128gcm and the subscriber can decrypt its RFC 8291 record", async () => {
  const { base64UrlDecode, base64UrlEncode, buildWebPushRequest } = await loadModule();
  const encoder = new TextEncoder();

  const subscriberKeys = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const subscriberPublic = new Uint8Array(await crypto.subtle.exportKey("raw", subscriberKeys.publicKey));
  const authSecret = crypto.getRandomValues(new Uint8Array(16));

  const vapidKeys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const vapidPublic = new Uint8Array(await crypto.subtle.exportKey("raw", vapidKeys.publicKey));
  const vapidPrivate = await crypto.subtle.exportKey("jwk", vapidKeys.privateKey);
  const endpoint = "https://push.example.test/send/abc";
  const payload = JSON.stringify({ title: "测试", body: "aes128gcm works" });
  const now = Date.UTC(2026, 7, 28, 12, 0, 0);

  const request = await buildWebPushRequest(
    {
      endpoint,
      keys: {
        p256dh: base64UrlEncode(subscriberPublic),
        auth: base64UrlEncode(authSecret),
      },
    },
    payload,
    {
      publicKey: base64UrlEncode(vapidPublic),
      privateKey: vapidPrivate.d,
      subject: "mailto:push@example.test",
    },
    { now },
  );

  assert.equal(request.headers.get("Content-Encoding"), "aes128gcm");
  assert.equal(request.headers.get("Encryption"), null);
  assert.equal(request.headers.get("Crypto-Key"), null);
  assert.match(request.headers.get("Authorization"), /^vapid t=[^,]+, k=/);

  const body = new Uint8Array(request.body);
  const salt = body.slice(0, 16);
  assert.equal(new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0, false), 4096);
  const keyLength = body[20];
  assert.equal(keyLength, 65);
  const serverPublic = body.slice(21, 21 + keyLength);
  const ciphertext = body.slice(21 + keyLength);

  const serverKey = await crypto.subtle.importKey(
    "raw",
    serverPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: serverKey },
    subscriberKeys.privateKey,
    256,
  ));
  const keyInfo = concat(
    encoder.encode("WebPush: info"),
    new Uint8Array([0]),
    subscriberPublic,
    serverPublic,
  );
  const inputKeyMaterial = await hkdf(sharedSecret, authSecret, keyInfo, 32);
  const contentEncryptionKey = await hkdf(
    inputKeyMaterial,
    salt,
    concat(encoder.encode("Content-Encoding: aes128gcm"), new Uint8Array([0])),
    16,
  );
  const nonce = await hkdf(
    inputKeyMaterial,
    salt,
    concat(encoder.encode("Content-Encoding: nonce"), new Uint8Array([0])),
    12,
  );
  const aesKey = await crypto.subtle.importKey("raw", contentEncryptionKey, "AES-GCM", false, ["decrypt"]);
  const plaintext = new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce, tagLength: 128 },
    aesKey,
    ciphertext,
  ));
  assert.equal(plaintext.at(-1), 0x02);
  assert.equal(new TextDecoder().decode(plaintext.slice(0, -1)), payload);

  const authorization = request.headers.get("Authorization");
  const token = authorization.match(/^vapid t=([^,]+)/)[1];
  const claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(token.split(".")[1])));
  assert.equal(claims.aud, "https://push.example.test");
  assert.equal(claims.sub, "mailto:push@example.test");
  assert.equal(claims.exp, Math.floor(now / 1000) + 12 * 60 * 60);
});
