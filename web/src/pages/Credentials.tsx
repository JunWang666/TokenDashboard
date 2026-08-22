import { useCallback, useState } from "react";
import { api } from "../api";
import AsyncData from "../components/AsyncData";
import { scrapeError, CopyableError } from "../components/QuotaBar";
import { PROVIDERS, fmtTime, providerMeta } from "../format";
import type { CredentialRow, CredentialsResponse, QuotaCurrentResponse } from "../types";

const CRED_FIELDS: Record<string, { field: string; label: string; placeholder: string; hint?: string }> = {
  openai: { field: "api_key", label: "Admin/Org API Key", placeholder: "sk-..." },
  deepseek: { field: "api_key", label: "DeepSeek API Key", placeholder: "sk-..." },
  glm: { field: "api_key", label: "智谱 API Key", placeholder: "sk-..." },
  copilot: { field: "token", label: "GitHub Personal Token", placeholder: "ghp_..." },
  claude: {
    field: "session_key",
    label: "claude.ai sessionKey",
    placeholder: "sk-ant-sid01-...",
    hint: "sessionKey 有效期短，建议由本机客户端自动推送",
  },
  codex: {
    field: "access_token",
    label: "Codex access_token",
    placeholder: "eyJhbGciOi...",
    hint: "来自 ~/.codex/auth.json 的 tokens.access_token（ChatGPT 订阅 OAuth token，不要填 API Key）。有效期约一周，过期后需重新粘贴",
  },
  kimi: {
    field: "api_key",
    label: "Kimi Code API Key",
    placeholder: "sk-kimi-...",
    hint: "在 kimi.com/code 控制台创建；注意不是 platform.moonshot.cn 开放平台的 sk- key，两者不互通。如需走自建转发，用 client push-credential 推 JSON：{\"api_key\":\"...\",\"base_url\":\"https://你的转发/kimi\"}",
  },
  cursor: {
    field: "session",
    label: "Cursor cookie 串",
    placeholder: "wos-session=...; 其他=...",
    hint: "登录 cursor.com 后按 F12 → Network → 点开任一 cursor.com 请求 → 复制完整 Cookie 请求头整串粘贴（只贴 token 值会 401）",
  },
};

export default function Credentials() {
  // tick 变化 → load 引用变化 → AsyncData 重新拉取（增删 key 后刷新列表）
  const [tick, setTick] = useState(0);
  const onChanged = useCallback(() => setTick((t) => t + 1), []);
  const loadCreds = useCallback(() => api.credentials(), [tick]);
  const loadQuota = useCallback(() => api.quotaCurrent(), [tick]);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">凭证管理</h1>
        <p className="mt-1 text-sm text-slate-500">
          每个服务商可配置多把 key，独立采集、独立统计；凭证加密存储（AES-256-GCM），仅展示末 4 位
        </p>
      </header>

      <AsyncData<QuotaCurrentResponse> load={loadQuota} refreshMs={60000}>
        {(quota) => (
          <AsyncData<CredentialsResponse> load={loadCreds} refreshMs={60000}>
            {(creds) => (
              <div className="space-y-3">
                {PROVIDERS.map((p) => (
                  <ProviderCard
                    key={p.id}
                    provider={p.id}
                    keys={creds.rows.filter((c) => c.provider === p.id)}
                    quotaRows={quota.rows}
                    onChanged={onChanged}
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

function ProviderCard({
  provider,
  keys,
  quotaRows,
  onChanged,
}: {
  provider: string;
  keys: CredentialRow[];
  quotaRows: QuotaCurrentResponse["rows"];
  onChanged: () => void;
}) {
  const meta = providerMeta(provider);
  const [adding, setAdding] = useState(false);

  return (
    <div className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/50">
      <div className="flex items-center justify-between gap-2 px-5 py-4">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: meta.color }} />
          <span className="font-medium text-slate-800 dark:text-slate-200">{meta.name}</span>
          <span className="text-xs text-slate-400 dark:text-slate-600">{keys.length ? `${keys.length} 把 key` : "未配置"}</span>
        </div>
        <button
          onClick={() => setAdding((v) => !v)}
          className={`flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs transition-colors ${
            adding
              ? "border-slate-300 text-slate-500 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800"
              : "border-emerald-500/50 text-emerald-600 hover:bg-emerald-500/10 dark:text-emerald-400"
          }`}
        >
          {adding ? "收起" : (
            <>
              <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M8 3v10M3 8h10" />
              </svg>
              添加
            </>
          )}
        </button>
      </div>

      {keys.length > 0 && (
        <div className="space-y-2 border-t border-slate-100 px-5 py-3 dark:border-slate-800/60">
          {keys.map((k) => (
            <KeyRow key={k.name} provider={provider} cred={k} quotaRows={quotaRows} onChanged={onChanged} />
          ))}
        </div>
      )}

      {adding && (
        <div className="border-t border-slate-100 px-5 py-4 dark:border-slate-800/60">
          <AddKeyForm provider={provider} onDone={() => setAdding(false)} onChanged={onChanged} />
        </div>
      )}
    </div>
  );
}

function KeyRow({
  provider,
  cred,
  quotaRows,
  onChanged,
}: {
  provider: string;
  cred: CredentialRow;
  quotaRows: QuotaCurrentResponse["rows"];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const err = scrapeError(provider, quotaRows, cred.name);

  const remove = async () => {
    if (!confirm(`删除 ${provider} 的 key「${cred.name}」？`)) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.deleteCredential(provider, cred.name);
      onChanged();
    } catch (e) {
      setMsg(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-slate-950/50">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">{cred.name}</span>
        <span className="font-mono text-xs text-slate-500">{cred.hint ?? "—"}</span>
        <span className="text-xs text-slate-400 dark:text-slate-600">
          {fmtTime(cred.updated_at)} · {cred.updated_by ?? "—"}
        </span>
        {msg && <span className="text-xs text-slate-500">{msg}</span>}
      </div>
      <div className="flex items-center gap-2">
        {err ? (
          <span className="flex items-center gap-1.5">
            <span className="rounded-full bg-red-500/10 px-2.5 py-1 text-xs text-red-600 dark:text-red-400" title={err}>
              最近采集失败
            </span>
            <CopyableError err={err} />
          </span>
        ) : (
          <span className="rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-600 dark:text-emerald-400">采集正常</span>
        )}
        <button
          onClick={remove}
          disabled={busy}
          className="rounded-lg border border-red-500/40 px-2.5 py-1 text-xs text-red-500 transition-colors hover:bg-red-500/10 dark:text-red-400 disabled:opacity-40"
        >
          删除
        </button>
      </div>
    </div>
  );
}

function AddKeyForm({ provider, onDone, onChanged }: { provider: string; onDone: () => void; onChanged: () => void }) {
  const meta = CRED_FIELDS[provider];
  const [name, setName] = useState("");
  const [secret, setSecret] = useState("");
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const save = async () => {
    if (!secret.trim()) return;
    setSaving(true);
    setMsg(null);
    try {
      await api.putCredential(provider, { [meta.field]: secret.trim() }, name.trim() || undefined);
      setMsg({ ok: true, text: "已保存（下一轮 cron 自动生效）" });
      setSecret("");
      setName("");
      onChanged();
    } catch (e) {
      setMsg({ ok: false, text: String(e) });
    } finally {
      setSaving(false);
    }
  };

  const inputCls =
    "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-emerald-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300";

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[1fr_2fr]">
        <div>
          <label className="text-xs text-slate-500">名称（留空为「默认」）</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：主账号" className={`mt-1 ${inputCls}`} />
        </div>
        <div>
          <label className="text-xs text-slate-500">{meta.label}</label>
          <div className="relative mt-1">
            <input
              type={show ? "text" : "password"}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={meta.placeholder}
              autoComplete="off"
              className={`${inputCls} pr-10 font-mono`}
            />
            <button
              type="button"
              onClick={() => setShow((v) => !v)}
              title={show ? "隐藏" : "显示"}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
            >
              {show ? (
                <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 3l14 14M8.2 8.3a2.5 2.5 0 003.4 3.4M6.6 6.8C4.4 8 3 10 3 10s2.7 5 7 5c1.4 0 2.6-.5 3.6-1.1M9.9 5.2c.033 0 .066-.002.1-.002 4.3 0 7 4.8 7 4.8a13.6 13.6 0 01-1.8 2.5" />
                </svg>
              ) : (
                <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 10s2.7-5 7-5 7 5 7 5-2.7 5-7 5-7-5-7-5z" />
                  <circle cx="10" cy="10" r="2.5" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={save}
          disabled={!secret.trim() || saving}
          className="rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-medium text-slate-950 transition-colors hover:bg-emerald-400 disabled:opacity-40"
        >
          {saving ? "保存中…" : "保存"}
        </button>
        <button onClick={onDone} className="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-300">
          取消
        </button>
        {msg && <span className={`text-xs ${msg.ok ? "text-emerald-500" : "text-red-500"}`}>{msg.text}</span>}
      </div>
      <p className="text-xs leading-relaxed text-slate-400 dark:text-slate-600">
        同名 key 会覆盖更新。{meta.hint ?? ""}
      </p>
    </div>
  );
}
