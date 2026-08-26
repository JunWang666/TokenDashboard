# cloudflare-hub

TokenDashboard 的 Cloudflare Worker 源码：Hono API、D1 存储、加密凭证管理、Workers Assets 和内置额度采集 runner。

部署配置在仓库根目录的 [`wrangler.jsonc`](../wrangler.jsonc)，因此根目录的 Deploy to Cloudflare 按钮可以同时看到 Worker、前端产物和 migrations。

## 支持的 provider

`codex`、`kimi`、`minimax`、`zai`、`claude`、`cursor`、`copilot`、`openai`、`deepseek`、`glm`、`anyrouter`。

`minimax` 和 `zai` 默认使用国际站；凭证可以附带 `region: "cn"` 或安全的 HTTPS `base_url`。Kimi/Codex 在部分网络出口需要使用仓库根目录的 [`runner`](../runner/README.md) 外部采集器。

## 本地开发

```bash
cd ..
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

本地请求使用 `Authorization: Bearer <DEV_TOKEN>`。追加 `:client` 或 `:runner` 可模拟对应角色。生产环境不要配置 `DEV_TOKEN`，改用 Cloudflare Access JWT 或 service token。

## API

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/v1/ingest/usage` | user/client | 批量上报小时用量 |
| POST | `/api/v1/ingest/quota` | runner | 写入额度快照 |
| GET | `/api/v1/bootstrap` | user/client | 总览首屏数据 |
| GET | `/api/v1/summary` | user/client | 用量汇总 |
| GET | `/api/v1/usage/timeseries` | user/client | 用量时间序列 |
| GET | `/api/v1/quota/current` | user/client | 最新额度 |
| GET | `/api/v1/quota/history` | user/client | 额度历史 |
| GET | `/api/v1/devices` | user/client | 设备心跳 |
| GET/PUT/PATCH/DELETE | `/api/v1/credentials/:provider` | user/client | 加密凭证管理 |
| GET | `/api/v1/internal/credentials` | runner | runner 内部凭证接口 |
| POST | `/api/v1/collect` | user/client | 立即采集 |
| GET | `/healthz` | 公开 | 健康检查 |

## 测试与部署

```bash
cd ..
npm test
npm run typecheck
npm run build
npm run deploy
```

`npm run deploy` 会构建 `web/dist`、应用 D1 migrations，再执行 `wrangler deploy`。一键部署时 Cloudflare 会自动创建 D1 并回填 `wrangler.jsonc` 中的 `database_id`；手动部署则先执行 `npx wrangler d1 create tokendash` 并写入该 ID。

## 凭证密钥轮换

```bash
export OLD_KEY=<旧密钥> NEW_KEY=<新密钥>
node scripts/rotate-key.mjs --remote
npx wrangler secret put CREDENTIALS_KEY
```

先确认脚本成功完成，再替换 Worker secret；新旧 key 都必须是 32 字节原始值的 base64 编码。
