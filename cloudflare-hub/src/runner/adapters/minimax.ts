import type { QuotaAdapter, QuotaRow } from "../types";

interface MiniMaxRemain {
  model_name?: string;
  end_time?: unknown;
  weekly_end_time?: unknown;
  remains_time?: unknown;
  weekly_remains_time?: unknown;
  current_interval_total_count?: unknown;
  current_interval_usage_count?: unknown;
  current_interval_remaining_percent?: unknown;
  current_interval_status?: unknown;
  current_weekly_total_count?: unknown;
  current_weekly_usage_count?: unknown;
  current_weekly_remaining_percent?: unknown;
  current_weekly_status?: unknown;
}

function finite(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * MiniMax 的 usage_count 字段虽然名字像“已使用”，实际返回的是“剩余量”。
 * 新版响应优先提供 remaining_percent；旧版则用 total - usage_count 计算已用量。
 */
function usedPercent(totalValue: unknown, remainingValue: unknown, remainingPctValue: unknown): number | null {
  const remainingPct = finite(remainingPctValue);
  if (remainingPct != null) return roundPct(100 - remainingPct);
  const total = finite(totalValue);
  const remaining = finite(remainingValue);
  if (total != null && remaining != null && total > 0) return roundPct(((total - remaining) / total) * 100);
  return null;
}

function roundPct(value: number): number {
  return Math.round(Math.max(0, Math.min(100, value)) * 10) / 10;
}

function resetISO(explicit: unknown, remainsMs: unknown): string | null {
  const raw = finite(explicit);
  if (raw != null && raw > 0) {
    const ms = raw < 1_000_000_000_000 ? raw * 1000 : raw;
    return new Date(ms).toISOString();
  }
  const left = finite(remainsMs);
  return left != null && left > 0 ? new Date(Date.now() + left).toISOString() : null;
}

function suffix(model: string | undefined, multiple: boolean): string {
  if (!multiple || !model || model === "general") return "";
  return `_${model.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 40)}`;
}

function secureBaseURL(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("minimax: base_url must be a valid HTTPS URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("minimax: base_url must be HTTPS without credentials, query, or fragment");
  }
  return raw.replace(/\/+$/, "");
}

/**
 * MiniMax Token Plan（官方只读额度接口）。
 * 凭证必须是 Token Plan Subscription Key，不是普通按量付费 API Key。
 * region=cn 使用中国站；也可用 base_url 覆盖到兼容的 HTTPS 转发地址。
 */
export const minimax: QuotaAdapter = {
  provider: "minimax",
  async fetch(cred, f) {
    const apiKey = cred.api_key ?? cred.token;
    if (!apiKey) throw new Error("missing credential: api_key（MiniMax Token Plan Subscription Key）");
    const defaultBase = cred.region === "cn" ? "https://api.minimaxi.com/v1" : "https://api.minimax.io/v1";
    const base = secureBaseURL(cred.base_url ?? defaultBase);
    const res = await f(`${base}/token_plan/remains`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`minimax token plan remains: HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      model_remains?: MiniMaxRemain[];
      base_resp?: { status_code?: number; status_msg?: string };
    };
    if (json.base_resp?.status_code != null && json.base_resp.status_code !== 0) {
      throw new Error(`minimax: ${json.base_resp.status_code} ${json.base_resp.status_msg ?? "unknown error"}`);
    }
    const remains = Array.isArray(json.model_remains) ? json.model_remains : [];
    const multiple = remains.length > 1;
    const rows: QuotaRow[] = [];
    for (const item of remains) {
      const metricSuffix = suffix(item.model_name, multiple);
      const session = usedPercent(
        item.current_interval_total_count,
        item.current_interval_usage_count,
        item.current_interval_remaining_percent,
      );
      if (session != null) {
        rows.push({
          provider: "minimax",
          metric: `session_used_pct${metricSuffix}`,
          value: session,
          unit: "percent",
          limit_value: 100,
          reset_at: resetISO(item.end_time, item.remains_time),
        });
      }
      const weekly = usedPercent(
        item.current_weekly_total_count,
        item.current_weekly_usage_count,
        item.current_weekly_remaining_percent,
      );
      if (weekly != null) {
        rows.push({
          provider: "minimax",
          metric: `weekly_used_pct${metricSuffix}`,
          value: weekly,
          unit: "percent",
          limit_value: 100,
          reset_at: resetISO(item.weekly_end_time, item.weekly_remains_time),
        });
      }
    }
    if (rows.length === 0) throw new Error("minimax: no usable quota windows in response");
    return rows;
  },
};
