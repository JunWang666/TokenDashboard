# web

React + Vite + Tailwind + Recharts 仪表盘。生产环境不是独立 Pages 项目，而是构建到 `web/dist` 后由仓库根目录的 Cloudflare Worker Static Assets 托管。

## 页面

- 总览：今日用量、花费和各 provider 额度。
- 用量：按 provider/model 查看小时或天级 token 明细。
- 额度：查看每个账号的额度历史与 reset 时间。
- 设备：查看桌面采集器心跳。
- 凭证管理：录入加密存储的 provider 凭证和可选的外部 runner webhook。

## 开发与构建

```bash
cd ..
npm install
npm run dev                         # Worker + http://localhost:8787

# 只启动 Vite 时，先在 cloudflare-hub 启动 Worker
npm run dev --workspace web         # http://localhost:5173
npm run build
```

Vite 开发服务器会把 `/api` 代理到 `http://localhost:8787`。生产前端默认使用同源 API；只有把前端单独托管时，才需要设置 `VITE_HUB_URL` 和 `VITE_ACCESS_LOGIN_URL`。
