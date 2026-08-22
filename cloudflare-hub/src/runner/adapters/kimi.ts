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
    return rows;
  },
};
