# TokenDashboard

个人 AI 工具用量、订阅额度与 token plan 仪表盘。桌面端读取本地日志，Cloudflare Worker 负责存储与额度采集，Web、iOS 和 macOS 客户端共享同一套 API。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/JunWang666/TokenDashboard)

点击上面的按钮即可把项目复制到自己的 GitHub/GitLab，并在自己的 Cloudflare 账号中自动创建 D1、构建静态前端和部署 Worker。仓库需要公开；部署按钮只负责 Cloudflare Worker 部分，桌面端、Apple 客户端和可选的外部 runner 需要单独运行。

## 能做什么

- 记录 Claude Code、Cursor 等本地工具的小时用量、token 分解和估算花费。
- 采集 Codex、Kimi、MiniMax Token Plan、Z.ai/GLM Coding Plan、OpenAI、DeepSeek、GLM、AnyRouter、AnyRouter.top、Copilot、Claude、Cursor 等额度。
- 一个 Worker 同时托管 API、React 仪表盘和每 15 分钟一次的 cron 采集；D1 保存数据，凭证使用 AES-256-GCM 加密。
- Go 桌面采集器支持离线 spool、重试和 Cloudflare Access 登录；iOS/iPadOS/macOS 客户端支持额度查看、立即采集和 Widget。
- Kimi/Codex 可选用 Docker runner；它们的上游接口可能拦截 Cloudflare Workers 出口请求。

## 一键部署 Cloudflare

部署按钮会自动处理 D1 资源、Workers Static Assets 和 Workers Builds。首次部署时填写：

1. `CREDENTIALS_KEY`：必填，执行 `openssl rand -base64 32` 生成并妥善备份。
2. `ACCESS_TEAM`、`ACCESS_AUD`：推荐在部署前或部署后配置 Cloudflare Access；暂时留空时 API 会保持拒绝访问状态。
3. `CORS_ORIGINS`：只有使用独立域名/客户端跨域访问时才填写，多个来源用逗号分隔。

部署完成后，在 Cloudflare 控制台取得 Worker URL，并创建一个保护该 URL 的 Access 应用：

1. Browser policy 允许自己的邮箱；需要外部 runner 时，再添加 Service Auth policy。
2. 把 Access team 名称和该应用的 AUD tag 写入 Worker 变量 `ACCESS_TEAM`、`ACCESS_AUD`，然后重新部署。
3. 在 Web 的「凭证管理」里录入 provider 凭证。Worker cron 会自动每 15 分钟采集一次。
4. 桌面端或 Apple App 的 Hub URL 填入 Worker URL；外部 Docker runner 也使用这个 URL。

部署按钮产生的是独立副本，资源 ID 会写入副本的 `wrangler.jsonc`。若仓库不可公开，使用下面的手动流程。

## 本地开发

依赖 Node.js 22+；Cloudflare CLI 由根目录依赖提供。

```bash
npm install
cp .dev.vars.example .dev.vars
# 将 CREDENTIALS_KEY 改成 openssl rand -base64 32 的结果
npm run db:migrate:local
npm run dev                         # http://localhost:8787
```

本地 API 使用 `.dev.vars` 中的 `DEV_TOKEN`：

```bash
curl -H 'Authorization: Bearer local-dev-secret' \
  http://localhost:8787/api/v1/bootstrap
```

`DEV_TOKEN` 仅用于本地开发，生产环境不要配置它。

## 手动部署

```bash
npm install
npx wrangler login
npx wrangler d1 create tokendash
# 将输出的 database_id 写入 wrangler.jsonc 的 DB 绑定
npx wrangler secret put CREDENTIALS_KEY
npm run deploy
```

若第一次部署使用 `CREDENTIALS_KEY`，建议先执行 `npx wrangler secret put CREDENTIALS_KEY`，再执行 `npm run deploy`。迁移脚本使用绑定名 `DB`，因此 D1 名称可以按需修改。`wrangler.jsonc` 是部署入口，`cloudflare-hub/` 里的 Worker 源码和 migrations 由它引用。

## 目录

| 目录 | 作用 |
| --- | --- |
| [`cloudflare-hub`](cloudflare-hub/README.md) | Hono Worker、D1 API、加密凭证、内置额度 runner |
| [`web`](web/README.md) | React + Vite + Tailwind 仪表盘，构建后由 Worker Assets 托管 |
| [`client`](client/README.md) | Go/Wails 桌面采集器与 headless CLI |
| [`runner`](runner/README.md) | Kimi/Codex 外部 Docker runner |
| [`iOS/TokenDashboard`](iOS/TokenDashboard/README.md) | iOS/iPadOS/macOS SwiftUI 客户端与 Widget |
| [`design`](design/design.md) | 架构与数据模型设计 |

## 常用命令

```bash
npm run build       # 构建 Web Assets
npm run typecheck   # Web + Worker 类型检查
npm test            # Worker 集成测试与额度适配器测试
cd client && go test ./...
cd runner && go test ./...
```

## 安全说明

不要提交 `.env`、`.dev.vars`、Access service token、provider 凭证或 `CREDENTIALS_KEY`。Worker 端只返回凭证末尾 hint；生产访问应由 Cloudflare Access 保护。修改 `CREDENTIALS_KEY` 前，先按 [`cloudflare-hub/README.md`](cloudflare-hub/README.md) 的轮换流程重新加密 D1 中已有的凭证。
