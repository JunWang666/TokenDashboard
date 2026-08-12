# cloudflare-runner

Workers Cron：每 15 分钟从 hub 拉取 runner 凭证（解密明文），调用各服务商接口采集 plan 额度快照，回写 hub 的 `quota_snapshots`。

## 本地开发

```bash
npm install
npx wrangler dev          # 启动后 GET /__trigger 手动触发一轮
```

连本地 hub（`wrangler dev` 起的 tokendash-hub，端口 8787）时只需 `HUB_DEV_TOKEN`：

```
# .dev.vars
HUB_URL=http://localhost:8787
HUB_DEV_TOKEN=<与 hub .dev.vars 一致>
```

## 部署

```bash
npx wrangler secret put CF_ACCESS_CLIENT_ID     # runner 的 service token id
npx wrangler secret put CF_ACCESS_CLIENT_SECRET # runner 的 service token secret
npx wrangler deploy                             # 自动注册 cron（*/15）
```

生产必须配置 `CF_ACCESS_CLIENT_ID/SECRET`（Access Service Auth），不要配 `HUB_DEV_TOKEN`。

## 适配器与凭证字段

| provider | 凭证字段 | 接口 | 说明 |
|----------|---------|------|------|
| openai | `api_key` | `/v1/organization/costs` | Admin/org key，报 `month_cost_usd` |
| deepseek | `api_key` | `/user/balance` | 报 `balance_cny`（按币种） |
| glm | `api_key` | `open.bigmodel.cn/api/paas/v4/balance/invoke` | 报 `balance_cny` |
| copilot | `token` | `api.github.com/copilot_internal/user` | GitHub token，报 `premium_used/remaining`（非官方） |
| claude | `session_key` | `claude.ai/api/organizations/*/usage` | sessionKey cookie，报 `session_used_pct`、`weekly_used_pct`（非官方） |
| cursor | `session` | `www.cursor.com/api/usage` | 完整 cookie 串，报 `requests_used/remaining`（非官方） |

单个适配器失败只记录 `scrape_error` 快照（`unit="error"`，`reset_at` 放错误信息），不影响其他 provider。某 provider 无凭证直接跳过。

## 测试

```bash
npm test          # 双 worker（hub+runner）端到端 + mock 服务商 API，3 个用例
npm run typecheck
```
