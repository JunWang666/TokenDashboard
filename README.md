# TokenDashboard

追踪个人 token 使用量与 plan 额度的系统。设计文档见 [design/design.md](design/design.md)。

```
┌──────────────┐     ┌─────────────────────────── Cloudflare ───────────────────────────┐
│   client     │     │   hub (Workers + D1)  ◀── runner (Workers Cron，每 15 分钟)        │
│  (Wails+Go)  │────▶│   ingest / 查询 / 凭证管理 API                                     │
│ 解析本地日志  │     │   ▲                                                              │
└──────────────┘     │   └──────────── web (Pages, React 仪表盘) ──── 查询                │
                     │   全部流量经 Cloudflare Access（邮箱 OTP / service token）保护      │
                     └───────────────────────────────────────────────────────────────────┘
```

## 组件

| 目录 | 职责 | 状态 |
|------|------|------|
| [cloudflare-hub](cloudflare-hub/README.md) | Workers + D1：usage/quota 存储，ingest/query/credentials API，Access JWT 校验，AES-256-GCM 凭证加密 | ✅ 已实现，9 个集成测试 |
| [cloudflare-runner](cloudflare-runner/README.md) | Workers Cron：拉取 hub 凭证 → openai/deepseek/glm/copilot/claude/cursor 适配器 → 回写额度快照 | ✅ 已实现，3 个端到端测试 |
| [web](web/README.md) | Pages 前端：Overview / Usage / Quota / Devices / Credentials | ✅ 已实现，构建通过 |
| [client](client/README.md) | 桌面采集器（Go + Wails）+ headless CLI：claude-code/cursor 采集、spool 离线缓冲、loopback Access 登录、凭证推送 | ✅ 已实现，Go 测试通过 |
| design/ | 设计文档 | — |

## 快速开始（本地）

```bash
# 1. hub（本地开发令牌模式）
cd cloudflare-hub && npm install
cp .dev.vars.example .dev.vars
npx wrangler dev          # http://localhost:8787

# 2. runner 连本地 hub（可选验证）
cd cloudflare-runner && npm install
HUB_URL=http://localhost:8787 HUB_DEV_TOKEN=<同上> npx wrangler dev
# GET http://localhost:8788/__trigger 手动触发一轮采集

# 3. web 前端（代理到本地 hub）
cd web && npm install && npm run dev   # http://localhost:5173

# 4. client
cd client && go build ./cmd/tokendash
./tokendash config && ./tokendash once && ./tokendash status
```

## 部署清单（Zero Trust）

1. 创建 Access team（One-time PIN 登录）；
2. App A `hub.example.com`：Browser 策略（你的邮箱）+ Service Auth 策略（service token `tokendash-runner`）；session duration 7~30 天；CORS 允许 Pages 域与 client webview origin；
3. App B `dash.example.com`（Pages）：Browser 策略；
4. hub：`wrangler d1 create tokendash` → 回填 id → `wrangler d1 migrations apply tokendash --remote` → `wrangler secret put CREDENTIALS_KEY`（`openssl rand -base64 32`）→ 配置 `ACCESS_TEAM` / `ACCESS_AUD` → `wrangler deploy`；
5. runner：`wrangler secret put CF_ACCESS_CLIENT_ID/SECRET` → `wrangler deploy`（自动注册 cron）；
6. web：`npm run build` → `wrangler pages deploy dist --project-name tokendash-web`，构建时设 `VITE_HUB_URL`；
7. 桌面 client：安装后应用内一键 Access 登录（免 service token）。

## 测试与验证

| 组件 | 命令 |
|------|------|
| hub | `npm test`（miniflare 集成测试）、`npm run typecheck` |
| runner | `npm test`（双 worker 端到端 + mock 服务商 API）、`npm run typecheck` |
| web | `npm run build`（tsc + vite build） |
| client | `go test ./...`、`go vet ./...`、`go build -tags wails ./...` |

## 里程碑状态

- [x] M1 hub：D1 schema、ingest/query API、JWT 校验、凭证加密（集成测试覆盖）
- [x] M2 client：claude-code collector、spool、loopback 登录、CLI + Wails 窗口
- [x] M3 web：Overview + Usage + Quota + Devices + Credentials
- [x] M4 runner：凭证拉取 + openai / deepseek / glm 适配器
- [x] M5 runner：copilot / claude / cursor 非官方适配器（容错记录 scrape_error）
- [x] M6 client：cursor collector

> 注：生产部署到 Cloudflare 时，`DEV_TOKEN`（本地开发用）绝不配置；runner 只保留 `CF_ACCESS_CLIENT_ID/SECRET` 两个 secret。
