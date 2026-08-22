import type { QuotaRow, QuotaAdapter } from "../types";

interface RateLimitModel {
  model?: string;
  max_in_window?: number;
  used_in_window?: number;
}

interface RateLimitSystem {
  period?: string;
  model?: string;
  max?: number;
  used?: number;
}

/** claude.ai usage（非官方，sessionKey cookie；接口变动时记录 scrape_error） */
export const claude: QuotaAdapter = {
  provider: "claude",
  async fetch(cred, f) {
    const sessionKey = cred.session_key ?? cred.sessionKey ?? cred.session;
    if (!sessionKey) throw new Error("missing credential: session_key");
    const cookie = `sessionKey=${sessionKey}`;

    const orgRes = await f("https://claude.ai/api/organizations", { headers: { Cookie: cookie } });
    if (!orgRes.ok) throw new Error(`claude organizations: HTTP ${orgRes.status}`);
    const orgs = (await orgRes.json()) as { uuid?: string }[];
    const org = Array.isArray(orgs) ? orgs[0] : undefined;
    if (!org?.uuid) throw new Error("claude: no organization uuid");

    const uRes = await f(`https://claude.ai/api/organizations/${org.uuid}/usage`, {
      headers: { Cookie: cookie },
    });
    if (!uRes.ok) throw new Error(`claude usage: HTTP ${uRes.status}`);
    const json = (await uRes.json()) as {
      total_usage?: { rate_limit_model?: RateLimitModel[]; rate_limit_system?: RateLimitSystem[] };
    };
    const models = json.total_usage?.rate_limit_model ?? [];
    if (models.length === 0) throw new Error("claude: no rate_limit_model in response");

    const rows: QuotaRow[] = [];
    for (const m of models) {
      const max = Number(m.max_in_window ?? 0);
      const used = Number(m.used_in_window ?? 0);
      if (max <= 0) continue;
      const pct = Math.round((used / max) * 1000) / 10;
      const multi = models.length > 1;
      rows.push({
        provider: "claude",
        metric: multi ? `session_used_pct_${sanitize(m.model ?? "model")}` : "session_used_pct",
        value: pct,
        unit: "percent",
        limit_value: 100,
        reset_at: null,
      });
    }

    // 周限额（rate_limit_system 中 period 含 week 的条目）
    const systems = json.total_usage?.rate_limit_system ?? [];
    for (const s of systems) {
      if (!s.period || !/week/i.test(s.period)) continue;
      const max = Number(s.max ?? 0);
      const used = Number(s.used ?? 0);
      if (max <= 0) continue;
      const pct = Math.round((used / max) * 1000) / 10;
      rows.push({
        provider: "claude",
        metric: "weekly_used_pct",
        value: pct,
        unit: "percent",
        limit_value: 100,
        reset_at: null,
      });
    }
    return rows;
  },
};

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 40);
}
