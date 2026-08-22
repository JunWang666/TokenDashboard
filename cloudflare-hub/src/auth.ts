import { createMiddleware } from "hono/factory";
import type { Context, Next } from "hono";
import type { Env } from "./index";

export type Role = "user" | "client" | "runner";

export interface Principal {
  role: Role;
  /** "user"（邮箱 JWT）或 "service"（service token） */
  type: "user" | "service";
  /** 展示名：邮箱或 service token 名 */
  name: string;
  exp: number;
}

interface AccessClaims {
  aud: string | string[];
  email?: string;
  common_name?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  sub?: string;
}

interface AccessKey extends JsonWebKey {
  kid?: string;
}

const CERTS_TTL_MS = 6 * 60 * 60 * 1000;
let certsCache: { team: string; keys: AccessKey[]; fetchedAt: number } | null = null;

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function fetchCerts(team: string): Promise<AccessKey[]> {
  if (certsCache && certsCache.team === team && Date.now() - certsCache.fetchedAt < CERTS_TTL_MS) {
    return certsCache.keys;
  }
  const res = await fetch(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`access certs fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys?: AccessKey[] };
  certsCache = { team, keys: body.keys ?? [], fetchedAt: Date.now() };
  return certsCache.keys;
}

/** 校验 Access JWT 签名与 aud，返回 claims；失败返回 null */
export async function verifyAccessJwt(jwt: string, env: Env): Promise<AccessClaims | null> {
  if (!env.ACCESS_TEAM || !env.ACCESS_AUD) return null;
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  let header: { alg?: string; kid?: string };
  let claims: AccessClaims;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlDecode(h)));
    claims = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
  } catch {
    return null;
  }
  if (!header.alg || !header.kid) return null;

  const now = Date.now() / 1000;
  if (claims.exp && now > claims.exp) return null;
  if (claims.nbf && now < claims.nbf) return null;
  const aud = claims.aud;
  const audOk = Array.isArray(aud) ? aud.includes(env.ACCESS_AUD) : aud === env.ACCESS_AUD;
  if (!audOk) return null;

  const keys = await fetchCerts(env.ACCESS_TEAM);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;

  const signed = new TextEncoder().encode(`${h}.${p}`);
  const sig = b64urlDecode(s);

  let valid = false;
  try {
    if (header.alg.startsWith("RS")) {
      const key = await crypto.subtle.importKey(
        "jwk",
        jwk,
        { name: "RSASSA-PKCS1-v1_5", hash: `SHA-${header.alg.slice(2)}` },
        false,
        ["verify"],
      );
      valid = await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, sig, signed);
    } else if (header.alg === "ES256") {
      const key = await crypto.subtle.importKey(
        "jwk",
        jwk,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
      valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, signed);
    }
  } catch {
    return null;
  }
  return valid ? claims : null;
}

function claimsToPrincipal(claims: AccessClaims, env: Env): Principal | null {
  if (claims.email) {
    return { role: "user", type: "user", name: claims.email, exp: claims.exp ?? 0 };
  }
  const cn = claims.common_name;
  if (!cn) return null;
  const runnerNames = (env.RUNNER_SERVICE_TOKENS ?? "tokendash-runner")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (runnerNames.includes(cn)) return { role: "runner", type: "service", name: cn, exp: claims.exp ?? 0 };
  if (cn === "tokendash-headless" || cn.startsWith("headless")) {
    return { role: "client", type: "service", name: cn, exp: claims.exp ?? 0 };
  }
  return null; // 未知 service token，拒绝
}

/** 本地开发令牌：Bearer <DEV_TOKEN> → user；<DEV_TOKEN>:runner / :client → 对应角色 */
function devPrincipal(authHeader: string, env: Env): Principal | null {
  if (!env.DEV_TOKEN) return null;
  const m = /^Bearer (.+)$/.exec(authHeader);
  if (!m) return null;
  const tok = m[1];
  if (tok === env.DEV_TOKEN) return { role: "user", type: "user", name: "dev", exp: Number.MAX_SAFE_INTEGER };
  if (tok === `${env.DEV_TOKEN}:runner`) {
    return { role: "runner", type: "service", name: "dev-runner", exp: Number.MAX_SAFE_INTEGER };
  }
  if (tok === `${env.DEV_TOKEN}:client`) {
    return { role: "client", type: "service", name: "dev-client", exp: Number.MAX_SAFE_INTEGER };
  }
  return null;
}

declare module "hono" {
  interface ContextVariableMap {
    principal: Principal;
  }
}

/** 合并部署时 runner 进程内直调的内部凭证（与加密密钥同源，泄漏即同等后果） */
function internalPrincipal(c: Context<{ Bindings: Env }>, env: Env): Principal | null {
  const key = env.CREDENTIALS_KEY;
  if (!key) return null;
  if (c.req.header("X-Tokendash-Internal") !== key) return null;
  return { role: "runner", type: "service", name: "internal-runner", exp: Number.MAX_SAFE_INTEGER };
}

/** 全部 /api/v1 接口先过：Access JWT 校验（纵深防御），失败回退到内部凭证 / dev token */
export const authMiddleware = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const env = c.env;
  const jwt = c.req.header("Cf-Access-Jwt-Assertion");
  let p: Principal | null = null;
  try {
    if (jwt) {
      const claims = await verifyAccessJwt(jwt, env);
      if (claims) p = claimsToPrincipal(claims, env);
    }
  } catch (e) {
    console.error("jwt verify failed:", e);
  }
  if (!p) p = internalPrincipal(c, env);
  if (!p) p = devPrincipal(c.req.header("Authorization") ?? "", env);
  if (!p) return c.json({ error: "unauthorized" }, 401);
  c.set("principal", p);
  await next();
});

/** 路由级角色授权 */
export const requireRole =
  (...roles: Role[]) =>
  async (c: Context<{ Bindings: Env }>, next: Next) => {
    const p = c.get("principal");
    if (!p || !roles.includes(p.role)) return c.json({ error: "forbidden", required: roles }, 403);
    await next();
  };
