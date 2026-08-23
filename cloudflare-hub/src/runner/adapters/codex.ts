import type { QuotaRow, QuotaAdapter } from "../types";

interface CodexWindow {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_after_seconds?: number;
  reset_at?: number; // unix 秒
}

/**
 * chatgpt.com /backend-api/wham/usage（Codex 订阅额度，非官方；接口变动时记录 scrape_error）。
 * 凭证：~/.codex/auth.json 的 tokens.access_token（ChatGPT 订阅 OAuth token，有效期约一周，过期需重新粘贴）。
 * 可选 cred.base_url：正向转发地址（替换 https://chatgpt.com/backend-api，用于绕开对端 WAF 对 Workers 出口的拦截）。
 * 注意：必须带 codex CLI 风格的 User-Agent——实测默认 UA 被拦返回 403 HTML 错误页（不是 401）。
 * 刻意不做 refresh_token 自动续期：refresh token 是一次性轮换的，runner 刷新会使本机 Codex CLI 登录态作废。
 */
export const codex: QuotaAdapter = {
  provider: "codex",
  async fetch(cred, f) {
    const token = cred.access_token ?? cred.token;
    if (!token) throw new Error("missing credential: access_token（~/.codex/auth.json 的 tokens.access_token）");
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      originator: "codex_cli_rs",
      "User-Agent": "codex_cli_rs/0.40.0",
    };
    if (cred.account_id) headers["ChatGPT-Account-Id"] = cred.account_id;

    const base = (cred.base_url ?? "https://chatgpt.com/backend-api").replace(/\/+$/, "");
    const res = await f(`${base}/wham/usage`, { headers });
    if (!res.ok) throw new Error(`codex usage: HTTP ${res.status}（access_token 可能已过期，需重新粘贴）: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as {
      plan_type?: string;
      rate_limit?: { primary_window?: CodexWindow | null; secondary_window?: CodexWindow | null };
      credits?: { has_credits?: boolean; balance?: string | number };
    };

    const primary = json.rate_limit?.primary_window ?? null;
    const secondary = json.rate_limit?.secondary_window ?? null;
    if (!primary && !secondary) throw new Error("codex: no rate_limit window in response");

    // 窗口身份靠 limit_window_seconds 判断（部分套餐周限额在 primary_window），
    // 缺时长时按 primary=5 小时 / secondary=周 兜底
    const rows: QuotaRow[] = [];
    for (const [w, fallback] of [
      [primary, "session_used_pct"],
      [secondary, "weekly_used_pct"],
    ] as const) {
      if (!w || w.used_percent == null) continue;
      const secs = Number(w.limit_window_seconds ?? 0);
      const metric = secs >= 86400 ? "weekly_used_pct" : secs > 0 ? "session_used_pct" : fallback;
      rows.push({
        provider: "codex",
        metric,
        value: Number(w.used_percent),
        unit: "percent",
        limit_value: 100,
        reset_at: w.reset_at ? new Date(Number(w.reset_at) * 1000).toISOString() : null,
      });
    }

    // 充值余额（可选字段，balance 可能是字符串）
    const balance = Number(json.credits?.balance);
    if (json.credits?.has_credits && Number.isFinite(balance)) {
      rows.push({
        provider: "codex",
        metric: "credits_usd",
        value: balance,
        unit: "usd",
        limit_value: null,
        reset_at: null,
      });
    }
    return rows;
  },
};
