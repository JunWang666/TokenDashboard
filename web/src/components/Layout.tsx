import { PROVIDERS } from "../format";

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
      <aside className="w-52 shrink-0 border-r border-slate-800/80 bg-slate-900/40 px-4 py-6">
        <div className="flex items-center gap-2 px-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-500/20 text-emerald-400">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path d="M4 19V9M10 19V5M16 19v-7M22 19H2" strokeLinecap="round" />
            </svg>
          </div>
          <span className="text-sm font-semibold tracking-wide">TokenDashboard</span>
        </div>
        <nav className="mt-8 space-y-1">
          {NAV.map((n) => (
            <button
              key={n.id}
              onClick={() => onNavigate(n.id)}
              className={`block w-full rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                page === n.id
                  ? "bg-emerald-500/10 font-medium text-emerald-300"
                  : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200"
              }`}
            >
              {n.label}
            </button>
          ))}
        </nav>
        <div className="mt-10 px-3 text-[11px] leading-relaxed text-slate-600">
          数据来源：本地采集器 + Cloudflare 云端 runner
        </div>
      </aside>
      <main className="flex-1 px-8 py-6">
        {authBanner && (
          <div className="mb-5 flex items-center justify-between rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
            <span>{authBanner}</span>
            <a
              href={import.meta.env.VITE_ACCESS_LOGIN_URL as string | undefined}
              className="font-medium text-amber-200 underline underline-offset-2"
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

function ProviderLegend() {
  return (
    <div className="sticky top-6 w-44 space-y-2 rounded-xl border border-slate-800 bg-slate-900/40 p-4">
      <div className="text-xs font-medium text-slate-400">服务商</div>
      {PROVIDERS.map((p) => (
        <div key={p.id} className="flex items-center gap-2 text-xs text-slate-400">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: p.color }} />
          {p.name}
        </div>
      ))}
    </div>
  );
}
