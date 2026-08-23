import type { QuotaRow, QuotaAdapter } from "../types";

interface KimiWindow {
  duration?: number;
  timeUnit?: string; // protobuf 风格，如 "TIME_UNIT_MINUTE"
}

interface KimiQuota {
  limit?: unknown; // 数值可能是 JSON 字符串（"100"）或数字
  used?: unknown;
  remaining?: unknown;
  resetTime?: string;
}

/** 宽松解析字符串/数字两种形态 */
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** window 时长换算成秒；无法识别返回 0 */
function windowSeconds(w?: KimiWindow): number {
  const d = Number(w?.duration ?? 0);
  const unit = (w?.timeUnit ?? "").toUpperCase();
  if (unit.endsWith("MINUTE")) return d * 60;
  if (unit.endsWith("HOUR")) return d * 3600;
  if (unit.endsWith("SECOND")) return d;
  return 0;
}

/**
 * api.kimi.com /coding/v1/usages（Kimi Code 订阅额度）。
 * 凭证：kimi.com/code 控制台创建的 API Key（sk-kimi-*，与开放平台 sk- key 不互通）；
 * OAuth access_token 仅 15 分钟有效，不适合 cron 采集。
 * 可选 cred.base_url：正向转发地址（如 https://relay.example.com/kimi，用于绕开对端
 * WAF 对 Workers 出口的拦截——Workers fetch 不支持 HTTP 代理，只能换请求地址）。
 * 可选 cred.web_token：kimi.com 网页登录态 access_token，用于采集月额度（见 fetchMonthly）。
 * 注意：官方声明篡改 User-Agent 视为违规，这里不自定义 UA。
 */
export const kimi: QuotaAdapter = {
  provider: "kimi",
  async fetch(cred, f) {
    const apiKey = cred.api_key ?? cred.access_token ?? cred.token;
    if (!apiKey) throw new Error("missing credential: api_key（kimi.com/code 控制台的 sk-kimi- key）");
    const base = (cred.base_url ?? "https://api.kimi.com/coding/v1").replace(/\/+$/, "");
    const res = await f(`${base}/usages`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`kimi usages: HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as {
      usage?: KimiQuota; // 周额度（报 remaining，不报 used）
      limits?: { window?: KimiWindow; detail?: KimiQuota }[]; // 滚动频率窗口
    };

    const rows: QuotaRow[] = [];

    // 周额度：limit/remaining 换算已用百分比
    const weekLimit = num(json.usage?.limit);
    if (weekLimit > 0) {
      const remaining = num(json.usage?.remaining);
      rows.push({
        provider: "kimi",
        metric: "weekly_used_pct",
        value: Math.round(((weekLimit - remaining) / weekLimit) * 1000) / 10,
        unit: "percent",
        limit_value: 100,
        reset_at: json.usage?.resetTime ?? null,
      });
    }

    // 5 小时滚动窗口：按时长识别（duration×timeUnit ≈ 18000 秒），不靠数组下标
    for (const l of json.limits ?? []) {
      const secs = windowSeconds(l.window);
      if (secs < 3600 || secs >= 86400) continue;
      const d = l.detail ?? {};
      const dLimit = num(d.limit);
      if (dLimit <= 0) continue;
      const used = d.used != null ? num(d.used) : dLimit - num(d.remaining);
      rows.push({
        provider: "kimi",
        metric: "session_used_pct",
        value: Math.round((used / dLimit) * 1000) / 10,
        unit: "percent",
        limit_value: 100,
        reset_at: typeof d.resetTime === "string" ? d.resetTime : null,
      });
      break;
    }

    if (rows.length === 0) throw new Error("kimi: no usage/limits in response");
    rows.push(...(await fetchMonthly(cred, f)));
    return rows;
  },
};

/** 月额度的 Balance 结构（connect JSON；实测服务端返回 camelCase，snake_case 兜底） */
interface KimiStatsBalance {
  amount?: unknown;
  amountLeft?: unknown;
  amount_left?: unknown;
  amountUsedRatio?: number;
  amount_used_ratio?: number;
  expireTime?: string; // protobuf Timestamp 的 JSON 形态是 RFC3339 字符串
  expire_time?: string;
}

/**
 * 月额度：kimi.com 网页版会员接口（connect RPC，proto 定义取自 kimi.com 前端包：
 * kimi.gateway.membership.v2.MembershipService.GetSubscriptionStats）。
 * 需要 kimi.com 网页登录态 access_token（cred.web_token）；月额度不在 coding/v1/usages 里。
 * Kimi Code 月额度在 DOMAIN_CODE，与主站会员共享时退到 DOMAIN_KIMI。
 */
async function fetchMonthly(cred: Record<string, string>, f: typeof fetch): Promise<QuotaRow[]> {
  const webToken = cred.web_token;
  if (!webToken) return [];
  const base = (cred.stats_base_url ?? "https://www.kimi.com/apiv2").replace(/\/+$/, "");
  const url = `${base}/kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats`;
  for (const domain of ["DOMAIN_CODE", "DOMAIN_KIMI"]) {
    const res = await f(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${webToken}`,
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
        Accept: "application/json",
      },
      body: JSON.stringify({ domain }),
    });
    if (!res.ok)
      throw new Error(`kimi stats(${domain}): HTTP ${res.status}（web_token 可能已过期，需重新粘贴）: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as {
      subscriptionBalance?: KimiStatsBalance | null;
      subscription_balance?: KimiStatsBalance | null;
    };
    // 实测服务端返回 camelCase（尽管前端 client 配了 useProtoFieldName），两种都兼容
    const b = json.subscriptionBalance ?? json.subscription_balance;
    if (!b) continue;
    const amount = num(b.amount);
    const left = num(b.amountLeft ?? b.amount_left);
    let pct = Number(b.amountUsedRatio ?? b.amount_used_ratio ?? 0) * 100;
    if (pct === 0 && amount > 0) pct = ((amount - left) / amount) * 100;
    const resetAt = b.expireTime ?? b.expire_time ?? null;
    const rows: QuotaRow[] = [
      {
        provider: "kimi",
        metric: "monthly_used_pct",
        value: Math.round(pct * 10) / 10,
        unit: "percent",
        limit_value: 100,
        reset_at: resetAt,
      },
    ];
    if (amount > 0) {
      rows.push({
        provider: "kimi",
        metric: "monthly_remaining",
        value: left,
        unit: "credits",
        limit_value: amount,
        reset_at: resetAt,
      });
    }
    return rows;
  }
  return []; // 有 web_token 但无订阅余额（未订阅会员）：不报错，只是没有月额度行
}
