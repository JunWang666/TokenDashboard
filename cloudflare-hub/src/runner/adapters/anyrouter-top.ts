import type { QuotaAdapter, QuotaRow } from "../types";

interface AnyRouterTopUser {
  quota?: unknown;
  used_quota?: unknown;
}

interface AnyRouterTopResponse {
  success?: unknown;
  message?: unknown;
  data?: unknown;
}

const QUOTA_UNITS_PER_USD = 500_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function secureBaseURL(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("anyrouter.top: base_url must be a valid HTTPS URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("anyrouter.top: base_url must be HTTPS without credentials, query, or fragment");
  }
  return raw.replace(/\/+$/, "");
}

function firstNonEmpty(cred: Record<string, string>, names: string[]): unknown {
  for (const name of names) {
    const value: unknown = cred[name];
    if (typeof value === "string" && value.trim()) return value;
    if (value != null && typeof value !== "string") return value;
  }
  return null;
}

/** Accept a session value, a full Cookie header, or { session: "..." }. */
function cookieHeader(cred: Record<string, string>): string | null {
  const raw: unknown = firstNonEmpty(cred, ["cookie", "cookies", "session"]);
  if (typeof raw === "string") {
    const value = raw.trim().replace(/^cookie\s*:\s*/i, "").trim();
    if (!value) return null;
    return value.includes("=") ? value : `session=${value}`;
  }
  if (isRecord(raw)) {
    const parts = Object.entries(raw)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0)
      .map(([name, value]) => `${name}=${value.trim()}`);
    if (parts.length > 0) return parts.join("; ");
  }
  return null;
}

function apiUserHeader(cred: Record<string, string>): string | null {
  const raw = firstNonEmpty(cred, ["api_user", "user_id", "userId", "new-api-user"]);
  if (raw == null) return null;
  const value = String(raw).trim();
  return value || null;
}

function responseMessage(json: AnyRouterTopResponse): string {
  return typeof json.message === "string" && json.message.trim() ? json.message.trim() : "请求失败";
}

/** AnyRouter.top NewAPI：使用 session Cookie 查询 /api/user/self。 */
export const anyrouterTop: QuotaAdapter = {
  provider: "anyrouter_top",
  async fetch(cred, f) {
    const cookie = cookieHeader(cred);
    if (!cookie) throw new Error("missing credential: session（AnyRouter.top 登录 Cookie）");

    const configuredBase = typeof cred.base_url === "string" ? cred.base_url.trim() : "https://anyrouter.top";
    const base = secureBaseURL(configuredBase);
    const headers: Record<string, string> = {
      Cookie: cookie,
      Accept: "application/json, text/plain, */*",
      Referer: `${base}/console/personal`,
      Origin: new URL(base).origin,
    };
    const apiUser = apiUserHeader(cred);
    if (apiUser) headers["New-Api-User"] = apiUser;

    const res = await f(`${base}/api/user/self`, { headers });
    const body = (await res.text()).slice(0, 20_000);
    if (!res.ok) {
      if (res.status === 401) {
        throw new Error(`anyrouter.top: HTTP 401：session Cookie 已过期或无效，请重新登录 anyrouter.top 后更新 session。${body ? ` 原始响应: ${body.slice(0, 200)}` : ""}`);
      }
      throw new Error(`anyrouter.top: HTTP ${res.status}: ${body.slice(0, 200)}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error("anyrouter.top: /api/user/self 返回了非 JSON 响应，可能被 WAF 拦截；请补充有效的 WAF Cookie 或使用可达的 base_url");
    }
    if (!isRecord(parsed)) throw new Error("anyrouter.top: /api/user/self 返回格式无效");
    const json = parsed as AnyRouterTopResponse;
    if (json.success === false) throw new Error(`anyrouter.top: ${responseMessage(json)}`);
    if (!isRecord(json.data)) throw new Error(`anyrouter.top: ${responseMessage(json)}（缺少 data）`);

    const data = json.data as AnyRouterTopUser;
    const quota = finite(data.quota);
    const used = finite(data.used_quota);
    const rows: QuotaRow[] = [];
    if (quota != null) {
      rows.push({
        provider: "anyrouter_top",
        metric: "balance_usd",
        value: quota / QUOTA_UNITS_PER_USD,
        unit: "usd",
        limit_value: null,
        reset_at: null,
      });
    }
    if (used != null) {
      rows.push({
        provider: "anyrouter_top",
        metric: "used_usd",
        value: used / QUOTA_UNITS_PER_USD,
        unit: "usd",
        limit_value: null,
        reset_at: null,
      });
    }
    if (rows.length === 0) throw new Error("anyrouter.top: /api/user/self 没有可用的 quota/used_quota 字段");
    return rows;
  },
};
