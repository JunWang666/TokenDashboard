# tokendash-hub (Go)

`cloudflare-hub/`（Cloudflare Worker + D1）的 Go 重写版：单二进制、嵌入式 SQLite，一条命令或一个容器即可自托管。功能与 Worker 版对齐——同一套 API、同一套数据库 schema、加密的凭证格式互相兼容。

## 功能

- **完整 HTTP API**：用量上报（`/ingest/usage`）、额度上报（`/ingest/quota`）、汇总/时间序列/额度查询、bootstrap 首屏聚合、设备心跳
- **凭证管理**：AES-256-GCM 加密存储（与 Worker 版密文格式一致，可互相迁移）、PATCH 乐观锁、级联删除
- **内置 runner**：11 个 provider 额度采集适配器（openai / deepseek / glm / copilot / claude / cursor / codex / kimi / minimax / zai / anyrouter / anyrouter_top），默认每 15 分钟一轮；kimi/codex 仍可由独立 `runner/` 服务经 webhook 采集
- **告警与推送**：quota_low / reset_soon / reset_done 三类告警，Web Push（RFC 8291/8292 VAPID）、APNs、飞书 / Bark 通知渠道，带重试退避的投递管线
- **认证**：Cloudflare Access JWT、Logto OIDC JWT、Bearer token（可后缀 `:runner`/`:client`）、内部凭证头四路

## 快速开始

### Docker（推荐）

```bash
docker build -t tokendash-hub .
docker run -d --name tokendash-hub \
  -p 8787:8787 \
  -v tokendash-data:/data \
  -e CREDENTIALS_KEY="$(openssl rand -base64 32)" \
  tokendash-hub
```

容器内默认 `DB_PATH=/data/tokendash.db`（挂 volume 持久化）。构建参数 `GOPROXY` 可覆盖 module 代理（如 `-e GOPROXY=https://goproxy.cn,direct`）。

### 本地运行

```bash
export CREDENTIALS_KEY=$(openssl rand -base64 32)
go run ./cmd/hub
```

首次启动自动执行 SQLite 迁移（schema 与 `cloudflare-hub/migrations` 相同，`quota_current` 由 trigger 维护）。

### 健康检查

```bash
curl localhost:8787/healthz        # {"ok":true,"ts":"..."}
```

## 配置

见 [.env.example](.env.example)。要点：

| 变量 | 说明 |
|---|---|
| `CREDENTIALS_KEY` | **必填**，base64 的 32 字节 AES 密钥；丢失即无法解密已存凭证 |
| `DB_PATH` | SQLite 文件路径，默认 `./data/tokendash.db` |
| `LISTEN_ADDR` | 监听地址，默认 `:8787` |
| `COLLECT_INTERVAL` | 采集/告警/推送循环间隔，默认 `15m` |
| `ACCESS_TEAM` / `ACCESS_AUD` | Cloudflare Access 认证 |
| `LOGTO_ENDPOINT` / `LOGTO_AUDIENCE` | Logto OIDC 认证（resource server 模式，校验 JWKS） |
| `DEV_TOKEN` | Bearer token（本地/内网），可后缀 `:runner`/`:client` |
| `VAPID_*` / `APNS_*` | Web Push / iOS 推送（可选） |

## 架构

```
cmd/hub                 入口：config → store（迁移）→ crypto → http.Server + 后台循环
internal/config         环境变量
internal/store          SQLite 打开 + 嵌入式迁移（modernc.org/sqlite，纯 Go 无 cgo）
internal/crypto         AES-256-GCM 加解密 + hint（与 Worker 版密文兼容）
internal/auth           四路认证（Access JWT / Logto JWKS / Bearer / internal header）
internal/server         HTTP handler：ingest / query / credentials / settings / push / notify / collect
internal/alerts         告警评估（quota_low / reset_soon / reset_done）
internal/push           Web Push（RFC 8291/8292）+ APNs + 投递状态机（认领/退避/失效）
internal/notify         飞书 / Bark 外发
internal/runner         11 个第三方额度采集适配器
migrations/             与 cloudflare-hub 相同的 SQL（0001–0006）
```

后台循环每 `COLLECT_INTERVAL` 执行：采集额度 → 告警扫描 → 推送投递 → 飞书/Bark 通知；外部 runner webhook（collect-webhook 配置）在每轮采集后触发。

## 与 Worker 版的差异

- 无 Cloudflare 依赖：Access JWT 验证直连公网证书端点，可整体换成 Logto/Bearer
- 无静态资产托管：前端 `web/dist` 由任意静态服务器或反向代理托管，API 走 CORS
- 数据库从 D1 换成本地 SQLite；schema 一致，可用 `wrangler d1 export` 导出后导入

## 开发

```bash
go build ./... && go vet ./...
GOPROXY=https://goproxy.cn,direct go mod tidy   # 若 proxy.golang.org 不可达
```
