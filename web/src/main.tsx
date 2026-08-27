import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// 注册推送 Service Worker；不支持的浏览器静默跳过
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch((e) => {
    console.warn("Service Worker 注册失败", e);
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
