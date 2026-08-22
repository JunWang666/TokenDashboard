import { lazy, Suspense, useCallback, useMemo, useState } from "react";
import { api, AuthError } from "../api";
import AsyncData from "../components/AsyncData";
import QuotaBar, { quotaDisplay, scrapeError, CopyableError } from "../components/QuotaBar";
import { PROVIDERS, fmtTokens, fmtUsd } from "../format";
import type { BootstrapResponse, TimeseriesResponse } from "../types";

// 图表库单独分包，不进首屏主 bundle
const TodayChart = lazy(() => import("../components/TodayChart"));

export default function Overview({ onAuthError }: { onAuthError: (msg: string) => void }) {
  // tick 变化 → load 引用变化 → AsyncData 重新拉取
  const [tick, setTick] = useState(0);
  const load = useCallback(() => api.bootstrap(), [tick]);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">总览</h1>
          <p className="mt-1 text-sm text-slate-500">今日用量与各 plan 额度</p>
        </div>
        <CollectButton onDone={() => setTick((t) => t + 1)} />
      </header>

      <AsyncData<BootstrapResponse> load={load} refreshMs={60000}>
        {(data) => (
          <>
            <TodayStats ts={data.ts} onAuthError={onAuthError} />
            <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900/50">
              <h2 className="mb-3 text-sm font-medium text-slate-500 dark:text-slate-400">今日逐小时用量</h2>
              <Suspense fallback={<div className="h-40 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800/50" />}>
                <TodayChart ts={data.ts} />
              </Suspense>
            </section>
            <section>
              <h2 className="mb-3 text-sm font-medium text-slate-500 dark:text-slate-400">额度</h2>
              {data.quota.rows.length === 0 && (
                <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900/50">
                  暂无额度数据，请先在「凭证管理」配置 key，或点右上角「立即采集」
                </div>
              )}
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {PROVIDERS.flatMap((p) => {
                  // 每把 key（account）一张卡；该服务商完全没有快照时不渲染卡片
                  const accounts = [
                    ...new Set(data.quota.rows.filter((r) => r.provider === p.id).map((r) => r.account)),
                  ].sort();
                  if (accounts.length === 0) return [];
                  return accounts.map((account) => {
                    const qs = quotaDisplay(p.id, data.quota.rows, account);
                    const err = scrapeError(p.id, data.quota.rows, account);
                    return (
                      <div key={`${p.id}/${account}`} className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900/50">
                        <div className="mb-3 flex items-center gap-2">
                          <span className="h-2.5 w-2.5 rounded-full" style={{ background: p.color }} />
                          <span className="text-sm font-medium text-slate-800 dark:text-slate-200">{p.name}</span>
                          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400">{account}</span>
                        </div>
                        {err ? (
                          <div className="text-sm text-red-600 dark:text-red-400">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-medium">采集失败</span>
                              <CopyableError err={err} />
                            </div>
                            <div className="mt-1 break-all text-xs text-red-500/80 dark:text-red-400/70">{err}</div>
                          </div>
                        ) : qs.length ? (
                          <div className="space-y-3">
                            {qs.map((q) => (
                              <QuotaBar key={q.label} q={q} />
                            ))}
                          </div>
                        ) : (
                          <div className="text-sm text-slate-400 dark:text-slate-600">暂无数据（未配置凭证或尚未采集）</div>
                        )}
                      </div>
                    );
                  });
                })}
              </div>
            </section>
          </>
        )}
      </AsyncData>
    </div>
  );
}

function CollectButton({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.collect();
      if (!r.ok) throw new Error(r.error ?? "采集失败");
      setMsg(`已采集 ${r.rows ?? 0} 条`);
      onDone();
    } catch (e) {
      setMsg(e instanceof AuthError ? "登录已过期" : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      {msg && <span className="text-xs text-slate-400 dark:text-slate-500">{msg}</span>}
      <button
        onClick={run}
        disabled={busy}
        className="flex items-center gap-1.5 rounded-lg border border-emerald-500/50 px-3 py-1.5 text-sm text-emerald-600 transition-colors hover:bg-emerald-500/10 disabled:opacity-40 dark:text-emerald-400"
      >
        <svg
          viewBox="0 0 20 20"
          className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M17 10a7 7 0 11-2.05-4.95M17 3v4h-4" />
        </svg>
        {busy ? "采集中…" : "立即采集"}
      </button>
    </div>
  );
}

function TodayStats({ ts, onAuthError }: { ts: TimeseriesResponse; onAuthError: (m: string) => void }) {
  const total = useMemo(() => {
    let tokens = 0;
    let cost = 0;
    for (const r of ts.rows) {
      tokens += r.input_tokens + r.output_tokens;
      cost += r.cost_usd;
    }
    return { tokens, cost };
  }, [ts]);

  return (
    <section className="grid grid-cols-2 gap-4">
      <Stat label="今日总 token" value={fmtTokens(total.tokens)} sub={`${total.tokens.toLocaleString()} 精确值`} />
      <Stat label="今日估算花费" value={fmtUsd(total.cost)} sub="按价目表估算" />
    </section>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900/50">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1.5 text-2xl font-semibold text-slate-900 dark:text-slate-100">{value}</div>
      {sub && <div className="mt-1 text-xs text-slate-400 dark:text-slate-600">{sub}</div>}
    </div>
  );
}
