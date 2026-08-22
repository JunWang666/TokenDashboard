import { useEffect, useState, type ReactNode } from "react";
import { AuthError, ApiError } from "../api";

interface Props<T> {
  load: () => Promise<T>;
  children: (data: T) => ReactNode;
  /** 刷新间隔 ms，0 = 不自动刷新 */
  refreshMs?: number;
  className?: string;
}

export default function AsyncData<T>({ load, children, refreshMs = 0, className }: Props<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const d = await load();
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setData(null);
          setError(e instanceof AuthError ? "登录已过期" : e instanceof ApiError ? e.message : String(e));
        }
      }
    };
    run();
    if (refreshMs > 0) {
      const t = setInterval(run, refreshMs);
      return () => {
        cancelled = true;
        clearInterval(t);
      };
    }
    return () => {
      cancelled = true;
    };
  }, [load, refreshMs]);

  if (error) {
    return (
      <div className={`rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-300 ${className ?? ""}`}>
        {error}
      </div>
    );
  }
  if (!data) return <div className={`animate-pulse text-sm text-slate-400 dark:text-slate-500 ${className ?? ""}`}>加载中…</div>;
  return <div className={className}>{children(data)}</div>;
}
