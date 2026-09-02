import type { QuotaAdapter, QuotaRow } from "../types";

interface AnyRouterCredits {
  balance?: unknown;
  monthly_balance?: unknown;
  topup_balance?: unknown;
  used?: unknown;
  today_cost?: unknown;
  currency?: string;
}

function finite(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Accept an API key pasted as either the raw secret or an Authorization header. */
function apiKeyFromCredential(cred: Record<string, string>): string | null {
  const raw = cred.api_key ?? cred.token ?? cred.value;
  if (!raw) return null;

  let value = raw.trim();
  value = value.replace(/^authorization\s*:\s*/i, "").trim();
  value = value.replace(/^bearer\s+/i, "").trim();
  return value || null;
}

function secureBaseURL(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("anyrouter: base_url must be a valid HTTPS URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("anyrouter: base_url must be HTTPS without credentials, query, or fragment");
  }
  return raw.replace(/\/+$/, "");
}

/** AnyRouter credits API：查询 workspace 的余额与消费概况。 */
export const anyrouter: QuotaAdapter = {
  provider: "anyrouter",
  async fetch(cred, f) {
    const apiKey = apiKeyFromCredential(cred);
    if (!apiKey) throw new Error("missing credential: api_key（AnyRouter LLM Key 或 Management Key）");

    const base = secureBaseURL((cred.base_url ?? "https://anyrouter.dev/api/v1").trim());
    const res = await f(`${base}/credits`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200);
      if (res.status === 401) {
        throw new Error(
          `anyrouter credits: HTTP 401：API key 无效、已过期、已撤销或复制不完整；请在 AnyRouter 控制台重新创建/轮换 sk-ar-v1-... key。${detail ? ` 原始响应: ${detail}` : ""}`,
        );
      }
      if (res.status === 403) {
        throw new Error(
          `anyrouter credits: HTTP 403：当前 key 没有 /api/v1/credits 权限；请开启 Management/credits 权限，或使用带 read:credits 的 ak_ 管理 key。${detail ? ` 原始响应: ${detail}` : ""}`,
        );
      }
      throw new Error(`anyrouter credits: HTTP ${res.status}: ${detail}`);
    }

    const json = (await res.json()) as AnyRouterCredits;
    const currency = (json.currency ?? "usd").toLowerCase();
    if (currency !== "usd") throw new Error(`anyrouter: unsupported currency ${json.currency}`);

    const fields = [
      ["balance_usd", json.balance],
      ["monthly_balance_usd", json.monthly_balance],
      ["topup_balance_usd", json.topup_balance],
      ["used_usd", json.used],
      ["today_cost_usd", json.today_cost],
    ] as const;
    const rows: QuotaRow[] = [];
    for (const [metric, raw] of fields) {
      const value = finite(raw);
      if (value == null) continue;
      rows.push({
        provider: "anyrouter",
        metric,
        value,
        unit: "usd",
        limit_value: null,
        reset_at: null,
      });
    }
    if (rows.length === 0) throw new Error("anyrouter: no usable credits fields in response");
    return rows;
  },
};
