import type { QuotaRow, QuotaAdapter } from "../types";

/** GitHub Copilot：GET /copilot_internal/user（社区常用接口，非官方） */
export const copilot: QuotaAdapter = {
  provider: "copilot",
  async fetch(cred, f) {
    const token = cred.token;
    if (!token) throw new Error("missing credential: token (GitHub personal token)");
    const res = await f("https://api.github.com/copilot_internal/user", {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "tokendash-runner" },
    });
    if (!res.ok) throw new Error(`copilot user: HTTP ${res.status}`);
    const json = (await res.json()) as {
      status?: string;
      plan?: { seat?: string; usage?: { limit?: number; used?: number; remaining?: number } };
    };
    const usage = json.plan?.usage;
    if (!usage) throw new Error("copilot: no plan.usage in response");
    const rows: QuotaRow[] = [
      {
        provider: "copilot",
        metric: "premium_used",
        value: Number(usage.used ?? 0),
        unit: "requests",
        limit_value: usage.limit == null ? null : Number(usage.limit),
        reset_at: null,
      },
    ];
    if (usage.remaining != null) {
      rows.push({
        provider: "copilot",
        metric: "premium_remaining",
        value: Number(usage.remaining),
        unit: "requests",
        limit_value: usage.limit == null ? null : Number(usage.limit),
        reset_at: null,
      });
    }
    return rows;
  },
};
