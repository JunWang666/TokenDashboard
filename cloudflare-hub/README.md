# cloudflare-hub

TokenDashboard 数据中枢：Cloudflare Workers + D1。存储用量、plan 额度快照与加密的 runner 凭证，提供 ingest / 查询 / 凭证管理 API。

## 支持的额度服务商

| provider | 凭证字段 | 采集内容 |
|---|---|---|
| `codex` | `access_token` | ChatGPT/Codex 5 小时、周额度与 credits |
| `kimi` | `api_key`，可选 `web_token` | Kimi Code 5 小时、周额度与可选月额度 |
| `minimax` | Token Plan `api_key` | MiniMax Token Plan 5 小时、周额度；兼容多资源额度 |
| `zai` | Coding Plan `api_key` | Z.ai / GLM Coding Plan 5 小时、周额度与 MCP 月额度；兼容 V2/V3 |
| `claude` / `cursor` / `copilot` | session/token | 对应订阅额度（非官方接口） |
| `openai` / `deepseek` / `glm` | 标准 `api_key` | API 花费或余额 |

`minimax`、`zai` 默认使用国际站。中国站凭证可存为
`{"api_key":"...","region":"cn"}`；自建 HTTPS 转发可额外设置 `base_url`（只接受不含认证信息、查询参数或片段的 HTTPS URL）。

## 本地开发

```bash
npm install
cp .dev.vars.example .dev.vars   # 本地开发令牌
npx wrangler dev                 # 启动本地 worker（含本地 D1）
npx wrangler d1 migrations apply tokendash --local   # 初始化 schema
```

本地开发模式下用 `DEV_TOKEN` 代替 Cloudflare Access 鉴权：

| 角色 | Authorization 头 |
|------|-----------------|
| user | `Bearer <DEV_TOKEN>` |
| client | `Bearer <DEV_TOKEN>:client` |
| runner | `Bearer <DEV_TOKEN>:runner` |

生产环境**不要配置 DEV_TOKEN**，改为 Access JWT 校验（`ACCESS_TEAM` / `ACCESS_AUD`）。

## 测试

```bash
npm test          # miniflare 集成测试 + runner 适配器单测（node --test，29 个用例）
npm run typecheck
```

## 部署

```bash
npx wrangler d1 create tokendash            # 首次：创建数据库，把 id 回填 wrangler.toml
npx wrangler d1 migrations apply tokendash --remote
npx wrangler secret put CREDENTIALS_KEY     # 32 字节 base64：openssl rand -base64 32
npx wrangler deploy
```

## 凭证密钥轮换

```bash
export OLD_KEY=<旧密钥> NEW_KEY=<新密钥>
node scripts/rotate-key.mjs --remote   # 解密→重加密全部 credentials 行
npx wrangler secret put CREDENTIALS_KEY  # 然后更新 secret 为新密钥
```

## API

| 方法 | 路径 | 角色 | 说明 |
|------|------|------|------|
| POST | `/api/v1/ingest/usage` | user / client | 批量上报 usage_hourly（upsert 幂等） |
| POST | `/api/v1/ingest/quota` | runner | 批量写入 quota_snapshots |
| GET | `/api/v1/summary?from=&to=&group_by=provider/model/day` | user / client | 用量汇总 |
| GET | `/api/v1/usage/timeseries?from=&to=&interval=hour/day&group_by=` | user / client | 时间序列 |
| GET | `/api/v1/quota/current` | user / client | 各 (provider, metric) 最新快照 |
| GET | `/api/v1/quota/history?provider=&metric=&from=&to=` | user / client | 额度历史 |
| GET | `/api/v1/devices` | user / client | 设备心跳 |
| GET | `/api/v1/credentials` | user / client | 凭证列表（仅 hint） |
| PUT | `/api/v1/credentials/:provider` | user / client | 写入凭证（加密存储） |
| DELETE | `/api/v1/credentials/:provider` | user | 删除凭证 |
| GET | `/api/v1/internal/credentials` | runner | 全部凭证明文（仅 runner token） |
| GET | `/healthz` | 公开 | 健康检查 |
