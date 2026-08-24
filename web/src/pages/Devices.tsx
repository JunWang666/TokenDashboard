import { useCallback } from "react";
import { api } from "../api";
import AsyncData from "../components/AsyncData";
import { parseUtcDate, timeAgo } from "../format";
import type { DevicesResponse } from "../types";

export default function Devices() {
  const load = useCallback(() => api.devices(), []);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">设备</h1>
        <p className="mt-1 text-sm text-slate-500">各采集设备最近上报时间，发现掉线</p>
      </header>

      <AsyncData<DevicesResponse> load={load} refreshMs={30000}>
        {(data) =>
          data.rows.length === 0 ? (
            <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900/50">
              暂无设备上报
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-900/60">
                    <th className="px-4 py-3 font-medium">设备</th>
                    <th className="px-4 py-3 font-medium">名称</th>
                    <th className="px-4 py-3 font-medium">最近上报</th>
                    <th className="px-4 py-3 font-medium">状态</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((d) => {
                    const ageMs = Date.now() - parseUtcDate(d.last_seen_at).getTime();
                    const stale = ageMs > 24 * 3600 * 1000;
                    const warn = ageMs > 10 * 60 * 1000;
                    return (
                      <tr key={d.device_id} className="border-b border-slate-100 hover:bg-slate-50 dark:border-slate-800/60 dark:hover:bg-slate-900/40">
                        <td className="px-4 py-2.5 font-mono text-xs text-slate-600 dark:text-slate-300">{d.device_id}</td>
                        <td className="px-4 py-2.5">{d.name ?? "—"}</td>
                        <td className="px-4 py-2.5 tabular-nums text-slate-500 dark:text-slate-400">{timeAgo(d.last_seen_at)}</td>
                        <td className="px-4 py-2.5">
                          {stale ? (
                            <span className="text-red-600 dark:text-red-400">掉线</span>
                          ) : warn ? (
                            <span className="text-amber-600 dark:text-amber-400">异常</span>
                          ) : (
                            <span className="text-emerald-600 dark:text-emerald-400">正常</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        }
      </AsyncData>
    </div>
  );
}
