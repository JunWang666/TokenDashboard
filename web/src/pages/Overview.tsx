import { useCallback, useMemo, useState } from "react";
import { api, AuthError } from "../api";
import AsyncData from "../components/AsyncData";
import QuotaBar, { quotaDisplay, scrapeError } from "../components/QuotaBar";
import { PROVIDERS, fmtTokens, fmtUsd, todayUtcBounds } from "../format";
import type { QuotaCurrentResponse, TimeseriesResponse } from "../types";

export default function Overview({ onAuthError }: { onAuthError: (msg: string) => void }) {
  const { from, to } = useMemo(todayUtcBounds, []);
  const loadToday = useCallback(() => api.timeseries({ from, to, interval: "hour", groupBy: "provider" }), [from, to]);
  const loadQuota = useCallback(() => api.quotaCurrent(), []);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold">总览</h1>
        <p className="mt-1 text-sm text-slate-500">今日用量与各 plan 额度</p>
      </header>

      <AsyncData<TimeseriesResponse> load={loadToday} refreshMs={60000}>
        {(ts) => <TodayStats ts={ts} onAuthError={onAuthError} />}
      </AsyncData>

      <section>
        <h2 className="mb-3 text-sm font-medium text-slate-400">额度</h2>
        <AsyncData<QuotaCurrentResponse> load={loadQuota} refreshMs={120000}>
          {(quota) => (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {PROVIDERS.map((p) => {
                const q = quotaDisplay(p.id, quota.rows);
                const err = scrapeError(p.id, quota.rows);
                return (
                  <div key={p.id} className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
                    <div className="mb-3 flex items-center gap-2">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ background: p.color }} />
                      <span className="text-sm font-medium">{p.name}</span>
                    </div>
                    {err ? (
                      <div className="text-sm text-red-400">
                        <div className="font-medium">采集失败</div>
                        <div className="mt-1 text-xs text-red-400/70">{err}</div>
                      </div>
                    ) : q ? (
                      <QuotaBar q={q} />
                    ) : (
                      <div className="text-sm text-slate-600">暂无数据（未配置凭证或尚未采集）</div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </AsyncData>
      </section>
    </div>
  );
}

function TodayStats({ ts, onAuthError }: { ts: TimeseriesResponse; onAuthError: (m: string) => void }) {
  const byProvider = useMemo(() => {
    const m = new Map<string, { tokens: number; cost: number; requests: number }>();
    for (const r of ts.rows) {
      const cur = m.get(r.series) ?? { tokens: 0, cost: 0, requests: 0 };
      cur.tokens += r.input_tokens + r.output_tokens;
      cur.cost += r.cost_usd;
      cur.requests += r.requests;
      m.set(r.series, cur);
    }
    return m;
  }, [ts]);

  const total = useMemo(() => {
    let tokens = 0;
    let cost = 0;
    for (const v of byProvider.values()) {
      tokens += v.tokens;
      cost += v.cost;
    }
    return { tokens, cost };
  }, [byProvider]);

  return (
    <section className="grid grid-cols-2 gap-4 md:grid-cols-4">
      <Stat label="今日总 token" value={fmtTokens(total.tokens)} sub={`${total.tokens.toLocaleString()} 精确值`} />
      <Stat label="今日估算花费" value={fmtUsd(total.cost)} sub="按价目表估算" />
      {["claude", "openai", "deepseek", "cursor"].map((p) => {
        const v = byProvider.get(p);
        return (
          <Stat
            key={p}
            label={p === "openai" ? "OpenAI 今日" : p === "cursor" ? "Cursor 今日" : p === "deepseek" ? "DeepSeek 今日" : "Claude 今日"}
            value={v ? fmtTokens(v.tokens) : "—"}
            sub={v ? `${v.requests} 次请求` : "今日无记录"}
          />
        );
      })}
    </section>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1.5 text-2xl font-semibold">{value}</div>
      {sub && <div className="mt-1 text-xs text-slate-600">{sub}</div>}
    </div>
  );
}
