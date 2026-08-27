import { useEffect, useState } from "react";
import { api } from "../api";
import type { AlertSettings } from "../types";

/** VAPID 公钥 base64url → Uint8Array（pushManager.subscribe 的 applicationServerKey） */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** ArrayBuffer → base64url（上报 subscription 的 p256dh/auth 给 hub） */
function bufferToUrlBase64(buf: ArrayBuffer | null): string {
  if (!buf) return "";
  const bytes = new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const pushSupported =
  "Notification" in window && "serviceWorker" in navigator && "PushManager" in window;

export default function PushNotificationCard() {
  const [permission, setPermission] = useState<NotificationPermission>(
    pushSupported ? Notification.permission : "denied",
  );
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [settings, setSettings] = useState<AlertSettings | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsMsg, setSettingsMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!pushSupported) return;
    navigator.serviceWorker.ready
      .then((r) => r.pushManager.getSubscription())
      .then((s) => setSubscribed(!!s))
      .catch(() => setSubscribed(false));
    api
      .getAlertSettings()
      .then(setSettings)
      .catch(() => setSettings(null));
  }, []);

  const subscribe = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== "granted") {
        setMsg({ ok: false, text: "通知权限被拒绝，请在浏览器设置里允许本站通知" });
        return;
      }
      const { key } = await api.getVapidPublicKey();
      if (!key) {
        setMsg({ ok: false, text: "服务端未配置 VAPID，无法开启浏览器推送" });
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      });
      const p256dh = bufferToUrlBase64(subscription.getKey("p256dh"));
      const auth = bufferToUrlBase64(subscription.getKey("auth"));
      if (!p256dh || !auth) throw new Error("浏览器未返回推送密钥，请重试");
      await api.pushSubscribe(subscription.endpoint, { p256dh, auth });
      setSubscribed(true);
      setMsg({ ok: true, text: "已开启浏览器推送" });
    } catch (e) {
      setMsg({ ok: false, text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const unsubscribe = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        const endpoint = subscription.endpoint;
        await subscription.unsubscribe();
        await api.pushUnsubscribe(endpoint);
      }
      setSubscribed(false);
      setMsg({ ok: true, text: "已关闭浏览器推送" });
    } catch (e) {
      setMsg({ ok: false, text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const saveSettings = async () => {
    if (!settings) return;
    setSavingSettings(true);
    setSettingsMsg(null);
    try {
      const r = await api.putAlertSettings(settings);
      setSettings(r);
      setSettingsMsg({ ok: true, text: "已保存" });
    } catch (e) {
      setSettingsMsg({ ok: false, text: String(e) });
    } finally {
      setSavingSettings(false);
    }
  };

  const inputCls =
    "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-emerald-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300";

  const permissionLabel =
    permission === "granted" ? "已允许" : permission === "denied" ? "已被浏览器拒绝" : "未请求";

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900/50">
      <h2 className="text-sm font-medium text-slate-800 dark:text-slate-200">推送通知</h2>
      <p className="mt-1 text-xs text-slate-400 dark:text-slate-600">
        额度低于阈值或即将重置时接收浏览器推送。iOS App 的通知需在手机设置里开启（走 APNs），此处仅管理浏览器推送。
      </p>

      <div className="mt-4 space-y-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-500">
          <span>
            浏览器支持：
            {pushSupported ? (
              <span className="text-emerald-600 dark:text-emerald-400">支持</span>
            ) : (
              <span className="text-red-500">不支持</span>
            )}
          </span>
          <span>
            通知权限：<span className={permission === "denied" ? "text-red-500" : ""}>{permissionLabel}</span>
          </span>
          <span>
            订阅状态：
            {subscribed === null ? (
              "查询中…"
            ) : subscribed ? (
              <span className="text-emerald-600 dark:text-emerald-400">已订阅</span>
            ) : (
              "未订阅"
            )}
          </span>
        </div>

        {pushSupported && (
          <div className="flex flex-wrap items-center gap-3">
            {subscribed ? (
              <button
                onClick={unsubscribe}
                disabled={busy}
                className="rounded-lg border border-red-500/40 px-3 py-1.5 text-sm text-red-500 transition-colors hover:bg-red-500/10 dark:text-red-400 disabled:opacity-40"
              >
                {busy ? "处理中…" : "关闭通知"}
              </button>
            ) : (
              <button
                onClick={subscribe}
                disabled={busy || permission === "denied"}
                className="rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-medium text-slate-950 transition-colors hover:bg-emerald-400 disabled:opacity-40"
              >
                {busy ? "处理中…" : "开启通知"}
              </button>
            )}
            {msg && <span className={`text-xs ${msg.ok ? "text-emerald-500" : "text-red-500"}`}>{msg.text}</span>}
          </div>
        )}

        {settings && (
          <div className="space-y-3 border-t border-slate-100 pt-4 dark:border-slate-800/60">
            <div className="flex items-center gap-2">
              <label className="text-xs text-slate-500">告警开关</label>
              <button
                onClick={() => setSettings({ ...settings, enabled: !settings.enabled })}
                className={`rounded-full px-3 py-1 text-xs transition-colors ${
                  settings.enabled
                    ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                    : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
                }`}
              >
                {settings.enabled ? "已启用" : "已停用"}
              </button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="text-xs text-slate-500">低额度阈值（剩余百分比，1-100）</label>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={settings.lowThresholdPct}
                  onChange={(e) =>
                    setSettings({ ...settings, lowThresholdPct: Math.min(100, Math.max(1, Number(e.target.value) || 1)) })
                  }
                  className={`mt-1 ${inputCls}`}
                />
              </div>
              <div>
                <label className="text-xs text-slate-500">即将重置提前量（分钟，1-1440）</label>
                <input
                  type="number"
                  min={1}
                  max={1440}
                  value={settings.resetSoonMinutes}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      resetSoonMinutes: Math.min(1440, Math.max(1, Number(e.target.value) || 1)),
                    })
                  }
                  className={`mt-1 ${inputCls}`}
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={saveSettings}
                disabled={savingSettings}
                className="rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-medium text-slate-950 transition-colors hover:bg-emerald-400 disabled:opacity-40"
              >
                {savingSettings ? "保存中…" : "保存告警设置"}
              </button>
              {settingsMsg && (
                <span className={`text-xs ${settingsMsg.ok ? "text-emerald-500" : "text-red-500"}`}>{settingsMsg.text}</span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
