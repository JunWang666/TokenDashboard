import { useState } from "react";
import { parseUtcDate, providerColor } from "../format";
import type { QuotaCurrentRow } from "../types";

export interface QuotaDisplay {
  label: string;
  value: number;
  limit: number | null;
  unit: string | null;
  resetAt: string | null;
  kind: "percent" | "requests" | "money" | "number";
}

/** 把某 provider 某把 key 的最新快照组转成主额度展示形态（可能多条，如 cursor 的分项池） */
export function quotaDisplay(provider: string, rows: QuotaCurrentRow[] | undefined, account = ""): QuotaDisplay[] {
  if (!rows) return [];
  const by = (metric: string) =>
    rows.find((r) => r.provider === provider && r.metric === metric && r.account === account);
  const pctDisplay = (label: string, s: QuotaCurrentRow, resetAt = s.reset_at): QuotaDisplay => ({
    label, value: s.value, limit: 100, unit: "percent", resetAt, kind: "percent",
  });
  switch (provider) {
    case "claude": {
      const s = by("weekly_used_pct") ?? by("session_used_pct");
      return s ? [pctDisplay("周额度", s, null)] : [];
    }
    case "codex": {
      // 订阅额度：周窗口 + 5 小时窗口；reset_at 是完整 ISO，截短展示
      const out: QuotaDisplay[] = [];
      const weekly = by("weekly_used_pct");
      if (weekly) out.push(pctDisplay("周额度", weekly, shortReset(weekly.reset_at)));
      const session = by("session_used_pct");
      if (session) out.push(pctDisplay("5 小时窗口", session, shortReset(session.reset_at)));
      return out;
    }
    case "kimi": {
      const out: QuotaDisplay[] = [];
      const weekly = by("weekly_used_pct");
      if (weekly) out.push(pctDisplay("周额度", weekly, shortReset(weekly.reset_at)));
      const session = by("session_used_pct");
      if (session) out.push(pctDisplay("5 小时窗口", session, shortReset(session.reset_at)));
      const monthly = by("monthly_used_pct"); // 需配置网页 web_token 才采集
      if (monthly) out.push(pctDisplay("月额度", monthly, shortReset(monthly.reset_at)));
      return out;
    }
    case "minimax": {
      const out: QuotaDisplay[] = [];
      const weekly = by("weekly_used_pct");
      if (weekly) out.push(pctDisplay("周额度", weekly, shortReset(weekly.reset_at)));
      const session = by("session_used_pct");
      if (session) out.push(pctDisplay("5 小时窗口", session, shortReset(session.reset_at)));
      return out;
    }
    case "zai": {
      const out: QuotaDisplay[] = [];
      const weekly = by("weekly_used_pct");
      if (weekly) out.push(pctDisplay("周额度", weekly, shortReset(weekly.reset_at)));
      const session = by("session_used_pct");
      if (session) out.push(pctDisplay("5 小时窗口", session, shortReset(session.reset_at)));
      const mcp = by("monthly_mcp_used_pct");
      if (mcp) out.push(pctDisplay("月 MCP 额度", mcp, shortReset(mcp.reset_at)));
      return out;
    }
    case "openai": {
      const s = by("month_cost_usd");
      if (!s) return [];
      return [{ label: "本月花费", value: s.value, limit: null, unit: "usd", resetAt: s.reset_at, kind: "money" }];
    }
    case "copilot": {
      const s = by("premium_used");
      if (!s) return [];
      return [{ label: "高级请求", value: s.value, limit: s.limit_value, unit: "requests", resetAt: null, kind: "requests" }];
    }
    case "glm":
    case "deepseek": {
      const s = by("balance_cny") ?? by("balance_usd");
      if (!s) return [];
      const currency = (s.unit ?? "cny").toUpperCase();
      return [{ label: "API 余额", value: s.value, limit: null, unit: currency, resetAt: null, kind: "money" }];
    }
    case "cursor": {
      // 与 cursor.com 仪表盘一致：分项池 Cursor Models / Other Models；
      // 老数据回退到总占比 plan_used_pct，再退到 requests_used
      const out: QuotaDisplay[] = [];
      const auto = by("auto_used_pct");
      const api = by("api_used_pct");
      if (auto) out.push(pctDisplay("Cursor Models", auto));
      if (api) out.push(pctDisplay("Other Models", api));
      if (out.length) return out;
      const pct = by("plan_used_pct");
      if (pct) return [pctDisplay("套餐用量", pct)];
      const s = by("requests_used");
      if (!s) return [];
      return [{ label: "套餐额度", value: s.value, limit: s.limit_value, unit: s.unit, resetAt: null, kind: "requests" }];
    }
    case "anyrouter": {
      const out: QuotaDisplay[] = [];
      for (const [metric, label] of [
        ["balance_usd", "余额"],
        ["monthly_balance_usd", "月度余额"],
        ["topup_balance_usd", "充值余额"],
        ["today_cost_usd", "今日消费"],
        ["used_usd", "累计消费"],
      ] as const) {
        const s = by(metric);
        if (s) out.push({ label, value: s.value, limit: null, unit: "usd", resetAt: null, kind: "money" });
      }
      return out;
    }
    default:
      return [];
  }
}

/** ISO 时间戳截短为 "MM-DD HH:mm"，用于额度重置时间展示 */
function shortReset(iso: string | null): string | null {
  if (!iso) return null;
  const d = parseUtcDate(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 采集错误信息：partial=true 表示同轮仍有成功快照（部分指标失败），卡片应正常显示数据并带警告 */
export interface ScrapeError {
  message: string;
  partial: boolean;
}

/** 非错误占位行的指标名（错误信息存在 reset_at） */
const ERROR_METRICS = new Set(["scrape_error", "scrape_warn"]);

export function scrapeError(
  provider: string,
  rows: QuotaCurrentRow[] | undefined,
  account = "",
): ScrapeError | null {
  const match = (r: QuotaCurrentRow) => r.provider === provider && r.account === account;
  const isData = (r: QuotaCurrentRow) => !ERROR_METRICS.has(r.metric);

  // scrape_error：整轮失败。有更新（或同轮）的成功快照 → 已恢复，不再报红
  const err = rows?.find((r) => match(r) && r.metric === "scrape_error");
  if (err) {
    const recovered = rows?.some((r) => match(r) && isData(r) && r.captured_at >= err.captured_at);
    if (!recovered) return { message: String(err.reset_at ?? "未知错误"), partial: false };
  }

  // scrape_warn：部分指标失败（适配器同轮已产出成功行）。下一轮全成功后被更新的数据行覆盖 → 视为恢复
  const warn = rows?.find((r) => match(r) && r.metric === "scrape_warn");
  if (!warn) return null;
  const recovered = rows?.some((r) => match(r) && isData(r) && r.captured_at > warn.captured_at);
  if (recovered) return null;
  return { message: String(warn.reset_at ?? "未知错误"), partial: true };
}

/** 采集失败错误文本 + 一键复制按钮（完整错误可能很长，卡片里显示不全） */
export function CopyableError({ err, tone = "red" }: { err: string; tone?: "red" | "amber" }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(err);
    } catch {
      // 非安全上下文等 clipboard 不可用时降级
      const ta = document.createElement("textarea");
      ta.value = err;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const cls =
    tone === "amber"
      ? "border-amber-500/40 text-amber-600 hover:bg-amber-500/10 dark:text-amber-400"
      : "border-red-500/40 text-red-500 hover:bg-red-500/10 dark:text-red-400";
  return (
    <button
      onClick={copy}
      title="复制完整错误"
      className={`flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-xs transition-colors ${cls}`}
    >
      {copied ? (
        "已复制"
      ) : (
        <>
          <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="5" y="5" width="9" height="9" rx="1.5" />
            <path d="M11 5V3.5A1.5 1.5 0 009.5 2H3.5A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5" />
          </svg>
          复制
        </>
      )}
    </button>
  );
}

export default function QuotaBar({ q }: { q: QuotaDisplay }) {
  const { value, limit, unit, kind, resetAt, label } = q;
  const color = "#34d399";
  if (kind === "money") {
    return (
      <div>
        <div className="text-xs text-slate-500">{label}</div>
        <div className="mt-1 text-xl font-semibold text-emerald-600 dark:text-emerald-300">
          {unit === "USD" || unit === "usd" ? "$" : ""}
          {value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}
          {unit === "USD" || unit === "usd" ? "" : ` ${unit}`}
        </div>
      </div>
    );
  }
  if (limit == null || limit <= 0) {
    return (
      <div>
        <div className="text-xs text-slate-500">{label}</div>
        <div className="mt-1 text-xl font-semibold">
          {fmtValue(value, kind)}
        </div>
      </div>
    );
  }
  const pct = Math.min(100, (value / limit) * 100);
  const danger = pct >= 90;
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-slate-500">{label}</span>
        <span className={`text-xs font-medium ${danger ? "text-red-500 dark:text-red-400" : "text-slate-500 dark:text-slate-400"}`}>
          {fmtValue(value, kind)} / {fmtValue(limit, kind)}
        </span>
      </div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
        <div
          className={`h-full rounded-full transition-all ${danger ? "bg-red-500" : "bg-emerald-400"}`}
          style={{ width: `${pct}%`, background: danger ? undefined : color }}
        />
      </div>
      <div className="mt-1 text-xs text-slate-500">
        {pct.toFixed(1)}% {resetAt ? `· ${resetAt}` : ""}
      </div>
    </div>
  );
}

function fmtValue(n: number, kind: string): string {
  if (kind === "percent") return `${n.toFixed(1)}%`;
  if (kind === "requests") return n.toLocaleString("zh-CN");
  return n.toFixed(2);
}
