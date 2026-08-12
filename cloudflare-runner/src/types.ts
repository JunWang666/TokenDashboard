/** 归一化的额度快照行，与 hub 的 quota_snapshots 表对应 */
export interface QuotaRow {
  provider: string;
  metric: string;
  value: number;
  limit_value?: number | null;
  unit?: string | null;
  reset_at?: string | null;
}

/** 适配器约定：凭证来自 hub credentials 表（解密后的 JSON 对象） */
export interface QuotaAdapter {
  provider: string;
  /** cred: 该 provider 的凭证字段（openai: api_key, deepseek: api_key, glm: api_key, copilot: token, claude: session_key, cursor: session） */
  fetch(cred: Record<string, string>, f: typeof fetch): Promise<QuotaRow[]>;
}

export type FetchFn = typeof fetch;
