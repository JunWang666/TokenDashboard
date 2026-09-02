/** RFC 8291 Web Push encryption and RFC 8292 VAPID authentication. */

export interface WebPushSubscription {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface VapidConfiguration {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export interface WebPushRequest {
  endpoint: string;
  headers: Headers;
  body: ArrayBuffer;
}

const encoder = new TextEncoder();
const RECORD_SIZE = 4096;

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  const binary = atob(normalized + padding);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

async function hkdf(
  secret: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  byteLength: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", asArrayBuffer(secret), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: asArrayBuffer(salt),
      info: asArrayBuffer(info),
    },
    key,
    byteLength * 8,
  );
  return new Uint8Array(bits);
}

function validatePublicKey(key: Uint8Array, label: string): void {
  if (key.byteLength !== 65 || key[0] !== 0x04) {
    throw new Error(`${label} 必须是 65 字节的 P-256 未压缩公钥`);
  }
}

function vapidPrivateJwk(vapid: VapidConfiguration): JsonWebKey {
  const publicKey = base64UrlDecode(vapid.publicKey);
  validatePublicKey(publicKey, "VAPID_PUBLIC_KEY");
  return {
    kty: "EC",
    crv: "P-256",
    x: base64UrlEncode(publicKey.slice(1, 33)),
    y: base64UrlEncode(publicKey.slice(33, 65)),
    d: vapid.privateKey,
    ext: true,
    key_ops: ["sign"],
  };
}

async function createVapidJwt(endpoint: string, vapid: VapidConfiguration, now: number): Promise<string> {
  const audience = new URL(endpoint).origin;
  const key = await crypto.subtle.importKey(
    "jwk",
    vapidPrivateJwk(vapid),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const header = base64UrlEncode(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = base64UrlEncode(
    encoder.encode(
      JSON.stringify({
        aud: audience,
        exp: Math.floor(now / 1000) + 12 * 60 * 60,
        sub: vapid.subject,
      }),
    ),
  );
  const unsigned = `${header}.${claims}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    asArrayBuffer(encoder.encode(unsigned)),
  );
  return `${unsigned}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** Build a standards-compliant `aes128gcm` request body for a push service. */
export async function buildWebPushRequest(
  subscription: WebPushSubscription,
  payload: string,
  vapid: VapidConfiguration,
  options: { ttl?: number; now?: number } = {},
): Promise<WebPushRequest> {
  const endpoint = new URL(subscription.endpoint);
  if (endpoint.protocol !== "https:") throw new Error("Web Push endpoint 必须使用 HTTPS");

  const userPublicKey = base64UrlDecode(subscription.keys.p256dh);
  const authSecret = base64UrlDecode(subscription.keys.auth);
  validatePublicKey(userPublicKey, "p256dh");
  if (authSecret.byteLength !== 16) throw new Error("auth secret 必须是 16 字节");

  const applicationServerKeys = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  )) as CryptoKeyPair;
  const applicationServerPublicKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", applicationServerKeys.publicKey),
  );
  validatePublicKey(applicationServerPublicKey, "临时服务端公钥");

  const userKey = await crypto.subtle.importKey(
    "raw",
    asArrayBuffer(userPublicKey),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: userKey },
      applicationServerKeys.privateKey,
      256,
    ),
  );

  const keyInfo = concat(
    encoder.encode("WebPush: info"),
    new Uint8Array([0]),
    userPublicKey,
    applicationServerPublicKey,
  );
  const inputKeyMaterial = await hkdf(sharedSecret, authSecret, keyInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
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

  // A final-record delimiter (0x02) is part of the encrypted plaintext in RFC 8188.
  const plaintext = concat(encoder.encode(payload), new Uint8Array([0x02]));
  if (plaintext.byteLength + 16 > RECORD_SIZE) throw new Error("Web Push payload 超过单条记录上限");
  const aesKey = await crypto.subtle.importKey(
    "raw",
    asArrayBuffer(contentEncryptionKey),
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: asArrayBuffer(nonce), tagLength: 128 },
      aesKey,
      asArrayBuffer(plaintext),
    ),
  );

  // aes128gcm body header: salt || rs || keyid length || ephemeral ECDH public key.
  const header = new Uint8Array(16 + 4 + 1 + applicationServerPublicKey.byteLength);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE, false);
  header[20] = applicationServerPublicKey.byteLength;
  header.set(applicationServerPublicKey, 21);

  const jwt = await createVapidJwt(subscription.endpoint, vapid, options.now ?? Date.now());
  return {
    endpoint: subscription.endpoint,
    headers: new Headers({
      Authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(options.ttl ?? 3600),
      Urgency: "normal",
    }),
    body: asArrayBuffer(concat(header, ciphertext)),
  };
}
