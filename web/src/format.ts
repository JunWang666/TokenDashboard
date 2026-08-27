export const PROVIDERS: { id: string; name: string; color: string }[] = [
  { id: "claude", name: "Claude", color: "#d97757" },
  { id: "codex", name: "Codex", color: "#14b8a6" },
  { id: "kimi", name: "Kimi", color: "#d946ef" },
  { id: "minimax", name: "MiniMax Token Plan", color: "#f97316" },
  { id: "zai", name: "Z.ai Coding Plan", color: "#06b6d4" },
  { id: "anyrouter", name: "AnyRouter", color: "#7c3aed" },
  { id: "openai", name: "OpenAI", color: "#10a37f" },
  { id: "copilot", name: "GitHub Copilot", color: "#8957e5" },
  { id: "glm", name: "GLM", color: "#3b82f6" },
  { id: "deepseek", name: "DeepSeek", color: "#6366f1" },
  { id: "cursor", name: "Cursor", color: "#e8b339" },
];

const USAGE_ONLY_PROVIDERS: Record<string, { id: string; name: string; color: string }> = {
  gemini: { id: "gemini", name: "Gemini CLI", color: "#4285f4" },
  opencode: { id: "opencode", name: "OpenCode", color: "#f59e0b" },
};

export const providerMeta = (id: string) => PROVIDERS.find((p) => p.id === id) ?? USAGE_ONLY_PROVIDERS[id] ?? { id, name: id, color: "#94a3b8" };

export const providerColor = (id: string) => providerMeta(id).color;

/** 每个 provider 在 Overview 上展示的主额度指标 */
export function primaryQuotaMetric(provider: string): string {
  switch (provider) {
    case "claude":
      return "weekly_used_pct";
    case "codex":
    case "kimi":
    case "minimax":
    case "zai":
      return "weekly_used_pct";
    case "openai":
      return "month_cost_usd";
    case "copilot":
      return "premium_used";
    case "glm":
    case "deepseek":
      return "balance_cny";
    case "cursor":
      return "requests_used";
    case "anyrouter":
      return "balance_usd";
    default:
      return "";
  }
}

export function fmtTokens(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

export function fmtUsd(n: number): string {
  return "$" + n.toFixed(2);
}

export function fmtNumber(n: number): string {
  return new Intl.NumberFormat("zh-CN").format(n);
}

/**
 * Hub stores SQLite datetime('now') values as UTC without a timezone suffix,
 * while ISO values from adapters include Z/offsets. Normalize both forms
 * before letting the browser render them in the user's local timezone.
 */
export function parseUtcDate(value: string): Date {
  const raw = value.trim();
  if (!raw) return new Date(Number.NaN);
  const normalized = raw.replace(" ", "T");
  if (/Z$|[+-]\d{2}:?\d{2}$/i.test(normalized) || /^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return new Date(normalized);
  }
  return new Date(`${normalized}Z`);
}

export function fmtTime(iso: string): string {
  const d = parseUtcDate(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("zh-CN", { hour12: false });
}

/** 额度指标的中文名；未知指标回退原文 */
export function metricLabel(metric: string): string {
  if (metric.startsWith("session_used_pct_")) return `5 小时 · ${metric.slice("session_used_pct_".length)}`;
  switch (metric) {
    case "weekly_used_pct":
      return "周额度";
    case "session_used_pct":
      return "5 小时窗口";
    case "monthly_used_pct":
      return "月额度";
    case "monthly_remaining":
      return "月剩余";
    case "credits_usd":
      return "充值余额";
    case "balance_usd":
      return "余额 USD";
    case "balance_cny":
      return "余额 CNY";
    case "month_cost_usd":
      return "本月花费";
    case "monthly_balance_usd":
      return "月度余额 USD";
    case "topup_balance_usd":
      return "充值余额 USD";
    case "used_usd":
      return "累计消费 USD";
    case "today_cost_usd":
      return "今日消费 USD";
    case "premium_used":
      return "高级请求已用";
    case "premium_remaining":
      return "高级请求剩余";
    case "auto_used_pct":
      return "Cursor Models";
    case "api_used_pct":
      return "Other Models";
    case "plan_used_pct":
      return "套餐用量";
    case "requests_used":
      return "已用额度";
    case "requests_remaining":
      return "剩余额度";
    default:
      return metric;
  }
}

/** 同图多条线的配色：同名指标跨 Key 颜色一致 */
const METRIC_COLORS: Record<string, string> = {
  weekly_used_pct: "#34d399",
  session_used_pct: "#38bdf8",
  monthly_used_pct: "#a78bfa",
  monthly_remaining: "#c084fc",
  credits_usd: "#fbbf24",
  balance_usd: "#34d399",
  balance_cny: "#38bdf8",
  month_cost_usd: "#fb7185",
  premium_used: "#a78bfa",
  premium_remaining: "#34d399",
  auto_used_pct: "#38bdf8",
  api_used_pct: "#a78bfa",
  plan_used_pct: "#34d399",
  requests_used: "#fb7185",
  requests_remaining: "#34d399",
};

const METRIC_FALLBACK = ["#34d399", "#38bdf8", "#a78bfa", "#fbbf24", "#fb7185", "#f472b6", "#2dd4bf", "#818cf8"];

export function metricColor(metric: string): string {
  if (METRIC_COLORS[metric]) return METRIC_COLORS[metric];
  if (metric.startsWith("session_used_pct_")) return "#7dd3fc";
  let h = 0;
  for (let i = 0; i < metric.length; i++) h = (h * 31 + metric.charCodeAt(i)) >>> 0;
  return METRIC_FALLBACK[h % METRIC_FALLBACK.length];
}

export function isPercentMetric(metric: string, unit?: string | null): boolean {
  return unit === "percent" || metric.endsWith("_pct") || metric.includes("_pct_");
}

export function fmtQuotaValue(value: number, unit?: string | null, metric?: string): string {
  if (isPercentMetric(metric ?? "", unit)) return `${value.toFixed(1)}%`;
  if (unit === "usd" || unit === "USD") return "$" + value.toFixed(2);
  if (unit === "cny" || unit === "CNY") return "¥" + value.toFixed(2);
  if (unit === "usd_cents") return (value / 100).toLocaleString("zh-CN", { style: "currency", currency: "USD" });
  if (Number.isInteger(value)) return value.toLocaleString("zh-CN");
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

export function fmtShortTime(iso: string): string {
  const d = parseUtcDate(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

/** 本地日期 key，供 UTC 小时桶在浏览器中按用户时区重新分组。 */
export function localDateKey(iso: string): string {
  const d = parseUtcDate(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function localDayLabel(iso: string): string {
  const d = parseUtcDate(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function timeAgo(iso: string): string {
  const ms = Date.now() - parseUtcDate(iso).getTime();
  if (ms < 0) return "刚刚";
  const min = Math.floor(ms / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

export function resetCountdown(resetAt: string | null): string {
  if (!resetAt) return "";
  const ms = parseUtcDate(resetAt).getTime() - Date.now();
  if (ms <= 0) return "即将重置";
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  return d > 0 ? `${d} 天 ${h} 小时后重置` : `${h} 小时后重置`;
}

export function todayUtcBounds(): { from: string; to: string } {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { from: from.toISOString(), to: new Date(Date.now() + 86400000).toISOString().slice(0, 10) + "T00:00:00Z" };
}

/** 当前用户本地自然日对应的 UTC 查询范围。 */
export function todayLocalUtcBounds(): { from: string; to: string } {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const withoutMilliseconds = (d: Date) => d.toISOString().replace(".000Z", "Z");
  return { from: withoutMilliseconds(from), to: withoutMilliseconds(to) };
}
