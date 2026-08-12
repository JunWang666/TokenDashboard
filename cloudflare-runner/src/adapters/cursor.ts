import type { QuotaRow, QuotaAdapter } from "../types";

/** cursor.com usage（非官方，session cookie；接口变动时记录 scrape_error） */
export const cursor: QuotaAdapter = {
  provider: "cursor",
  async fetch(cred, f) {
    const cookie = cred.session ?? cred.session_key ?? cred.sessionKey;
    if (!cookie) throw new Error("missing credential: session (完整 cookie 串)");
    const res = await f("https://www.cursor.com/api/usage", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ trial_type: "free" }),
    });
    if (!res.ok) throw new Error(`cursor usage: HTTP ${res.status}`);
    const json = (await res.json()) as {
      quantity?: { limit?: { requests?: number; tokens?: number }; used?: { requests?: number; tokens?: number } };
    };
    const q = json.quantity;
    if (!q?.limit?.requests) throw new Error("cursor: no quantity.limit.requests in response");
    const limit = Number(q.limit.requests);
    const used = Number(q.used?.requests ?? 0);
    const rows: QuotaRow[] = [
      {
        provider: "cursor",
        metric: "requests_used",
        value: used,
        unit: "requests",
        limit_value: limit,
        reset_at: null,
      },
      {
        provider: "cursor",
        metric: "requests_remaining",
        value: Math.max(0, limit - used),
        unit: "requests",
        limit_value: limit,
        reset_at: null,
      },
    ];
    return rows;
  },
};
