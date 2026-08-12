import { useCallback, useMemo, useState } from "react";
import { api } from "../api";
import AsyncData from "../components/AsyncData";
import QuotaBar, { scrapeError } from "../components/QuotaBar";
import { PROVIDERS, fmtTime, providerMeta } from "../format";
import type { CredentialsResponse, QuotaCurrentResponse } from "../types";

const CRED_FIELDS: Record<string, string[]> = {
  openai: ["api_key", "Admin/Org API Key"],
  deepseek: ["api_key", "DeepSeek API Key"],
  glm: ["api_key", "智谱 API Key"],
  copilot: ["token", "GitHub Personal Token"],
  claude: ["session_key", "claude.ai sessionKey（建议从客户端推送）"],
  cursor: ["session", "Cursor cookie 串（WorkosSession=...; WorkosFederatedSession=...）"],
};

export default function Credentials() {
  const loadCreds = useCallback(() => api.credentials(), []);
  const loadQuota = useCallback(() => api.quotaCurrent(), []);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold">凭证管理</h1>
        <p className="mt-1 text-sm text-slate-500">
          runner 凭证加密存储在 hub（AES-256-GCM），仅展示末 4 位；明文只下发 runner
        </p>
      </header>

      <AsyncData<QuotaCurrentResponse> load={loadQuota} refreshMs={60000}>
        {(quota) => (
          <AsyncData<CredentialsResponse> load={loadCreds} refreshMs={60000}>
            {(creds) => (
              <div className="space-y-4">
                {PROVIDERS.map((p) => (
                  <CredRow
                    key={p.id}
                    provider={p.id}
                    existing={creds.rows.find((c) => c.provider === p.id)}
                    quotaRows={quota.rows}
                  />
                ))}
              </div>
            )}
          </AsyncData>
        )}
      </AsyncData>
    </div>
  );
}

function CredRow({
  provider,
  existing,
  quotaRows,
}: {
  provider: string;
  existing: CredentialsResponse["rows"][number] | undefined;
  quotaRows: QuotaCurrentResponse["rows"];
}) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const err = scrapeError(provider, quotaRows);
  const meta = providerMeta(provider);

  const parsed = useMemo(() => {
    const t = value.trim();
    if (!t) return null;
    try {
      const o = JSON.parse(t);
      if (o && typeof o === "object") return o;
      return { value: t };
    } catch {
      return { value: t };
    }
  }, [value]);

  const save = async () => {
    if (!parsed) return;
    setSaving(true);
    setMsg(null);
    try {
      await api.putCredential(provider, parsed);
      setMsg({ ok: true, text: "已保存（下一轮 cron 自动生效）" });
      setValue("");
    } catch (e) {
      setMsg({ ok: false, text: String(e) });
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!confirm(`删除 ${provider} 的凭证？`)) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.deleteCredential(provider);
      setMsg({ ok: true, text: "已删除" });
    } catch (e) {
      setMsg({ ok: false, text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: meta.color }} />
          <span className="font-medium">{meta.name}</span>
          {existing ? (
            <span className="text-xs text-slate-500">
              · {existing.hint} · {fmtTime(existing.updated_at)} · {existing.updated_by ?? "—"}
            </span>
          ) : (
            <span className="text-xs text-slate-600">未配置</span>
          )}
        </div>
        {err ? (
          <span className="rounded-full bg-red-500/10 px-2.5 py-1 text-xs text-red-400" title={err}>
            最近采集失败
          </span>
        ) : existing ? (
          <span className="rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-400">采集正常</span>
        ) : null}
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div>
          <label className="text-xs text-slate-500">明文（JSON 对象，或直接粘贴字符串）</label>
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={JSON.stringify(Object.fromEntries(CRED_FIELDS[provider].slice(0, 1).map((f) => [f, "sk-..."])))}
            className="mt-1.5 h-20 w-full rounded-lg border border-slate-700 bg-slate-950 p-3 font-mono text-xs text-slate-300 outline-none focus:border-emerald-500"
          />
          <div className="mt-1.5 flex items-center gap-2">
            <button
              onClick={save}
              disabled={!parsed || saving}
              className="rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-medium text-slate-950 transition-colors hover:bg-emerald-400 disabled:opacity-40"
            >
              {saving ? "保存中…" : "保存"}
            </button>
            {existing && (
              <button
                onClick={remove}
                disabled={busy}
                className="rounded-lg border border-red-500/40 px-3 py-1.5 text-sm text-red-400 transition-colors hover:bg-red-500/10 disabled:opacity-40"
              >
                删除
              </button>
            )}
            {msg && <span className={`text-xs ${msg.ok ? "text-emerald-400" : "text-red-400"}`}>{msg.text}</span>}
          </div>
        </div>
        <div className="text-xs leading-relaxed text-slate-500">
          凭证字段：{CRED_FIELDS[provider][0]}{" "}
          <span className="text-slate-600">（{CRED_FIELDS[provider][1]}）</span>
          <div className="mt-1.5">
            敏感凭证（如 claude sessionKey、cursor cookie）也可在本机客户端一键推送到 hub，到期前自动重推。
          </div>
        </div>
      </div>
    </div>
  );
}
