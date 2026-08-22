import type { QuotaRow, QuotaAdapter, FetchFn } from "./types";
import { openai } from "./adapters/openai";
import { deepseek } from "./adapters/deepseek";
import { glm } from "./adapters/glm";
import { copilot } from "./adapters/copilot";
import { claude } from "./adapters/claude";
import { cursor } from "./adapters/cursor";
import { codex } from "./adapters/codex";
import { kimi } from "./adapters/kimi";

export const adapters: Record<string, QuotaAdapter> = {
  openai,
  deepseek,
  glm,
  copilot,
  claude,
  cursor,
  codex,
  kimi,
};

/** 运行单个适配器；任何失败都转为 scrape_error 快照行（web 端显示采集失败而不是空白） */
export async function runAdapter(provider: string, cred: unknown, f: FetchFn): Promise<QuotaRow[]> {
  const adapter = adapters[provider];
  if (!adapter) return [];
  if (!cred || typeof cred !== "object" || (cred as Record<string, unknown>).__error__) return [];
  try {
    return await adapter.fetch(cred as Record<string, string>, f);
  } catch (e) {
    const msg = String(e).slice(0, 500);
    return [
      {
        provider,
        metric: "scrape_error",
        value: 1,
        unit: "error",
        limit_value: null,
        reset_at: msg,
      },
    ];
  }
}
