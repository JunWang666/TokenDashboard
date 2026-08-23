import { useEffect, useState } from "react";
import { api, fmtTokens } from "./bindings";

interface Status {
  logged_in: boolean;
  login_expires?: string;
  service_token: boolean;
  checkpoint_files: number;
  spool_backlog: number;
  last_sync_at: string;
  last_sync_error?: string;
  last_sync_rows?: number;
  device: string;
  hub_url: string;
  interval: string;
}

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"home" | "settings">("home");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setStatus(await api.Status());
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30000);
    return () => clearInterval(t);
  }, []);

  const login = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await api.Login();
      setNotice(res.message);
      await refresh();
    } catch (e) {
      setNotice("登录失败: " + e);
    } finally {
      setBusy(false);
    }
  };

  const collectNow = async () => {
    setBusy(true);
    try {
      setStatus(await api.CollectNow());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen">
      <aside className="w-44 border-r border-slate-800 bg-slate-900/40 px-3 py-5">
        <div className="px-2 text-sm font-semibold">TokenDashboard</div>
        <nav className="mt-6 space-y-1">
          {(["home", "settings"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`block w-full rounded-lg px-3 py-2 text-left text-sm ${
                tab === t ? "bg-emerald-500/10 text-emerald-300" : "text-slate-400 hover:bg-slate-800/60"
              }`}
            >
              {t === "home" ? "首页" : "设置"}
            </button>
          ))}
        </nav>
      </aside>

      <main className="flex-1 p-6">
        {error && <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</div>}
        {notice && <div className="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">{notice}</div>}

        {tab === "home" ? (
          <Home status={status} onLogin={login} onCollectNow={collectNow} busy={busy} />
        ) : (
          <Settings status={status} onSaved={() => refresh()} />
        )}
      </main>
    </div>
  );
}

function Home({ status, onLogin, onCollectNow, busy }: { status: Status | null; onLogin: () => void; onCollectNow: () => void; busy: boolean }) {
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-lg font-semibold">首页</h1>
        <p className="mt-0.5 text-xs text-slate-500">本机采集状态 · 5 分钟周期自动上报到 hub</p>
      </header>

      {status && !status.logged_in && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4">
          <div className="text-sm font-medium text-amber-300">尚未登录 hub</div>
          <p className="mt-1 text-xs text-amber-300/70">点「连接」会在浏览器里打开 Cloudflare Access 登录，完成后自动保存。</p>
          <button
            onClick={onLogin}
            disabled={busy}
            className="mt-3 rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-medium text-slate-950 disabled:opacity-40"
          >
            连接 Cloudflare Access
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card label="设备" value={status?.device ?? "…"} />
        <Card label="checkpoint 文件" value={String(status?.checkpoint_files ?? "…")} />
        <Card label="spool 积压" value={String(status?.spool_backlog ?? "…")} />
        <Card label="最近上报" value={status?.last_sync_at ? new Date(status.last_sync_at).toLocaleString("zh-CN", { hour12: false }) : "—"} />
      </div>

      {status?.last_sync_error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          上次同步失败：{status.last_sync_error}
        </div>
      )}
      {status?.logged_in && (
        <div className="text-xs text-slate-500">
          登录态{status.login_expires ? ` 有效期至 ${status.login_expires}` : ""}
          {status.service_token ? " · 使用 service token" : ""}
        </div>
      )}

      <div className="flex gap-2">
        <button onClick={onCollectNow} disabled={busy} className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-800 disabled:opacity-40">
          立即采集一次
        </button>
      </div>
      <p className="text-xs text-slate-600">hub: {status?.hub_url ?? "未配置"} · 周期 {status?.interval ?? "—"}</p>
    </div>
  );
}

function Settings({ status, onSaved }: { status: Status | null; onSaved: () => void }) {
  const [hub, setHub] = useState(status?.hub_url ?? "");
  const [device, setDevice] = useState(status?.device ?? "");
  const [interval, setInterval] = useState(status?.interval ?? "5m");
  const [team, setTeam] = useState("");
  const [aud, setAud] = useState("");
  const [claudeOn, setClaudeOn] = useState(true);
  const [cursorOn, setCursorOn] = useState(false);
  const [credProvider, setCredProvider] = useState("claude");
  const [credValue, setCredValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    try {
      await api.SaveConfig({ hub_url: hub, device_name: device, interval, access_team: team, access_aud: aud, sources: { claude_code: claudeOn, cursor: cursorOn } });
      setMsg("已保存");
      onSaved();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setSaving(false);
    }
  };

  const push = async () => {
    try {
      await api.PushCredential(credProvider, credValue.trim() ? JSON.parse(credValue) : { value: credValue });
      setMsg(`已推送 ${credProvider} 凭证`);
    } catch (e) {
      setMsg("推送失败: " + e);
    }
  };

  const input = "mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm outline-none focus:border-emerald-500";
  const label = "block text-xs text-slate-500";

  return (
    <div className="max-w-xl space-y-5">
      <header>
        <h1 className="text-lg font-semibold">设置</h1>
      </header>
      <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/40 p-4">
        <div>
          <label className={label}>hub 地址</label>
          <input className={input} value={hub} onChange={(e) => setHub(e.target.value)} placeholder="https://hub.example.com" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={label}>设备名</label>
            <input className={input} value={device} onChange={(e) => setDevice(e.target.value)} />
          </div>
          <div>
            <label className={label}>采集周期</label>
            <input className={input} value={interval} onChange={(e) => setInterval(e.target.value)} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={label}>Access team（登录用）</label>
            <input className={input} value={team} onChange={(e) => setTeam(e.target.value)} placeholder="my-team" />
          </div>
          <div>
            <label className={label}>Access AUD（登录用）</label>
            <input className={input} value={aud} onChange={(e) => setAud(e.target.value)} placeholder="hub 应用 AUD" />
          </div>
        </div>
        <div className="flex gap-4 pt-1">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={claudeOn} onChange={(e) => setClaudeOn(e.target.checked)} /> Claude Code
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={cursorOn} onChange={(e) => setCursorOn(e.target.checked)} /> Cursor
          </label>
        </div>
        <button onClick={save} disabled={saving} className="rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-medium text-slate-950 disabled:opacity-40">
          {saving ? "保存中…" : "保存配置"}
        </button>
        {msg && <div className="text-xs text-slate-400">{msg}</div>}
      </div>

      <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/40 p-4">
        <div className="text-sm font-medium">推送凭证到 hub（供 runner 采集额度）</div>
        <div className="flex gap-2">
          <select value={credProvider} onChange={(e) => setCredProvider(e.target.value)} className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm">
            {["claude", "openai", "deepseek", "glm", "copilot", "cursor", "codex", "kimi", "minimax", "zai"].map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
          <input className={input} value={credValue} onChange={(e) => setCredValue(e.target.value)} placeholder={'{"session_key":"..."} 或原始字符串'} />
          <button onClick={push} className="rounded-lg border border-emerald-500/50 px-3 py-1.5 text-sm text-emerald-300 hover:bg-emerald-500/10">
            推送
          </button>
        </div>
        <p className="text-xs text-slate-600">claude 凭证也可在 CLI 用 `tokendash push-credential claude` 从 ~/.claude/.credentials.json 自动读取。</p>
      </div>
    </div>
  );
}

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
    </div>
  );
}

export { fmtTokens };
