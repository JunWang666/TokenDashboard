import type { QuotaRow, QuotaAdapter } from "../types";

/** 当月起始/结束的 unix 秒（UTC） */
export function monthBounds(now = Date.now()): { start: number; end: number; endISO: string } {
  const d = new Date(now);
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return { start: Math.floor(start.getTime() / 1000), end: Math.floor(end.getTime() / 1000), endISO: end.toISOString() };
}

/** 递归收集所有 amount 对象 */
function collectAmounts(node: unknown, out: { value: string; currency: string }[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectAmounts(item, out);
    return;
  }
  if (node && typeof node === "object") {
    const rec = node as Record<string, unknown>;
    if (rec.amount && typeof rec.amount === "object") {
      const a = rec.amount as Record<string, unknown>;
      out.push({ value: String(a.value ?? 0), currency: String(a.currency ?? "usd") });
    }
    for (const v of Object.values(rec)) if (v && typeof v === "object") collectAmounts(v, out);
  }
}

export const openai: QuotaAdapter = {
  provider: "openai",
  async fetch(cred, f) {
    const apiKey = cred.api_key;
    if (!apiKey) throw new Error("missing credential: api_key (Admin API Key 或组织 key)");
    const { start, end, endISO } = monthBounds();
    const costRes = await f(
      `https://api.openai.com/v1/organization/costs?start_time=${start}&end_time=${end}&bucket_width=1d`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    if (!costRes.ok) throw new Error(`openai costs: HTTP ${costRes.status}`);
    const costJson = (await costRes.json()) as { data?: unknown };
    const amounts: { value: string; currency: string }[] = [];
    collectAmounts(costJson.data, amounts);
    const monthCost = amounts.reduce((sum, a) => sum + Number(a.value || 0), 0);
    const rows: QuotaRow[] = [
      {
        provider: "openai",
        metric: "month_cost_usd",
        value: round2(monthCost),
        unit: "usd",
        limit_value: null,
        reset_at: endISO,
      },
    ];

    // 余额不是所有账户都有（多数按量后付费），尽力尝试 balance 接口，失败不阻塞
    try {
      const balRes = await f("https://api.openai.com/v1/organization/usage/balance", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (balRes.ok) {
        const bal = (await balRes.json()) as { current_balance?: number };
        if (bal.current_balance != null) {
          rows.push({
            provider: "openai",
            metric: "balance_usd",
            value: bal.current_balance,
            unit: "usd",
            limit_value: null,
            reset_at: null,
          });
        }
      }
    } catch {
      /* 可选接口，忽略 */
    }
    return rows;
  },
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
