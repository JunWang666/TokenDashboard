import type { Env } from "./index";
import { dispatchPush } from "./push";
import { dispatchNotify } from "./notify";

/** 单条额度快照（alert 判定用到的字段） */
export interface Snapshot {
  value: number;
  unit: string | null;
  reset_at: string | null;
  captured_at: string;
}

/** 同一 (provider, metric, account) 的最近两条快照；prev 为首轮采集时为 null */
export interface SnapshotPair {
  provider: string;
  metric: string;
  account: string;
  prev: Snapshot | null;
  latest: Snapshot;
}

export interface AlertConfig {
  enabled: boolean;
  /** 已用百分比越过该阈值时触发 quota_low */
  lowThresholdPct: number;
  /** reset_at 距现在不超过该分钟数时触发 reset_soon */
  resetSoonMinutes: number;
}

export type AlertKind = "quota_low" | "reset_soon" | "reset_done";

export interface AlertEvent {
  dedupeKey: string;
  kind: AlertKind;
  provider: string;
  metric: string;
  account: string;
  title: string;
  body: string;
}

const SKIP_METRICS = new Set(["scrape_error", "scrape_warn"]);

const KEY_ENABLED = "alert_enabled";
const KEY_LOW_PCT = "alert_low_threshold_pct";
const KEY_SOON_MIN = "alert_reset_soon_minutes";

/** 读告警配置：未写入 settings 表时用默认值（开 / 90% / 60 分钟） */
export async function readAlertConfig(env: Env): Promise<AlertConfig> {
  const { results } = await env.DB.prepare(`SELECT key, value FROM settings WHERE key IN (?, ?, ?)`)
    .bind(KEY_ENABLED, KEY_LOW_PCT, KEY_SOON_MIN)
    .all<{ key: string; value: string }>();
  const m: Record<string, string> = {};
  for (const r of results) m[r.key] = r.value;
  const num = (v: string | undefined, dft: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : dft;
  };
  return {
    enabled: (m[KEY_ENABLED] ?? "1") !== "0",
    lowThresholdPct: num(m[KEY_LOW_PCT], 90),
    resetSoonMinutes: num(m[KEY_SOON_MIN], 60),
  };
}

function providerLabel(provider: string): string {
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function isPercent(s: Snapshot, metric: string): boolean {
  return s.unit === "percent" || metric.includes("_pct");
}

/** 纯函数：对每个 (provider, metric, account) 的最近两条快照评估三类告警。
 *  dedupe_key 设计目标：同一重置周期内 quota_low 只发一次；reset_soon 按 reset_at 去重；
 *  reset_done 按小时桶去重（避免 15 分钟一轮的 cron 重复推送）。 */
export function evaluate(pairs: SnapshotPair[], cfg: AlertConfig, now: number): AlertEvent[] {
  if (!cfg.enabled) return [];
  const out: AlertEvent[] = [];
  for (const { provider, metric, account, prev, latest } of pairs) {
    if (SKIP_METRICS.has(metric)) continue;
    const label = providerLabel(provider);
    const pct = isPercent(latest, metric);
    const base = `${provider}|${metric}|${account}`;

    // 额度快用完：百分比指标上穿阈值（上升沿，prev 已在阈值之上不再重复）
    if (pct && prev && prev.value < cfg.lowThresholdPct && latest.value >= cfg.lowThresholdPct) {
      out.push({
        dedupeKey: `low|${base}|${latest.reset_at ?? "nr"}`,
        kind: "quota_low",
        provider,
        metric,
        account,
        title: `${label} 额度快用完`,
        body: `${metric} 已用 ${Math.round(latest.value)}%`,
      });
    }

    // 额度即将刷新：reset_at 落在 (now, now + resetSoonMinutes] 内
    if (latest.reset_at) {
      const diff = Date.parse(latest.reset_at) - now;
      if (diff > 0 && diff <= cfg.resetSoonMinutes * 60_000) {
        out.push({
          dedupeKey: `soon|${base}|${latest.reset_at}`,
          kind: "reset_soon",
          provider,
          metric,
          account,
          title: `${label} 额度即将刷新`,
          body: `${metric} 约 ${Math.round(diff / 60_000)} 分钟后重置`,
        });
      }
    }

    // 额度已刷新：高用量骤降（百分比指标，跨周期回落）
    if (pct && prev && prev.value >= 80 && latest.value <= prev.value - 30) {
      out.push({
        dedupeKey: `done|${base}|${latest.captured_at.slice(0, 13)}`,
        kind: "reset_done",
        provider,
        metric,
        account,
        title: `${label} 额度已刷新`,
        body: `${metric} 从 ${Math.round(prev.value)}% 回落至 ${Math.round(latest.value)}%`,
      });
    }
  }
  return out;
}

/** cron 后扫一轮：取每个 (provider, metric, account) 最近两条快照，评估告警并推送新事件 */
export async function runAlertSweep(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT provider, metric, account, value, unit, reset_at, captured_at,
            ROW_NUMBER() OVER (
              PARTITION BY provider, metric, account ORDER BY captured_at DESC, id DESC
            ) AS rn
       FROM quota_snapshots`,
  ).all<{
    provider: string;
    metric: string;
    account: string | null;
    value: number;
    unit: string | null;
    reset_at: string | null;
    captured_at: string;
    rn: number;
  }>();

  // 按分组拼 prev/latest
  const pairs = new Map<string, SnapshotPair>();
  for (const r of results) {
    if (r.rn > 2) continue;
    const k = `${r.provider}|${r.metric}|${r.account ?? ""}`;
    let p = pairs.get(k);
    if (!p) {
      p = { provider: r.provider, metric: r.metric, account: r.account ?? "", prev: null, latest: r };
      pairs.set(k, p);
    }
    if (r.rn === 1) p.latest = r;
    else p.prev = r;
  }

  const cfg = await readAlertConfig(env);
  const events = evaluate([...pairs.values()], cfg, Date.now());
  const fresh: AlertEvent[] = [];
  for (const e of events) {
    const r = await env.DB.prepare(
      `INSERT OR IGNORE INTO alert_events (dedupe_key, kind, provider, metric, account, title, body)
       VALUES (?,?,?,?,?,?,?)`,
    )
      .bind(e.dedupeKey, e.kind, e.provider, e.metric, e.account, e.title, e.body)
      .run();
    if (r.meta.changes > 0) fresh.push(e); // 已存在（本周期推过）则跳过
  }

  if (fresh.length > 0) {
    try {
      await dispatchPush(env, fresh);
    } catch (e) {
      console.error("tokendash dispatch push:", e); // 推送失败不影响采集主流程
    }
    try {
      await dispatchNotify(env, fresh); // 飞书 webhook / Bark 等第三方渠道
    } catch (e) {
      console.error("tokendash dispatch notify:", e);
    }
  }
}
