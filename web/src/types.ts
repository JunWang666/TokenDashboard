export interface UsageRow {
  time: string;
  series: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  requests: number;
}

export interface SummaryRow {
  key: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  requests: number;
}

export interface QuotaCurrentRow {
  provider: string;
  metric: string;
  value: number;
  limit_value: number | null;
  unit: string | null;
  reset_at: string | null;
  captured_at: string;
}

export interface QuotaHistoryRow {
  provider: string;
  metric: string;
  value: number;
  limit_value: number | null;
  unit: string | null;
  reset_at: string | null;
  captured_at: string;
}

export interface DeviceRow {
  device_id: string;
  name: string | null;
  last_seen_at: string;
}

export interface CredentialRow {
  provider: string;
  hint: string | null;
  updated_at: string;
  updated_by: string | null;
}

export interface TimeseriesResponse {
  interval: string;
  group_by: string;
  from: string | null;
  to: string | null;
  rows: UsageRow[];
}

export interface SummaryResponse {
  group_by: string;
  from: string | null;
  to: string | null;
  rows: SummaryRow[];
}

export interface QuotaCurrentResponse {
  rows: QuotaCurrentRow[];
}

export interface QuotaHistoryResponse {
  rows: QuotaHistoryRow[];
}

export interface DevicesResponse {
  rows: DeviceRow[];
}

export interface CredentialsResponse {
  rows: CredentialRow[];
}
