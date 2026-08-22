import type { QuotaRow, QuotaAdapter } from "../types";

export const glm: QuotaAdapter = {
  provider: "glm",
  async fetch(cred, f) {
    const apiKey = cred.api_key;
    if (!apiKey) throw new Error("missing credential: api_key");
    const res = await f("https://open.bigmodel.cn/api/paas/v4/balance/invoke", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: "{}",
    });
    if (!res.ok) throw new Error(`glm balance: HTTP ${res.status}`);
    const json = (await res.json()) as {
      code?: number;
      message?: string;
      data?: { balance_infos?: { currency: string; total_balance: number; available_balance?: number }[] };
    };
    if (json.code != null && json.code !== 200) throw new Error(`glm: ${json.code} ${json.message}`);
    const infos = json.data?.balance_infos ?? [];
    if (infos.length === 0) throw new Error("glm: no balance_infos in response");
    return infos.map((i) => ({
      provider: "glm",
      metric: `balance_${i.currency.toLowerCase()}`,
      value: Number(i.total_balance),
      unit: i.currency.toLowerCase(),
      limit_value: i.available_balance == null ? null : Number(i.available_balance),
      reset_at: null,
    })) as QuotaRow[];
  },
};
