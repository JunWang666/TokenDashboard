import type {
  BootstrapResponse,
  CredentialsResponse,
  DevicesResponse,
  QuotaCurrentResponse,
  QuotaHistoryResponse,
  SummaryResponse,
  TimeseriesResponse,
} from "./types";

export class AuthError extends Error {
  constructor() {
    super("未登录或登录已过期，请重新通过 Cloudflare Access 登录");
    this.name = "AuthError";
  }
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, detail: string) {
    super(`请求失败 (${status}): ${detail.slice(0, 300)}`);
    this.name = "ApiError";
    this.status = status;
  }
}

// 生产：VITE_HUB_URL 指向 hub 域（跨域，Access cookie 同 team 共享）
// 本地开发：相对路径走 vite proxy → http://localhost:8787
const HUB_URL = (import.meta.env.VITE_HUB_URL as string | undefined)?.replace(/\/+$/, "") ?? "";
const base = HUB_URL || "";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(init?.body ? { "Content-Type": "application/json" } : {}),
  };
  const res = await fetch(`${base}${path}`, { ...init, headers, credentials: "include" });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return res.json() as Promise<T>;
}

const q = (params: Record<string, string | undefined>) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") sp.set(k, v);
  const s = sp.toString();
  return s ? `?${s}` : "";
};

export const api = {
  bootstrap: () => req<BootstrapResponse>(`/api/v1/bootstrap`),
  summary: (from?: string, to?: string, groupBy?: string) =>
    req<SummaryResponse>(`/api/v1/summary${q({ from, to, group_by: groupBy })}`),
  timeseries: (params: { from?: string; to?: string; interval?: string; groupBy?: string }) =>
    req<TimeseriesResponse>(
      `/api/v1/usage/timeseries${q({ from: params.from, to: params.to, interval: params.interval, group_by: params.groupBy })}`,
    ),
  quotaCurrent: () => req<QuotaCurrentResponse>(`/api/v1/quota/current`),
  quotaHistory: (provider: string, metric: string, account?: string) =>
    req<QuotaHistoryResponse>(`/api/v1/quota/history${q({ provider, metric, account })}`),
  devices: () => req<DevicesResponse>(`/api/v1/devices`),
  credentials: () => req<CredentialsResponse>(`/api/v1/credentials`),
  putCredential: (provider: string, payload: unknown, name?: string) =>
    req(`/api/v1/credentials/${provider}`, { method: "PUT", body: JSON.stringify({ payload, name }) }),
  deleteCredential: (provider: string, name?: string) =>
    req(`/api/v1/credentials/${provider}${q({ name })}`, { method: "DELETE" }),
  collect: () => req<{ ok: boolean; rows?: number; error?: string }>(`/api/v1/collect`, { method: "POST" }),
};
