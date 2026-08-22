import { lazy, Suspense, useEffect, useState } from "react";
import Layout, { type PageId } from "./components/Layout";
import Credentials from "./pages/Credentials";
import Devices from "./pages/Devices";
import Overview from "./pages/Overview";

// 含 recharts 的页面懒加载，首屏 bundle 不带图表库
const Usage = lazy(() => import("./pages/Usage"));
const Quota = lazy(() => import("./pages/Quota"));

const PAGES: PageId[] = ["overview", "usage", "quota", "devices", "credentials"];

// hash 路由：#/usage 等，刷新/前进后退保持当前页
function pageFromHash(): PageId {
  const h = window.location.hash.replace(/^#\/?/, "");
  return (PAGES as string[]).includes(h) ? (h as PageId) : "overview";
}

export default function App() {
  const [page, setPage] = useState<PageId>(pageFromHash);
  const [authBanner, setAuthBanner] = useState<string | null>(null);

  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const navigate = (p: PageId) => {
    window.location.hash = `/${p}`;
  };

  const onAuthError = (msg: string) => setAuthBanner(msg);

  return (
    <Layout page={page} onNavigate={navigate} authBanner={authBanner}>
      {page === "overview" && <Overview onAuthError={onAuthError} />}
      <Suspense fallback={<div className="animate-pulse text-sm text-slate-500">加载中…</div>}>
        {page === "usage" && <Usage />}
        {page === "quota" && <Quota />}
      </Suspense>
      {page === "devices" && <Devices />}
      {page === "credentials" && <Credentials />}
    </Layout>
  );
}
