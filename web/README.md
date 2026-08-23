# web（Pages 前端）

React + Vite + Tailwind + Recharts 仪表盘，部署到 Cloudflare Pages。

## 页面

- **总览**：今日用量/花费卡片 + 各 provider 额度进度条（含 reset 倒计时；采集失败显示原因）
- **用量**：按 provider/model 堆叠柱状图（小时/天切换），明细表（token 分解 + 估算花费）
- **额度**：每个 (provider, metric) 的历史曲线（观察消耗速率）
- **设备**：各采集设备最近上报时间，掉线高亮
- **凭证管理**：runner 凭证录入/删除（hint 末 4 位、更新时间、来源、采集状态），含 MiniMax Token Plan 与 Z.ai / GLM Coding Plan 套餐 Key

## 开发

```bash
npm install
npm run dev        # http://localhost:5173，/api 代理到 localhost:8787（本地 hub）
```

生产构建时通过环境变量配置 hub 地址与 Access 登录 URL：

```bash
VITE_HUB_URL=https://hub.example.com VITE_ACCESS_LOGIN_URL=https://dash.example.com npm run build
npx wrangler pages deploy dist --project-name tokendash-web
```

## 认证

浏览器与 hub 同属一个 Access team，Access cookie 共享（hub 与 Pages 在同一主域子域时），
登录一次即可；hub 端 CORS 需允许 Pages 域并带 credentials（见 design §7）。
