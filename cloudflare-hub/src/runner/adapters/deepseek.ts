import type { QuotaRow, QuotaAdapter } from "../types";

export const deepseek: QuotaAdapter = {
  provider: "deepseek",
  async fetch(cred, f) {
    const apiKey = cred.api_key;
    if (!apiKey) throw new Error("missing credential: api_key");
    const res = await f("https://api.deepseek.com/user/balance", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`deepseek balance: HTTP ${res.status}`);
    const json = (await res.json()) as {
      is_available?: boolean;
      balance_infos?: { currency: string; total_balance: number }[];
    };
    const infos = json.balance_infos ?? [];
    if (infos.length === 0) throw new Error("deepseek: no balance_infos in response");
    return infos.map((i) => ({
      provider: "deepseek",
      metric: `balance_${i.currency.toLowerCase()}`,
      value: Number(i.total_balance),
      unit: i.currency.toLowerCase(),
      limit_value: null,
      reset_at: null,
    })) as QuotaRow[];
  },
};
