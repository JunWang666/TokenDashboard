import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "../api";
import AsyncData from "../components/AsyncData";
import { fmtShortTime, providerColor } from "../format";
import { chartPalette, useTheme } from "../theme";
import type { QuotaCurrentResponse, QuotaHistoryResponse } from "../types";

export default function Quota() {
  const [quota, setQuota] = useState<QuotaCurrentResponse | null>(null);
  const [selected, setSelected] = useState<{ provider: string; metric: string; account: string } | null>(null);

  const loadQuota = useCallback(async () => {
    const q = await api.quotaCurrent();
    // scrape_error 是采集失败占位行（错误信息存在 reset_at），不是指标，不进图表
    const rows = q.rows.filter((r) => r.metric !== "scrape_error");
    setQuota({ rows });
    setSelected((prev) => {
      if (prev) return prev;
      const first = rows[0];
      return first ? { provider: first.provider, metric: first.metric, account: first.account } : null;
    });
    return q;
  }, []);

  const loadHistory = useCallback(() => {
    if (!selected) return Promise.resolve({ rows: [] } as QuotaHistoryResponse);
    return api.quotaHistory(selected.provider, selected.metric, selected.account);
  }, [selected]);

  // 可选指标：provider + account + metric 组合
  const groups = useMemo(() => {
    const m = new Map<string, { provider: string; account: string; metrics: Set<string> }>();
    for (const r of quota?.rows ?? []) {
      const key = `${r.provider}${r.account}`;
      if (!m.has(key)) m.set(key, { provider: r.provider, account: r.account, metrics: new Set() });
      m.get(key)!.metrics.add(r.metric);
    }
    return [...m.values()];
  }, [quota]);

  // 快照出现新组合时自动选中第一项
  useEffect(() => {
    if (!selected && quota?.rows.length) {
      const f = quota.rows[0];
      setSelected({ provider: f.provider, metric: f.metric, account: f.account });
    }
  }, [quota, selected]);

  const by = (p: string, m: string, a: string) =>
    quota?.rows.find((r) => r.provider === p && r.metric === m && r.account === a);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">额度</h1>
        <p className="mt-1 text-sm text-slate-500">各指标历史曲线，观察额度消耗速率</p>
      </header>

      <AsyncData load={loadQuota} refreshMs={120000}>
        {() => (
          <div className="space-y-6">
            {quota && quota.rows.length === 0 && (
              <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900/50">
                暂无额度快照。配置 runner 凭证后每 15 分钟自动采集。
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              {groups.map(({ provider, account, metrics: metricSet }) => (
                <div key={`${provider}/${account}`} className="flex flex-wrap items-center gap-1.5">
                  {[...metricSet].map((metric) => {
                    const active =
                      selected?.provider === provider && selected?.metric === metric && selected?.account === account;
                    return (
                      <button
                        key={metric}
                        onClick={() => setSelected({ provider, metric, account })}
                        className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                          active
                            ? "border-emerald-500 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                            : "border-slate-300 text-slate-500 hover:border-slate-400 dark:border-slate-700 dark:text-slate-400 dark:hover:border-slate-500"
                        }`}
                      >
                        {provider}{account ? ` · ${account}` : ""}:{metric}
                        {by(provider, metric, account)?.unit === "percent" && by(provider, metric, account)?.value != null
                          ? ` (${by(provider, metric, account)!.value}%)`
                          : ""}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>

            {selected && (
              <AsyncData<QuotaHistoryResponse> load={loadHistory} refreshMs={120000}>
                {(hist) => <HistoryChart hist={hist} selected={selected} />}
              </AsyncData>
            )}
          </div>
        )}
      </AsyncData>
    </div>
  );
}

function HistoryChart({
  hist,
  selected,
}: {
  hist: QuotaHistoryResponse;
  selected: { provider: string; metric: string; account: string };
}) {
  const theme = useTheme();
  const pal = chartPalette(theme);
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900/50">
      <div className="mb-2 text-sm text-slate-500 dark:text-slate-400">
        {selected.provider}
        {selected.account ? ` · ${selected.account}` : ""} · {selected.metric} · 共 {hist.rows.length} 个快照
      </div>
      <ResponsiveContainer width="100%" height={320}>
        <LineChart data={hist.rows.map((r) => ({ ...r, label: fmtShortTime(r.captured_at) }))} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={pal.grid} vertical={false} />
          <XAxis dataKey="label" tick={{ fill: pal.tick, fontSize: 11 }} tickLine={false} axisLine={{ stroke: pal.grid }} />
          <YAxis tick={{ fill: pal.tick, fontSize: 11 }} tickLine={false} axisLine={false} />
          <Tooltip
            contentStyle={{ background: pal.tooltipBg, border: `1px solid ${pal.tooltipBorder}`, borderRadius: 8, fontSize: 12 }}
            labelStyle={{ color: pal.tooltipText }}
            formatter={(value) => [Number(value ?? 0), selected.metric]}
          />
          <Line
            type="monotone"
            dataKey="value"
            stroke={providerColor(selected.provider)}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
