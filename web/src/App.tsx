import { useState } from "react";
import Layout, { type PageId } from "./components/Layout";
import Credentials from "./pages/Credentials";
import Devices from "./pages/Devices";
import Overview from "./pages/Overview";
import Quota from "./pages/Quota";
import Usage from "./pages/Usage";

export default function App() {
  const [page, setPage] = useState<PageId>("overview");
  const [authBanner, setAuthBanner] = useState<string | null>(null);

  const onAuthError = (msg: string) => setAuthBanner(msg);

  return (
    <Layout page={page} onNavigate={setPage} authBanner={authBanner}>
      {page === "overview" && <Overview onAuthError={onAuthError} />}
      {page === "usage" && <Usage />}
      {page === "quota" && <Quota />}
      {page === "devices" && <Devices />}
      {page === "credentials" && <Credentials />}
    </Layout>
  );
}
