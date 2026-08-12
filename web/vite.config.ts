import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // 本地开发：前端相对路径 /api 直接转发到 hub worker
      "/api": { target: "http://localhost:8787", changeOrigin: true },
    },
  },
});
