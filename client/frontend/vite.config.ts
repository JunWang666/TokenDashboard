import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Wails 生产构建：build 到 dist，由 Go embed 打进二进制。
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: { outDir: "dist" },
  server: { port: 5175 },
});
