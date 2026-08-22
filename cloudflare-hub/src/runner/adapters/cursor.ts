import type { QuotaRow, QuotaAdapter } from "../types";

/** cursor.com usage-summary（非官方，session cookie；接口变动时记录 scrape_error） */
export const cursor: QuotaAdapter = {
  provider: "cursor",
  async fetch(cred, f) {
    const cookie = cred.session ?? cred.session_key ?? cred.sessionKey;
    if (!cookie) throw new Error("missing credential: session (完整 cookie 串)");
    const res = await f("https://cursor.com/api/usage-summary", {
      headers: { Cookie: cookie, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`cursor usage-summary: HTTP ${res.status}`);
    const json = (await res.json()) as {
      billingCycleEnd?: string;
      membershipType?: string;
      individualUsage?: {
        plan?: {
          used?: number;
          limit?: number | null;
          remaining?: number | null;
          breakdown?: { included?: number; bonus?: number; total?: number };
          autoPercentUsed?: number;
          apiPercentUsed?: number;
          totalPercentUsed?: number;
        };
      };
    };
    const plan = json.individualUsage?.plan;
    if (!plan || plan.used == null) throw new Error("cursor: no individualUsage.plan in response");
    const resetAt = json.billingCycleEnd ? json.billingCycleEnd.slice(0, 10) : null;

    const rows: QuotaRow[] = [];
    // 分项池：对应 cursor.com 仪表盘两条柱（Cursor Models / Other Models）
    for (const [metric, v] of [
      ["auto_used_pct", plan.autoPercentUsed],
      ["api_used_pct", plan.apiPercentUsed],
    ] as const) {
      if (typeof v === "number") {
        rows.push({
          provider: "cursor",
          metric,
          value: Math.round(v * 10) / 10,
          unit: "percent",
          limit_value: 100,
          reset_at: resetAt,
        });
      }
    }
    // 总占比（按额度加权，含 bonus 额度）；保留作兼容与老数据回退
    if (typeof plan.totalPercentUsed === "number") {
      rows.push({
        provider: "cursor",
        metric: "plan_used_pct",
        value: Math.round(plan.totalPercentUsed * 10) / 10,
        unit: "percent",
        limit_value: 100,
        reset_at: resetAt,
      });
    }
    rows.push({
      provider: "cursor",
      metric: "requests_used",
      value: plan.used,
      unit: "usd_cents",
      limit_value: plan.limit ?? null,
      reset_at: resetAt,
    });
    if (plan.remaining != null && plan.limit != null) {
      rows.push({
        provider: "cursor",
        metric: "requests_remaining",
        value: plan.remaining,
        unit: "usd_cents",
        limit_value: plan.limit,
        reset_at: resetAt,
      });
    }
    return rows;
  },
};
