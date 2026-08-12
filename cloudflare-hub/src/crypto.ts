import type { Context } from "hono";
import type { Env } from "./index";
import { PROVIDER_SET } from "./ingest";

/** base64 ↔ Uint8Array（Workers 环境无 Buffer） */
function toB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function fromB64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function getKey(keyB64: string): Promise<CryptoKey> {
  const raw = fromB64(keyB64);
  if (raw.length !== 32) throw new Error("CREDENTIALS_KEY must be 32 bytes base64 encoded");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** 返回 base64: nonce(12B) ‖ ciphertext ‖ tag(16B) */
export async function encryptCredential(keyB64: string, plaintext: string): Promise<string> {
  const key = await getKey(keyB64);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, new TextEncoder().encode(plaintext));
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(nonce, 0);
  out.set(new Uint8Array(ct), 12);
  return toB64(out);
}

export async function decryptCredential(keyB64: string, payloadB64: string): Promise<string> {
  const key = await getKey(keyB64);
  const data = fromB64(payloadB64);
  if (data.length <= 12) throw new Error("bad encrypted payload");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: data.slice(0, 12) }, key, data.slice(12));
  return new TextDecoder().decode(pt);
}

/** 从凭证 payload 里提取用于 hint 的明文片段（最长字符串值的末 4 位） */
export function credentialHint(payload: unknown): string {
  const secret = extractSecret(payload) ?? JSON.stringify(payload);
  return "..." + secret.slice(-4);
}

function extractSecret(payload: unknown): string | null {
  if (typeof payload === "string") return payload;
  if (payload && typeof payload === "object") {
    const vals = Object.values(payload as Record<string, unknown>)
      .filter((v): v is string => typeof v === "string")
      .sort((a, b) => b.length - a.length);
    return vals[0] ?? null;
  }
  return null;
}
