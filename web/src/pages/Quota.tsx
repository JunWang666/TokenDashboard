import { useCallback, useMemo } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "../api";
import AsyncData from "../components/AsyncData";
import { CopyableError, scrapeError } from "../components/QuotaBar";
import {
  PROVIDERS,
  fmtQuotaValue,
  fmtShortTime,
  isPercentMetric,
  metricColor,
  metricLabel,
  providerMeta,
} from "../format";
import { chartPalette, useTheme } from "../theme";
import type { QuotaCurrentRow, QuotaHistoryRow } from "../types";

const HISTORY_DAYS = 14;

type KeyGroup = {
  provider: string;
  account: string;
  current: QuotaCurrentRow[];
  history: QuotaHistoryRow[];
};

function groupKeys(current: QuotaCurrentRow[], history: QuotaHistoryRow[]): KeyGroup[] {
  const map = new Map<string, KeyGroup>();
  const add = (provider: string, account: string) => {
    const id = `${provider}\0${account}`;
    if (!map.has(id)) map.set(id, { provider, account, current: [], history: [] });
    return map.get(id)!;
  };
  for (const r of current) {
    const g = add(r.provider, r.account);
    // scrape_error/scrape_warn 是采集失败占位行（错误信息存在 reset_at），不是指标，不进图表
    if (r.metric !== "scrape_error" && r.metric !== "scrape_warn") g.current.push(r);
  }
  for (const r of history) {
    if (r.metric === "scrape_error" || r.metric === "scrape_warn") continue;
    add(r.provider, r.account).history.push(r);
  }
  const order = new Map(PROVIDERS.map((p, i) => [p.id, i]));
  return [...map.values()]
    .filter((g) => g.current.length > 0 || g.history.length > 0)
    .sort((a, b) => {
      const d = (order.get(a.provider) ?? 99) - (order.get(b.provider) ?? 99);
      return d !== 0 ? d : a.account.localeCompare(b.account, "zh-CN");
    });
}

export default function Quota() {
  const load = useCallback(async () => {
    const from = new Date(Date.now() - HISTORY_DAYS * 86400000).toISOString();
    const [cur, hist] = await Promise.all([api.quotaCurrent(), api.quotaHistory({ from })]);
    return { current: cur.rows, history: hist.rows };
  }, []);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">额度</h1>
        <p className="mt-1 text-sm text-slate-500">每个 Key 一张图，近 {HISTORY_DAYS} 天多指标同图画线</p>
      </header>

      <AsyncData load={load} refreshMs={120000}>
        {({ current, history }) => {
          const keys = groupKeys(current, history);
          if (keys.length === 0) {
            return (
              <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900/50">
                暂无额度快照。配置 runner 凭证后每 15 分钟自动采集。
              </div>
            );
          }
          return (
            <div className="space-y-4">
              {keys.map((g) => (
                <KeyChart key={`${g.provider}/${g.account}`} group={g} allCurrent={current} />
              ))}
            </div>
          );
        }}
      </AsyncData>
    </div>
  );
}

function KeyChart({ group, allCurrent }: { group: KeyGroup; allCurrent: QuotaCurrentRow[] }) {
  const theme = useTheme();
  const pal = chartPalette(theme);
  const meta = providerMeta(group.provider);
  const err = scrapeError(group.provider, allCurrent, group.account);

  const metrics = useMemo(() => {
    const names = new Set<string>();
    for (const r of group.current) names.add(r.metric);
    for (const r of group.history) names.add(r.metric);
    return [...names].sort((a, b) => metricLabel(a).localeCompare(metricLabel(b), "zh-CN"));
  }, [group]);

  const unitOf = (metric: string) =>
    group.current.find((r) => r.metric === metric)?.unit ??
    group.history.find((r) => r.metric === metric)?.unit ??
    null;

  const pctMetrics = metrics.filter((m) => isPercentMetric(m, unitOf(m)));
  const otherMetrics = metrics.filter((m) => !isPercentMetric(m, unitOf(m)));
  const dual = pctMetrics.length > 0 && otherMetrics.length > 0;

  const data = useMemo(() => {
    const byTime = new Map<string, Record<string, number | string>>();
    for (const r of group.history) {
      const d = new Date(r.captured_at);
      if (Number.isNaN(d.getTime())) continue;
      d.setSeconds(0, 0);
      d.setMilliseconds(0);
      const iso = d.toISOString();
      const row = byTime.get(iso) ?? { t: iso, label: fmtShortTime(iso) };
      row[r.metric] = r.value;
      byTime.set(iso, row);
    }
    return [...byTime.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, row]) => row);
  }, [group.history]);

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900/50">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: meta.color }} />
        <span className="text-sm font-medium text-slate-800 dark:text-slate-200">{meta.name}</span>
        {group.account ? (
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            {group.account}
          </span>
        ) : null}
        <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
          {metrics.map((m) => {
            const row = group.current.find((r) => r.metric === m);
            if (!row) return null;
            return (
              <span key={m} className="inline-flex items-center gap-1.5">
                <span className="h-1.5 w-3 rounded-full" style={{ background: metricColor(m) }} />
                <span>{metricLabel(m)}</span>
                <span className="tabular-nums text-slate-700 dark:text-slate-300">
                  {fmtQuotaValue(row.value, row.unit, m)}
                </span>
              </span>
            );
          })}
        </div>
      </div>

      {err && !err.partial && (
        <div className="mb-3 text-sm text-red-600 dark:text-red-400">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">采集失败</span>
            <CopyableError err={err.message} />
          </div>
          <div className="mt-1 break-all text-xs text-red-500/80 dark:text-red-400/70">{err.message}</div>
        </div>
      )}
      {err?.partial && (
        <div className="mb-3 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-amber-700 dark:text-amber-400">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium">部分指标采集失败</span>
            <CopyableError err={err.message} tone="amber" />
          </div>
          <div className="mt-1 break-all text-xs text-amber-600/80 dark:text-amber-400/70">{err.message}</div>
        </div>
      )}

      {data.length === 0 ? (
        <div className="flex h-40 items-center justify-center text-sm text-slate-400 dark:text-slate-600">
          暂无历史快照
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={data} margin={{ top: 8, right: dual ? 12 : 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={pal.grid} vertical={false} />
            <XAxis dataKey="label" tick={{ fill: pal.tick, fontSize: 11 }} tickLine={false} axisLine={{ stroke: pal.grid }} minTickGap={28} />
            {pctMetrics.length > 0 && (
              <YAxis
                yAxisId="pct"
                tick={{ fill: pal.tick, fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                domain={[0, (max: number) => (max > 100 ? Math.ceil(max) : 100)]}
                tickFormatter={(v: number) => `${v}%`}
                width={44}
              />
            )}
            {otherMetrics.length > 0 && (
              <YAxis
                yAxisId="other"
                orientation={dual ? "right" : "left"}
                tick={{ fill: pal.tick, fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                width={52}
                tickFormatter={(v: number) => fmtAxis(v, unitOf(otherMetrics[0]))}
              />
            )}
            <Tooltip
              contentStyle={{ background: pal.tooltipBg, border: `1px solid ${pal.tooltipBorder}`, borderRadius: 8, fontSize: 12 }}
              labelStyle={{ color: pal.tooltipText }}
              formatter={(value, name) => {
                const metric = String(name);
                return [fmtQuotaValue(Number(value ?? 0), unitOf(metric), metric), metricLabel(metric)];
              }}
            />
            <Legend
              wrapperStyle={{ fontSize: 12, paddingTop: 8 }}
              formatter={(value) => metricLabel(String(value))}
            />
            {metrics.map((m) => (
              <Line
                key={m}
                yAxisId={isPercentMetric(m, unitOf(m)) ? "pct" : "other"}
                type="monotone"
                dataKey={m}
                name={m}
                stroke={metricColor(m)}
                strokeWidth={2}
                dot={false}
                connectNulls
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}
    </section>
  );
}

function fmtAxis(v: number, unit: string | null): string {
  if (unit === "usd" || unit === "USD") return `$${v}`;
  if (unit === "cny" || unit === "CNY") return `¥${v}`;
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
}
