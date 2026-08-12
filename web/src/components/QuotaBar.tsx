import { providerColor } from "../format";
import type { QuotaCurrentRow } from "../types";

export interface QuotaDisplay {
  label: string;
  value: number;
  limit: number | null;
  unit: string | null;
  resetAt: string | null;
  kind: "percent" | "requests" | "money" | "number";
}

/** 把某 provider 的最新快照组转成主额度展示形态 */
export function quotaDisplay(provider: string, rows: QuotaCurrentRow[] | undefined): QuotaDisplay | null {
  if (!rows) return null;
  const by = (metric: string) => rows.find((r) => r.provider === provider && r.metric === metric);
  const err = by("scrape_error");
  switch (provider) {
    case "claude": {
      const s = by("weekly_used_pct") ?? by("session_used_pct");
      if (!s) return null;
      return { label: "周额度", value: s.value, limit: 100, unit: "percent", resetAt: null, kind: "percent" };
    }
    case "openai": {
      const s = by("month_cost_usd");
      if (!s) return null;
      return { label: "本月花费", value: s.value, limit: null, unit: "usd", resetAt: s.reset_at, kind: "money" };
    }
    case "copilot": {
      const s = by("premium_used");
      if (!s) return null;
      return { label: "高级请求", value: s.value, limit: s.limit_value, unit: "requests", resetAt: null, kind: "requests" };
    }
    case "glm":
    case "deepseek": {
      const s = by("balance_cny") ?? by("balance_usd");
      if (!s) return null;
      const currency = (s.unit ?? "cny").toUpperCase();
      return { label: "API 余额", value: s.value, limit: null, unit: currency, resetAt: null, kind: "money" };
    }
    case "cursor": {
      const s = by("requests_used");
      if (!s) return null;
      return { label: "请求用量", value: s.value, limit: s.limit_value, unit: "requests", resetAt: null, kind: "requests" };
    }
    default:
      return null;
  }
}

export function scrapeError(provider: string, rows: QuotaCurrentRow[] | undefined): string | null {
  const err = rows?.find((r) => r.provider === provider && r.metric === "scrape_error");
  return err ? String(err.reset_at ?? "未知错误") : null;
}

export default function QuotaBar({ q }: { q: QuotaDisplay }) {
  const { value, limit, unit, kind, resetAt, label } = q;
  const color = "#34d399";
  if (kind === "money") {
    return (
      <div>
        <div className="text-xs text-slate-500">{label}</div>
        <div className="mt-1 text-xl font-semibold text-emerald-300">
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
        <span className={`text-xs font-medium ${danger ? "text-red-400" : "text-slate-400"}`}>
          {fmtValue(value, kind)} / {fmtValue(limit, kind)}
        </span>
      </div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-800">
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
