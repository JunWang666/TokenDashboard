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
  account: string;
  value: number;
  limit_value: number | null;
  unit: string | null;
  reset_at: string | null;
  captured_at: string;
}

export interface QuotaHistoryRow {
  provider: string;
  metric: string;
  account: string;
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
  name: string;
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

export interface BootstrapResponse {
  ts: TimeseriesResponse;
  quota: QuotaCurrentResponse;
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

export interface AlertSettings {
  enabled: boolean;
  lowThresholdPct: number;
  resetSoonMinutes: number;
}

export interface PushDeliveryStatus {
  status: "pending" | "sending" | "retry" | "sent" | "failed";
  attempts: number;
  lastAttemptAt: string | null;
  sentAt: string | null;
  httpStatus: number | null;
  lastError: string | null;
}

export interface PushSubscriptionStatus {
  platform: "web" | "ios";
  environment: "sandbox" | "production" | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  lastSuccessAt: string | null;
  lastError: string | null;
  latestDelivery: PushDeliveryStatus | null;
}

export interface PushSubscriptionStatusResponse {
  subscription: PushSubscriptionStatus | null;
}

export interface PushTestResponse {
  ok: boolean;
  retryable: boolean;
  invalidSubscription: boolean;
  status: number | null;
  reason: string;
  providerMessageId: string | null;
}

export interface NotifyChannels {
  feishu: { url: string | null; hasSecret: boolean };
  bark: { server: string | null; hasKey: boolean };
}

export interface NotifyChannelsPatch {
  feishu?: { url: string; secret?: string };
  bark?: { server: string; key?: string };
}
