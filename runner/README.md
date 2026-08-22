# tokendash-runner（Go 独立版）

额度采集 runner 的 Go 实现，与 cloudflare-hub 内置 runner（`src/runner/`）同构：
定时从 hub 拉取凭证 → 各适配器采集额度 → 上报快照。

存在意义：`api.kimi.com`、`chatgpt.com` 等对端套着 Cloudflare WAF，会拦截
**来自 Cloudflare Workers 出口** 的请求（数据中心 IP + `CF-Worker` 特征头），
内置 runner 调这些接口只会拿到 403 challenge 页。本 runner 部署在普通网络
（家里 NAS / VPS / 任何能 docker 的机器）即可绕过。

纯标准库实现，无外部依赖。

## 运行

镜像托管在 GitHub Container Registry（push main 且 `runner/` 有改动时由 Actions 自动构建，
amd64 + arm64）：

```bash
docker run -d --name tokendash-runner --restart unless-stopped \
  -e HUB_URL=https://token.goudaijun.top \
  -e CF_ACCESS_CLIENT_ID=xxx.access \
  -e CF_ACCESS_CLIENT_SECRET=yyy \
  ghcr.io/junwang666/tokendash-runner:latest
```

> 仓库为私有时，拉取前需 `echo <PAT> | docker login ghcr.io -u <用户名> --password-stdin`
> （PAT 勾 `read:packages`）；或在 GitHub 包页面把 tokendash-runner 设为 Public。

本地构建（不依赖 ghcr）：

```bash
docker build -t tokendash-runner ./runner
docker run -d --name tokendash-runner --restart unless-stopped \
  -e HUB_URL=https://token.goudaijun.top \
  -e CF_ACCESS_CLIENT_ID=xxx.access \
  -e CF_ACCESS_CLIENT_SECRET=yyy \
  -e PROVIDERS=kimi,codex \
  tokendash-runner
```

环境变量：

| 变量 | 必填 | 说明 |
|------|------|------|
| `HUB_URL` | 是 | hub 地址 |
| `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` | 生产必填 | runner 的 Access service token（可复用现有的 `tokendash-runner`） |
| `HUB_DEV_TOKEN` | 二选一 | 本地/调试令牌（hub 配置了 `DEV_TOKEN` 时可用） |
| `INTERVAL` | 否 | 采集周期，默认 `15m`（最小 `1m`） |

采集哪些 provider 由 hub 按 runner 身份分配（见下），无需配置。

调试：`docker run --rm ... tokendash-runner -once` 只采集一轮，失败时退出码非 0。

本地直接跑（不 docker）：

```bash
cd runner && go build -o tokendash-runner .
HUB_URL=... CF_ACCESS_CLIENT_ID=... CF_ACCESS_CLIENT_SECRET=... ./tokendash-runner -once
```

## 与内置 runner 的分工

分工由 hub 统一决定，两边 runner 都无需配置：hub 的 `GET /api/v1/internal/credentials`
按调用方身份过滤——外部 runner（service token 认证）只拿到 `EXTERNAL_RUNNER_PROVIDERS`
（对端 WAF 拦截 Workers 出口的 provider，当前为 kimi/codex，定义在
`cloudflare-hub/src/credentials.ts`）；内置 runner（进程内 loopback）拿其余全部。
新增被 WAF 拦截的 provider 时，把它加进 `EXTERNAL_RUNNER_PROVIDERS` 即可。

## 当前适配器

| provider | 接口 | 凭证字段 |
|----------|------|----------|
| kimi | `api.kimi.com/coding/v1/usages` | `api_key`（kimi.com/code 控制台的 sk-kimi- key），可选 `base_url` |
| codex | `chatgpt.com/backend-api/codex/usage` | `access_token`（~/.codex/auth.json，可选 `account_id`），可选 `base_url` |

### 自建转发（base_url）

凭证里可配 `base_url` 把请求改到自建正向转发（nginx 一行 `proxy_pass`），用于绕开对端 WAF
对特定网络出口的拦截（Cloudflare 内置 runner 与 Go runner 的 kimi/codex 适配器都支持）：

```nginx
# https://relay.example.com/kimi/*  →  https://api.kimi.com/coding/v1/*
location /kimi/ { proxy_pass https://api.kimi.com/coding/v1/; proxy_ssl_server_name on; }
# https://relay.example.com/backend-api/*  →  https://chatgpt.com/backend-api/*
location /backend-api/ { proxy_pass https://chatgpt.com/backend-api/; proxy_ssl_server_name on; }
```

凭证用 JSON 推送（client `tokendash push-credential` 或 web 表单之外的 JSON 渠道）：

```json
{"api_key": "sk-kimi-xxx", "base_url": "https://relay.example.com/kimi"}
```

其余 provider（openai/deepseek/glm/copilot/claude/cursor）由 Cloudflare 内置 runner 采集；
如需迁移过来，在 `internal/adapter/` 里按同样模式加一个文件即可。

## 测试

```bash
go test ./...
```
