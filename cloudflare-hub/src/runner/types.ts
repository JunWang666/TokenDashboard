/** 归一化的额度快照行，与 hub 的 quota_snapshots 表对应 */
export interface QuotaRow {
  provider: string;
  metric: string;
  /** 凭证名（多 key 场景，对应 credentials.name） */
  account?: string;
  value: number;
  limit_value?: number | null;
  unit?: string | null;
  reset_at?: string | null;
}

/** 适配器约定：凭证来自 hub credentials 表（解密后的 JSON 对象） */
export interface QuotaAdapter {
  provider: string;
  /** cred: 该 provider 的凭证字段（openai/deepseek/glm/minimax/zai: api_key, copilot: token, claude: session_key, cursor: session, codex: access_token(+account_id), kimi: api_key） */
  fetch(cred: Record<string, string>, f: typeof fetch): Promise<QuotaRow[]>;
}

export type FetchFn = typeof fetch;
