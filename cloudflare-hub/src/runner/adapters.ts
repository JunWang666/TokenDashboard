import type { QuotaRow, QuotaAdapter, FetchFn } from "./types";
import { openai } from "./adapters/openai";
import { deepseek } from "./adapters/deepseek";
import { glm } from "./adapters/glm";
import { copilot } from "./adapters/copilot";
import { claude } from "./adapters/claude";
import { cursor } from "./adapters/cursor";
import { codex } from "./adapters/codex";
import { kimi } from "./adapters/kimi";
import { minimax } from "./adapters/minimax";
import { zai } from "./adapters/zai";
import { anyrouter } from "./adapters/anyrouter";
import { anyrouterTop } from "./adapters/anyrouter-top";

export const adapters: Record<string, QuotaAdapter> = {
  openai,
  deepseek,
  glm,
  copilot,
  claude,
  cursor,
  codex,
  kimi,
  minimax,
  zai,
  anyrouter,
  anyrouter_top: anyrouterTop,
};

/** 运行单个适配器；整体失败转为 scrape_error 行（web 端整卡报红）。
 *  部分指标失败时适配器应返回成功行 + scrape_warn 行（web 端显示数据并带警告），而不是抛错。 */
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
