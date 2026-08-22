export const PROVIDERS: { id: string; name: string; color: string }[] = [
  { id: "claude", name: "Claude", color: "#d97757" },
  { id: "codex", name: "Codex", color: "#14b8a6" },
  { id: "kimi", name: "Kimi", color: "#d946ef" },
  { id: "openai", name: "OpenAI", color: "#10a37f" },
  { id: "copilot", name: "GitHub Copilot", color: "#8957e5" },
  { id: "glm", name: "GLM", color: "#3b82f6" },
  { id: "deepseek", name: "DeepSeek", color: "#6366f1" },
  { id: "cursor", name: "Cursor", color: "#e8b339" },
];

export const providerMeta = (id: string) => PROVIDERS.find((p) => p.id === id) ?? { id, name: id, color: "#94a3b8" };

export const providerColor = (id: string) => providerMeta(id).color;

/** 每个 provider 在 Overview 上展示的主额度指标 */
export function primaryQuotaMetric(provider: string): string {
  switch (provider) {
    case "claude":
      return "weekly_used_pct";
    case "codex":
    case "kimi":
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

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("zh-CN", { hour12: false });
}

export function fmtShortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

export function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
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
  const ms = new Date(resetAt).getTime() - Date.now();
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
