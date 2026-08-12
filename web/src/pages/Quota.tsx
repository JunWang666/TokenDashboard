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
import type { QuotaCurrentResponse, QuotaHistoryResponse } from "../types";

export default function Quota() {
  const [quota, setQuota] = useState<QuotaCurrentResponse | null>(null);
  const [selected, setSelected] = useState<{ provider: string; metric: string } | null>(null);

  const loadQuota = useCallback(async () => {
    const q = await api.quotaCurrent();
    setQuota(q);
    setSelected((prev) => {
      if (prev) return prev;
      const first = q.rows[0];
      return first ? { provider: first.provider, metric: first.metric } : null;
    });
    return q;
  }, []);

  const loadHistory = useCallback(() => {
    if (!selected) return Promise.resolve({ rows: [] } as QuotaHistoryResponse);
    return api.quotaHistory(selected.provider, selected.metric);
  }, [selected]);

  const metrics = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const r of quota?.rows ?? []) {
      if (!m.has(r.provider)) m.set(r.provider, new Set());
      m.get(r.provider)!.add(r.metric);
    }
    return m;
  }, [quota]);

  // 快照出现新 (provider, metric) 时自动选中第一项
  useEffect(() => {
    if (!selected && quota?.rows.length) {
      const f = quota.rows[0];
      setSelected({ provider: f.provider, metric: f.metric });
    }
  }, [quota, selected]);

  const by = (p: string, m: string) => quota?.rows.find((r) => r.provider === p && r.metric === m);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold">额度</h1>
        <p className="mt-1 text-sm text-slate-500">各指标历史曲线，观察额度消耗速率</p>
      </header>

      <AsyncData load={loadQuota} refreshMs={120000}>
        {() => (
          <div className="space-y-6">
            {quota && quota.rows.length === 0 && (
              <div className="rounded-lg border border-slate-800 bg-slate-900/50 px-4 py-3 text-sm text-slate-500">
                暂无额度快照。配置 runner 凭证后每 15 分钟自动采集。
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              {[...metrics.entries()].map(([provider, metricSet]) => (
                <div key={provider} className="flex flex-wrap items-center gap-1.5">
                  {[...metricSet].map((metric) => {
                    const active = selected?.provider === provider && selected?.metric === metric;
                    return (
                      <button
                        key={metric}
                        onClick={() => setSelected({ provider, metric })}
                        className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                          active
                            ? "border-emerald-500 bg-emerald-500/10 text-emerald-300"
                            : "border-slate-700 text-slate-400 hover:border-slate-500"
                        }`}
                      >
                        {provider}:{metric}
                        {by(provider, metric)?.unit === "percent" && by(provider, metric)?.value != null
                          ? ` (${by(provider, metric)!.value}%)`
                          : ""}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>

            {selected && (
              <AsyncData<QuotaHistoryResponse> load={loadHistory} refreshMs={120000}>
                {(hist) => (
                  <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
                    <div className="mb-2 text-sm text-slate-400">
                      {selected.provider} · {selected.metric} · 共 {hist.rows.length} 个快照
                      {by(selected.provider, selected.metric)?.unit === "error" && (
                        <span className="ml-2 text-red-400">采集失败：{by(selected.provider, selected.metric)?.reset_at}</span>
                      )}
                    </div>
                    <ResponsiveContainer width="100%" height={320}>
                      <LineChart data={hist.rows.map((r) => ({ ...r, label: fmtShortTime(r.captured_at) }))} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                        <XAxis dataKey="label" tick={{ fill: "#64748b", fontSize: 11 }} tickLine={false} axisLine={{ stroke: "#1e293b" }} />
                        <YAxis tick={{ fill: "#64748b", fontSize: 11 }} tickLine={false} axisLine={false} />
                        <Tooltip
                          contentStyle={{ background: "#0f172a", border: "1px solid #334155", borderRadius: 8, fontSize: 12 }}
                          labelStyle={{ color: "#e2e8f0" }}
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
                )}
              </AsyncData>
            )}
          </div>
        )}
      </AsyncData>
    </div>
  );
}
