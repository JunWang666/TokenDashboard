const MINUTE_MS = 60_000;

/** Cron 每 15 分钟采集；允许偶发漏掉一轮，超过 30 分钟则视为断档。 */
export const QUOTA_MAX_CONTINUOUS_GAP_MS = 30 * MINUTE_MS;

export interface QuotaChartPoint {
  capturedAt: number;
  metric: string;
  value: number;
}

export type QuotaChartDatum = {
  t: number;
  [metric: string]: number | null;
};

/**
 * 将额度快照合并到分钟粒度，并在过长的采集间隔中插入全 null 点。
 * Recharts 遇到该点会断开每条折线，而不是在停采前后直接插值。
 */
export function buildQuotaChartData(
  points: QuotaChartPoint[],
  maxContinuousGapMs = QUOTA_MAX_CONTINUOUS_GAP_MS,
): QuotaChartDatum[] {
  const byTime = new Map<number, QuotaChartDatum>();
  const metrics = new Set<string>();

  for (const point of points) {
    if (!Number.isFinite(point.capturedAt) || !Number.isFinite(point.value)) continue;
    const t = Math.floor(point.capturedAt / MINUTE_MS) * MINUTE_MS;
    const row = byTime.get(t) ?? { t };
    row[point.metric] = point.value;
    byTime.set(t, row);
    metrics.add(point.metric);
  }

  const rows = [...byTime.values()].sort((a, b) => a.t - b.t);
  if (rows.length < 2) return rows;

  const result: QuotaChartDatum[] = [rows[0]];
  for (let i = 1; i < rows.length; i++) {
    const previous = rows[i - 1];
    const current = rows[i];
    const gap = current.t - previous.t;

    if (gap > maxContinuousGapMs) {
      const gapPoint: QuotaChartDatum = { t: previous.t + gap / 2 };
      for (const metric of metrics) gapPoint[metric] = null;
      result.push(gapPoint);
    }
    result.push(current);
  }

  return result;
}
