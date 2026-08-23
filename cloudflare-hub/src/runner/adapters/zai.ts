import type { QuotaAdapter, QuotaRow } from "../types";

interface ZaiLimit {
  type?: string;
  unit?: unknown;
  number?: unknown;
  usage?: unknown;
  currentValue?: unknown;
  remaining?: unknown;
  percentage?: unknown;
  nextResetTime?: unknown;
}

interface ZaiEnvelope {
  success?: boolean;
  code?: number;
  msg?: string;
  data?: { limits?: ZaiLimit[] };
}

function finite(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function usedPercent(item: ZaiLimit): number | null {
  const percentage = finite(item.percentage);
  if (percentage != null) return Math.round(Math.max(0, Math.min(100, percentage)) * 10) / 10;
  const used = finite(item.currentValue);
  const total = finite(item.usage);
  if (used == null || total == null || total <= 0) return null;
  return Math.round(Math.max(0, Math.min(100, (used / total) * 100)) * 10) / 10;
}

function resetISO(value: unknown): string | null {
  const n = finite(value);
  if (n == null || n <= 0) return null;
  return new Date(n < 1_000_000_000_000 ? n * 1000 : n).toISOString();
}

function metricFor(item: ZaiLimit): string | null {
  const unit = finite(item.unit);
  if (unit === 3) return "session_used_pct"; // 5 小时
  if (unit === 6) return "weekly_used_pct"; // 周
  if (unit === 5 || item.type === "TIME_LIMIT") return "monthly_mcp_used_pct";
  return null;
}

function secureBaseURL(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("zai: base_url must be a valid HTTPS URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("zai: base_url must be HTTPS without credentials, query, or fragment");
  }
  return raw.replace(/\/+$/, "");
}

async function fetchEnvelope(url: string, apiKey: string, f: typeof fetch): Promise<{ json?: ZaiEnvelope; error?: string }> {
  const res = await f(url, {
    headers: {
      // 官方 glm-plan-usage 插件使用原始 API Key；服务端也兼容部分 Bearer Key。
      Authorization: apiKey,
      "Accept-Language": "en-US,en",
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) return { error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
  const json = (await res.json()) as ZaiEnvelope;
  if (json.success === false || (json.code != null && json.code !== 200)) {
    return { error: `${json.code ?? "API"}: ${json.msg ?? "request failed"}` };
  }
  return { json };
}

/**
 * Z.ai / GLM Coding Plan。兼容旧版 quota/limit 与 2026 V3 的 usage 路径，
 * 以及 TOKENS_LIMIT、CREDIT_LIMIT、TIME_LIMIT 三种额度形态。
 */
export const zai: QuotaAdapter = {
  provider: "zai",
  async fetch(cred, f) {
    const apiKey = cred.api_key ?? cred.token;
    if (!apiKey) throw new Error("missing credential: api_key（Z.ai / GLM Coding Plan Key）");
    const defaultBase = cred.region === "cn" ? "https://open.bigmodel.cn" : "https://api.z.ai";
    const base = secureBaseURL(cred.base_url ?? defaultBase);
    const paths = ["/api/monitor/usage/quota/limit", "/api/monitor/usage"];
    const errors: string[] = [];
    let limits: ZaiLimit[] = [];
    for (const path of paths) {
      const result = await fetchEnvelope(`${base}${path}`, apiKey, f);
      if (result.error) {
        errors.push(`${path}: ${result.error}`);
        continue;
      }
      limits = result.json?.data?.limits ?? [];
      if (limits.length > 0) break;
      errors.push(`${path}: no limits`);
    }

    const rows: QuotaRow[] = [];
    const seen = new Set<string>();
    for (const item of limits) {
      if (!["TOKENS_LIMIT", "CREDIT_LIMIT", "TIME_LIMIT"].includes(item.type ?? "")) continue;
      const metric = metricFor(item);
      const pct = usedPercent(item);
      if (!metric || pct == null || seen.has(metric)) continue;
      seen.add(metric);
      rows.push({
        provider: "zai",
        metric,
        value: pct,
        unit: "percent",
        limit_value: 100,
        reset_at: resetISO(item.nextResetTime),
      });
    }
    if (rows.length === 0) {
      throw new Error(`zai: no usable Coding Plan quota windows${errors.length ? ` (${errors.join("; ")})` : ""}`);
    }
    return rows;
  },
};
