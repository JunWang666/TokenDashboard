import { PROVIDERS } from "../format";
import { toggleTheme, useTheme } from "../theme";

export type PageId = "overview" | "usage" | "quota" | "devices" | "credentials";

const NAV: { id: PageId; label: string }[] = [
  { id: "overview", label: "总览" },
  { id: "usage", label: "用量" },
  { id: "quota", label: "额度" },
  { id: "devices", label: "设备" },
  { id: "credentials", label: "凭证管理" },
];

export default function Layout({
  page,
  onNavigate,
  children,
  authBanner,
}: {
  page: PageId;
  onNavigate: (p: PageId) => void;
  children: React.ReactNode;
  authBanner: string | null;
}) {
  return (
    <div className="flex min-h-screen">
      <aside className="flex w-52 shrink-0 flex-col border-r border-slate-200 bg-white px-4 py-6 dark:border-slate-800/80 dark:bg-slate-900/40">
        <div className="flex items-center gap-2 px-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-400">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path d="M4 19V9M10 19V5M16 19v-7M22 19H2" strokeLinecap="round" />
            </svg>
          </div>
          <span className="text-sm font-semibold tracking-wide text-slate-900 dark:text-slate-100">TokenDashboard</span>
        </div>
        <nav className="mt-8 space-y-1">
          {NAV.map((n) => (
            <button
              key={n.id}
              onClick={() => onNavigate(n.id)}
              className={`block w-full rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                page === n.id
                  ? "bg-emerald-500/10 font-medium text-emerald-700 dark:text-emerald-300"
                  : "text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800/60 dark:hover:text-slate-200"
              }`}
            >
              {n.label}
            </button>
          ))}
        </nav>
        <div className="mt-10 px-3 text-[11px] leading-relaxed text-slate-400 dark:text-slate-600">
          数据来源：本地采集器 + Cloudflare 云端 runner
        </div>
        <div className="mt-auto px-2 pt-6">
          <ThemeToggle />
        </div>
      </aside>
      <main className="flex-1 px-8 py-6">
        {authBanner && (
          <div className="mb-5 flex items-center justify-between rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
            <span>{authBanner}</span>
            <a
              href={import.meta.env.VITE_ACCESS_LOGIN_URL as string | undefined}
              className="font-medium text-amber-800 underline underline-offset-2 dark:text-amber-200"
            >
              去登录
            </a>
          </div>
        )}
        {children}
      </main>
      <div className="hidden items-start gap-6 px-8 py-6 xl:flex">
        <ProviderLegend />
      </div>
    </div>
  );
}

function ThemeToggle() {
  const theme = useTheme();
  const dark = theme === "dark";
  return (
    <button
      onClick={toggleTheme}
      title={dark ? "切换到浅色模式" : "切换到暗色模式"}
      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800/60 dark:hover:text-slate-200"
    >
      {dark ? (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" />
        </svg>
      )}
      {dark ? "浅色模式" : "暗色模式"}
    </button>
  );
}

function ProviderLegend() {
  return (
    <div className="sticky top-6 w-44 space-y-2 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/40">
      <div className="text-xs font-medium text-slate-500 dark:text-slate-400">服务商</div>
      {PROVIDERS.map((p) => (
        <div key={p.id} className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: p.color }} />
          {p.name}
        </div>
      ))}
    </div>
  );
}
