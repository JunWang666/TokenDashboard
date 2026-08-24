import { useCallback, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "../api";
import AsyncData from "../components/AsyncData";
import { fmtTokens, fmtUsd, localDateKey, localDayLabel, parseUtcDate, providerColor } from "../format";
import { chartPalette, useTheme } from "../theme";
import type { TimeseriesResponse } from "../types";

const SELECT_CLS =
  "rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-slate-700 outline-none focus:border-emerald-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300";

const hourToLocal = (iso: string) => {
  const d = parseUtcDate(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}时`;
};
const dayToLocal = (iso: string) => localDayLabel(iso);

export default function Usage() {
  const [interval, setInterval] = useState<"hour" | "day">("day");
  const [groupBy, setGroupBy] = useState<"provider" | "model">("provider");
  const [days, setDays] = useState(14);
  const [metric, setMetric] = useState<"tokens" | "cost">("tokens");

  const bounds = useMemo(() => {
    const now = new Date();
    const from = new Date(now.getTime() - days * 86400000).toISOString();
    return { from, to: now.toISOString() };
  }, [days]);

  const load = useCallback(
    // 日视图需要从 UTC 小时桶重新按本地日期分组，否则服务端按 UTC 日期聚合后无法修正跨日边界。
    () => api.timeseries({ from: bounds.from, to: bounds.to, interval: interval === "day" ? "hour" : interval, groupBy }),
    [bounds, interval, groupBy],
  );

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">用量</h1>
          <p className="mt-1 text-sm text-slate-500">按服务商 / 模型堆叠的时间序列</p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <select
            value={interval}
            onChange={(e) => setInterval(e.target.value as "hour" | "day")}
            className={SELECT_CLS}
          >
            <option value="day">按天</option>
            <option value="hour">按小时</option>
          </select>
          <select
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value as "provider" | "model")}
            className={SELECT_CLS}
          >
            <option value="provider">按服务商</option>
            <option value="model">按模型</option>
          </select>
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className={SELECT_CLS}
          >
            <option value={7}>近 7 天</option>
            <option value={14}>近 14 天</option>
            <option value={30}>近 30 天</option>
          </select>
          <select
            value={metric}
            onChange={(e) => setMetric(e.target.value as "tokens" | "cost")}
            className={SELECT_CLS}
          >
            <option value="tokens">Token</option>
            <option value="cost">花费</option>
          </select>
        </div>
      </header>

      <AsyncData<TimeseriesResponse> load={load} refreshMs={120000}>
        {(ts) => <Chart ts={ts} metric={metric} interval={interval} groupBy={groupBy} />}
      </AsyncData>
    </div>
  );
}

function Chart({ ts, metric, interval, groupBy }: { ts: TimeseriesResponse; metric: string; interval: string; groupBy: string }) {
  const theme = useTheme();
  const pal = chartPalette(theme);
  const seriesNames = useMemo(() => [...new Set(ts.rows.map((r) => r.series))], [ts]);

  const data = useMemo(() => {
    const byTime = new Map<string, { label: string; series: Record<string, number> }>();
    for (const r of ts.rows) {
      const label = interval === "day" ? dayToLocal(r.time) : hourToLocal(r.time);
      const key = interval === "day" ? localDateKey(r.time) : r.time;
      if (!key) continue;
      const row = byTime.get(key) ?? { label, series: {} };
      const v = metric === "cost" ? r.cost_usd : r.input_tokens + r.output_tokens;
      row.series[r.series] = (row.series[r.series] ?? 0) + v;
      byTime.set(key, row);
    }
    return [...byTime.values()].map(({ label, series }) => ({ label, ...series }));
  }, [ts, interval, metric]);

  const totals = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of ts.rows) {
      const v = metric === "cost" ? r.cost_usd : r.input_tokens + r.output_tokens;
      m.set(r.series, (m.get(r.series) ?? 0) + v);
    }
    return m;
  }, [ts, metric]);

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900/50">
        <ResponsiveContainer width="100%" height={340}>
          <BarChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={pal.grid} vertical={false} />
            <XAxis dataKey="label" tick={{ fill: pal.tick, fontSize: 11 }} tickLine={false} axisLine={{ stroke: pal.grid }} />
            <YAxis
              tick={{ fill: pal.tick, fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => (metric === "cost" ? `$${v}` : fmtTokens(v))}
            />
            <Tooltip
              contentStyle={{ background: pal.tooltipBg, border: `1px solid ${pal.tooltipBorder}`, borderRadius: 8, fontSize: 12 }}
              labelStyle={{ color: pal.tooltipText }}
              formatter={(value, name) => {
                const v = Number(value ?? 0);
                return [metric === "cost" ? fmtUsd(v) : fmtTokens(v), name];
              }}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {seriesNames.map((s) => (
              <Bar key={s} dataKey={s} stackId="a" fill={providerColor(s)} radius={[0, 0, 0, 0]} maxBarSize={32} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-900/60">
              <th className="px-4 py-3 font-medium">{groupBy === "provider" ? "服务商" : "模型"}</th>
              <th className="px-4 py-3 text-right font-medium">总 token</th>
              <th className="px-4 py-3 text-right font-medium">输入</th>
              <th className="px-4 py-3 text-right font-medium">输出</th>
              <th className="px-4 py-3 text-right font-medium">缓存读</th>
              <th className="px-4 py-3 text-right font-medium">缓存写</th>
              <th className="px-4 py-3 text-right font-medium">请求数</th>
              <th className="px-4 py-3 text-right font-medium">估算花费</th>
            </tr>
          </thead>
          <tbody>
            {[...totals.entries()].map(([series, total]) => {
              const r = ts.rows.filter((x) => x.series === series).reduce(
                (acc, x) => {
                  acc.input += x.input_tokens;
                  acc.output += x.output_tokens;
                  acc.cr += x.cache_read_tokens;
                  acc.cw += x.cache_write_tokens;
                  acc.req += x.requests;
                  acc.cost += x.cost_usd;
                  return acc;
                },
                { input: 0, output: 0, cr: 0, cw: 0, req: 0, cost: 0 },
              );
              return (
                <tr key={series} className="border-b border-slate-100 hover:bg-slate-50 dark:border-slate-800/60 dark:hover:bg-slate-900/40">
                  <td className="px-4 py-2.5">
                    <span className="mr-2 inline-block h-2 w-2 rounded-full" style={{ background: providerColor(series) }} />
                    {series}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{fmtTokens(total)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{fmtTokens(r.input)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{fmtTokens(r.output)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-400 dark:text-slate-500">{fmtTokens(r.cr)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-400 dark:text-slate-500">{fmtTokens(r.cw)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{r.req.toLocaleString()}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-emerald-600 dark:text-emerald-300">{fmtUsd(r.cost)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
