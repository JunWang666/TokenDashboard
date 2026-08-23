# TokenDashboard

追踪个人 token 使用量与 plan 额度的系统。设计文档见 [design/design.md](design/design.md)。

```
┌──────────────┐     ┌─────────────────────────── Cloudflare ───────────────────────────┐
│   client     │     │   hub (Workers + D1)：ingest / 查询 / 凭证管理 API                  │
│  (Wails+Go)  │────▶│   cron 采集（每 15 分钟，src/runner/，与 hub 同进程）               │
│ 解析本地日志  │     │   ▲                                                              │
└──────────────┘     │   └──────────── web/dist（Workers Assets 托管）──── 查询           │
                     │   全部流量经 Cloudflare Access（邮箱 OTP / service token）保护      │
                     └───────────────────────────────────────────────────────────────────┘
```

## 组件

| 目录 | 职责 | 状态 |
|------|------|------|
| [cloudflare-hub](cloudflare-hub/README.md) | Workers + D1：usage/quota 存储，ingest/query/credentials API，Access JWT 校验，AES-256-GCM 凭证加密，cron 额度采集（`src/runner/`：codex/kimi/openai/deepseek/glm/copilot/claude/cursor 适配器） | ✅ 已实现，20 个测试用例 |
| [web](web/README.md) | Pages 前端：Overview / Usage / Quota / Devices / Credentials | ✅ 已实现，构建通过 |
| [client](client/README.md) | 桌面采集器（Go + Wails）+ headless CLI：claude-code/cursor 采集、spool 离线缓冲、loopback Access 登录、凭证推送 | ✅ 已实现，Go 测试通过 |
| [runner](runner/README.md) | Go 独立额度采集器（kimi/codex 适配器，Docker 部署）：对端 WAF 拦截 Workers 出口请求的 provider 由它采集 | ✅ 已实现，Go 测试通过 |
| design/ | 设计文档 | — |

## 快速开始（本地）

```bash
# 1. hub（本地开发令牌模式）
cd cloudflare-hub && npm install
cp .dev.vars.example .dev.vars
npx wrangler dev          # http://localhost:8787

# 2. 手动触发一轮采集（采集逻辑已合并进 hub）
curl http://localhost:8787/__trigger

# 3. web 前端（代理到本地 hub）
cd web && npm install && npm run dev   # http://localhost:5173

# 4. client
cd client && go build ./cmd/tokendash
./tokendash config && ./tokendash once && ./tokendash status
```

## 当前部署（生产）

- **单 Worker 三合一**（`tokendash-hub`，`token.goudaijun.top`）：
  - 静态前端：Workers Static Assets 直接托管 `web/dist`（SPA fallback）
  - API：`/api/v1/*`（hub）+ `/__trigger` 手动采集
  - cron `*/15 * * * *`：runner 采集逻辑（`src/runner/`）与 hub 同进程，loopback 走进程内直调（`X-Tokendash-Internal` 头 = `CREDENTIALS_KEY`），不走公网回环
- 部署命令：`cd cloudflare-hub && wrangler deploy`（先 `cd web && npm run build`）
- Zero Trust team：`gouzuang`；Access 应用 `tokendash`（`token.goudaijun.top`，Personal 邮箱策略 + service token 策略）
- hub JWT 校验 `RUNNER_SERVICE_TOKENS` 用的是 service token 的 **client_id**（JWT `common_name`），不是显示名
- 采集逻辑在 `cloudflare-hub/src/runner/`（原独立 `cloudflare-runner/` 目录已删除，生产合并部署）；kimi/codex 的对端（api.kimi.com、chatgpt.com）套着 Cloudflare WAF，拦截 Workers 出口请求（403 challenge 页），由 `runner/`（Go 独立版，Docker 部署在非 Cloudflare 网络的机器）采集
- 两个 runner 的分工由 hub 统一分配（`/internal/credentials` 按调用方身份过滤，外部 provider 清单 `EXTERNAL_RUNNER_PROVIDERS` 在 `src/credentials.ts`），runner 侧无需配置 PROVIDERS；外部 runner 用同一个 service token 认证

## 部署清单（Zero Trust）

1. 创建 Access team（One-time PIN 登录）；
2. App A `hub.example.com`：Browser 策略（你的邮箱）+ Service Auth 策略（service token `tokendash-runner`）；session duration 7~30 天；CORS 允许 Pages 域与 client webview origin；
3. App B `dash.example.com`（Pages）：Browser 策略；
4. hub：`wrangler d1 create tokendash` → 回填 id → `wrangler d1 migrations apply tokendash --remote` → `wrangler secret put CREDENTIALS_KEY`（`openssl rand -base64 32`）→ 配置 `ACCESS_TEAM` / `ACCESS_AUD` → `wrangler deploy`（自动注册 cron）；
5. web：`npm run build`（dist 由 hub Worker Assets 托管，随 `wrangler deploy` 一起发布）；
6. 桌面 client：安装后应用内一键 Access 登录（免 service token）。

## 测试与验证

| 组件 | 命令 |
|------|------|
| hub | `npm test`（miniflare 集成测试）、`npm run typecheck` |
| web | `npm run build`（tsc + vite build） |
| client | `go test ./...`、`go vet ./...`、`go build -tags wails ./...` |
| runner | `cd runner && go test ./...` |

## 里程碑状态

- [x] M1 hub：D1 schema、ingest/query API、JWT 校验、凭证加密（集成测试覆盖）
- [x] M2 client：claude-code collector、spool、loopback 登录、CLI + Wails 窗口
- [x] M3 web：Overview + Usage + Quota + Devices + Credentials
- [x] M4 runner：凭证拉取 + openai / deepseek / glm 适配器
- [x] M5 runner：copilot / claude / cursor 非官方适配器（容错记录 scrape_error）
- [x] M6 client：cursor collector

> 注：生产部署到 Cloudflare 时，`DEV_TOKEN`（本地开发用）绝不配置。
