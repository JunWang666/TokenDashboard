import { useEffect, useState } from "react";
import { api } from "../api";
import type { NotifyChannels } from "../types";

const BARK_DEFAULT_SERVER = "https://api.day.app";

/** 第三方通知渠道：飞书自定义机器人 webhook / Bark，额度告警时同步推送 */
export default function NotifyChannelsCard() {
  const [channels, setChannels] = useState<NotifyChannels | null>(null);

  useEffect(() => {
    api
      .getNotifyChannels()
      .then(setChannels)
      .catch(() => setChannels(null));
  }, []);

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900/50">
      <h2 className="text-sm font-medium text-slate-800 dark:text-slate-200">第三方通知渠道</h2>
      <p className="mt-1 text-xs text-slate-400 dark:text-slate-600">
        额度告警除浏览器/App 推送外，可同时发送到飞书群机器人或 Bark。密钥仅用于签名/推送，留空表示不修改已保存的密钥。
      </p>
      {channels && (
        <div className="mt-4 space-y-4">
          <FeishuSection channels={channels} onSaved={setChannels} />
          <BarkSection channels={channels} onSaved={setChannels} />
        </div>
      )}
    </div>
  );
}

function FeishuSection({ channels, onSaved }: { channels: NotifyChannels; onSaved: (c: NotifyChannels) => void }) {
  const [url, setUrl] = useState(channels.feishu.url ?? "");
  const [secret, setSecret] = useState("");
  const [hasSecret, setHasSecret] = useState(channels.feishu.hasSecret);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const save = async (clear = false) => {
    setSaving(true);
    setMsg(null);
    try {
      const r = await api.putNotifyChannels({
        feishu: clear ? { url: "" } : { url: url.trim(), ...(secret.trim() ? { secret: secret.trim() } : {}) },
      });
      onSaved(r);
      setUrl(r.feishu.url ?? "");
      setHasSecret(r.feishu.hasSecret);
      setSecret("");
      setMsg({ ok: true, text: r.feishu.url ? "已保存" : "已清除" });
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
      <h3 className="text-xs font-medium text-slate-600 dark:text-slate-400">飞书群机器人</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="text-xs text-slate-500">Webhook 地址</label>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..."
            className={`mt-1 ${inputCls} font-mono`}
          />
        </div>
        <div>
          <label className="text-xs text-slate-500">签名密钥（可选）</label>
          <input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={hasSecret ? "已保存，留空则不修改" : "机器人开启签名校验时填写"}
            autoComplete="off"
            className={`mt-1 ${inputCls} font-mono`}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={() => save()}
          disabled={!url.trim() || saving}
          className="rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-medium text-slate-950 transition-colors hover:bg-emerald-400 disabled:opacity-40"
        >
          {saving ? "保存中…" : "保存"}
        </button>
        {channels.feishu.url && (
          <button
            onClick={() => save(true)}
            disabled={saving}
            className="rounded-lg border border-red-500/40 px-2.5 py-1 text-xs text-red-500 transition-colors hover:bg-red-500/10 dark:text-red-400 disabled:opacity-40"
          >
            清除
          </button>
        )}
        {msg && <span className={`text-xs ${msg.ok ? "text-emerald-500" : "text-red-500"}`}>{msg.text}</span>}
      </div>
    </div>
  );
}

function BarkSection({ channels, onSaved }: { channels: NotifyChannels; onSaved: (c: NotifyChannels) => void }) {
  const [server, setServer] = useState(channels.bark.server ?? "");
  const [key, setKey] = useState("");
  const [hasKey, setHasKey] = useState(channels.bark.hasKey);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const save = async (clear = false) => {
    setSaving(true);
    setMsg(null);
    try {
      if (!clear && !hasKey && !key.trim()) {
        setMsg({ ok: false, text: "首次配置 Bark 必须填写设备 Key" });
        return;
      }
      const r = await api.putNotifyChannels({
        bark: clear
          ? { server: "" }
          : { server: server.trim() || BARK_DEFAULT_SERVER, ...(key.trim() ? { key: key.trim() } : {}) },
      });
      onSaved(r);
      setServer(r.bark.server ?? "");
      setHasKey(r.bark.hasKey);
      setKey("");
      setMsg({ ok: true, text: r.bark.server ? "已保存" : "已清除" });
    } catch (e) {
      setMsg({ ok: false, text: String(e) });
    } finally {
      setSaving(false);
    }
  };

  const inputCls =
    "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-emerald-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300";

  return (
    <div className="space-y-3 border-t border-slate-100 pt-4 dark:border-slate-800/60">
      <h3 className="text-xs font-medium text-slate-600 dark:text-slate-400">Bark（iOS）</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="text-xs text-slate-500">服务器地址</label>
          <input
            value={server}
            onChange={(e) => setServer(e.target.value)}
            placeholder={`留空使用官方 ${BARK_DEFAULT_SERVER}`}
            className={`mt-1 ${inputCls} font-mono`}
          />
        </div>
        <div>
          <label className="text-xs text-slate-500">设备 Key</label>
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={hasKey ? "已保存，留空则不修改" : "Bark App 里复制的推送 Key"}
            autoComplete="off"
            className={`mt-1 ${inputCls} font-mono`}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={() => save()}
          disabled={saving}
          className="rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-medium text-slate-950 transition-colors hover:bg-emerald-400 disabled:opacity-40"
        >
          {saving ? "保存中…" : "保存"}
        </button>
        {channels.bark.server && (
          <button
            onClick={() => save(true)}
            disabled={saving}
            className="rounded-lg border border-red-500/40 px-2.5 py-1 text-xs text-red-500 transition-colors hover:bg-red-500/10 dark:text-red-400 disabled:opacity-40"
          >
            清除
          </button>
        )}
        {msg && <span className={`text-xs ${msg.ok ? "text-emerald-500" : "text-red-500"}`}>{msg.text}</span>}
      </div>
    </div>
  );
}
