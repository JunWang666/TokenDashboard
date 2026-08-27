import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { PROVIDERS, fmtTokens, parseUtcDate, providerColor } from "../format";
import { chartPalette, useTheme } from "../theme";
import type { TimeseriesResponse } from "../types";

/** Overview 首屏：今日逐小时用量堆叠柱状图（懒加载，不进主 bundle） */
export default function TodayChart({ ts }: { ts: TimeseriesResponse }) {
  const theme = useTheme();
  const pal = chartPalette(theme);

  const seriesNames = useMemo(() => {
    const seen = new Set(ts.rows.map((r) => r.series));
    // 已知服务商固定顺序；新采集器（如 Gemini/OpenCode）也要显示。
    const order = new Map(PROVIDERS.map((p, i) => [p.id, i]));
    return [...seen].sort((a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER));
  }, [ts]);

  const data = useMemo(() => {
    const byHour = new Map<string, Record<string, number>>();
    for (const r of ts.rows) {
      const d = parseUtcDate(r.time);
      if (Number.isNaN(d.getTime())) continue;
      const hour = `${String(d.getHours()).padStart(2, "0")}时`;
      const row = byHour.get(hour) ?? {};
      row[r.series] = (row[r.series] ?? 0) + r.input_tokens + r.output_tokens;
      byHour.set(hour, row);
    }
    return [...byHour.entries()].map(([label, series]) => ({ label, ...series }));
  }, [ts]);

  if (data.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-slate-400 dark:text-slate-600">
        今日还没有用量记录，客户端上报后自动出现
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={pal.grid} vertical={false} />
        <XAxis dataKey="label" tick={{ fill: pal.tick, fontSize: 11 }} tickLine={false} axisLine={{ stroke: pal.grid }} />
        <YAxis
          tick={{ fill: pal.tick, fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: number) => fmtTokens(v)}
          width={48}
        />
        <Tooltip
          contentStyle={{ background: pal.tooltipBg, border: `1px solid ${pal.tooltipBorder}`, borderRadius: 8, fontSize: 12 }}
          labelStyle={{ color: pal.tooltipText }}
          formatter={(value, name) => [fmtTokens(Number(value ?? 0)), name]}
        />
        {seriesNames.map((s) => (
          <Bar key={s} dataKey={s} stackId="a" fill={providerColor(s)} maxBarSize={28} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
