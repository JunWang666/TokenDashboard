# TokenDashboard 设计文档

> 追踪个人 token 使用量与 token plan 额度的系统。
> 服务商范围：Anthropic Claude（订阅）、OpenAI（API 额度）、GitHub Copilot、GLM / DeepSeek 等国产模型、Cursor。
> 客户端用 Go 解析本地工具日志；个人使用（单 Cloudflare 账号、单用户维度，device 区分多台机器）。

## 1. 总体架构

```
                        ┌─────────────────────────── Cloudflare ───────────────────────────┐
                        │                                                                  │
  ┌──────────────┐      │   ┌───────────────┐        ┌──────────────┐                      │
  │   client     │      │   │      hub      │        │     web      │                      │
  │  (Go 采集器)  │──────┼──▶│ Workers + D1  │◀───────│ Pages 前端   │                      │
  │ 解析本地日志  │      │   │ 存储 + 查询API │  查询  │ React 仪表盘 │                      │
  └──────────────┘      │   └───────▲───────┘        └──────────────┘                      │
                        │           │                                                      │
  ┌──────────────┐      │   ┌───────┴───────┐                                              │
  │    runner    │      │   │  (同一 D1 库)  │                                              │
  │ Workers Cron │──────┼──▶│  runner 写入   │                                              │
  │ 云端采集plan  │      │   └───────────────┘                                              │
  └──────────────┘      │                                                                  │
                        │   全部流量经过 Cloudflare Zero Trust (Access) 保护                 │
                        └──────────────────────────────────────────────────────────────────┘
```

四个组件：

| 组件 | 位置 | 职责 |
|------|------|------|
| `client/` | 本地桌面（macOS/Windows/Linux），Wails（Go + webview） | 解析本地工具日志，聚合用量，批量上报到 hub；桌面 UI 展示本地数据；可推送 runner 凭证 |
| `cloudflare-hub/` | Cloudflare Workers + D1 | 数据存储（D1），ingest API + 查询 API + 凭证管理 API |
| 内置 runner（hub `src/runner/`） | hub 同进程 cron | 定时从 hub 拉取凭证，调用各服务商接口，采集 plan 额度快照 |
| `runner/` | 任意机器（Go + Docker） | 同上，承载被对端 WAF 拦截 Workers 出口的 provider（kimi/codex） |
| `web/` | Cloudflare Pages | Web 仪表盘，展示用量和额度；管理 runner 凭证 |

安全：所有入口都挂在 **Cloudflare Access** 后面，共三种身份：

- **桌面 client**：用户在应用内完成 Access 浏览器授权（loopback 流程，见「4. client」），拿到用户身份凭证存系统钥匙串——**新设备零配置，无需申请 Service Token**；
- **headless client / runner**：用 **Service Token**（`CF-Access-Client-Id` / `CF-Access-Client-Secret`）认证（无浏览器环境的备选方案）；
- **web 浏览器**：Access 登录（邮箱一次性 PIN 或 IdP）；
- hub 内部再校验 Access JWT（纵深防御）。

资源消耗：个人规模下全部可跑在 Cloudflare 免费额度内（Workers 10 万请求/天、D1 免费档、Pages 免费、Zero Trust 50 用户以内免费）。

## 2. 数据模型（D1 / SQLite）

```sql
-- 用量，按小时聚合（客户端聚合后上报，天然幂等）
CREATE TABLE usage_hourly (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id          TEXT NOT NULL,             -- 采集设备，如 "macbook-m4"
  provider           TEXT NOT NULL,             -- claude / openai / copilot / glm / deepseek / cursor
  source             TEXT NOT NULL,             -- claude-code / cursor / runner
  model              TEXT,                      -- claude-sonnet-4-5 等
  bucket_hour        TEXT NOT NULL,             -- ISO 小时桶 "2026-08-12T14:00:00Z"
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd           REAL    NOT NULL DEFAULT 0, -- 按价目表估算（可选）
  requests           INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (device_id, provider, source, model, bucket_hour)  -- upsert 保证幂等，重试安全
);

-- plan 额度快照（runner 采集，append-only）
CREATE TABLE quota_snapshots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  provider    TEXT NOT NULL,        -- claude / openai / copilot / glm / deepseek / cursor
  metric      TEXT NOT NULL,        -- 见下表
  value       REAL NOT NULL,        -- 当前值（已用量 / 余额 / 百分比）
  limit_value REAL,                 -- 上限（若可获取）
  unit        TEXT,                 -- usd / cny / requests / percent / tokens
  reset_at    TEXT,                 -- 额度重置时间（若可获取）
  captured_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_quota_latest ON quota_snapshots (provider, metric, captured_at DESC);

-- 设备心跳
CREATE TABLE devices (
  device_id    TEXT PRIMARY KEY,
  name         TEXT,
  last_seen_at TEXT
);

-- runner 凭证（加密存储，见「4. runner 凭证管理」）
CREATE TABLE credentials (
  provider    TEXT PRIMARY KEY,    -- claude / openai / copilot / glm / deepseek / cursor
  payload_enc BLOB NOT NULL,       -- AES-256-GCM 密文（nonce ‖ ciphertext ‖ tag）
  hint        TEXT,                -- 掩码提示，如 "...sk-1a2b"，仅末 4 位，用于界面识别
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by  TEXT                 -- "web:<email>" 或 "client:<device_id>"
);
```

`quota_snapshots.metric` 约定：

| provider | metric | 含义 |
|----------|--------|------|
| claude | `session_used_pct` | 5 小时会话窗口已用百分比 |
| claude | `weekly_used_pct` | 周限额已用百分比 |
| codex | `session_used_pct`、`weekly_used_pct`、`credits_usd` | 5 小时窗口 / 周限额已用百分比、充值余额 |
| kimi | `weekly_used_pct`、`session_used_pct` | 周额度 / 5 小时滚动窗口已用百分比 |
| openai | `balance_usd`、`month_cost_usd` | 余额 / 当月花费 |
| copilot | `premium_used`、`premium_remaining` | 高级请求额度 |
| glm | `balance_cny` | API 余额 |
| deepseek | `balance_usd`（或 cny） | API 余额 |
| cursor | `requests_used` | 订阅内请求用量 |

### 存储选型：为什么是 D1 而不是 Durable Objects

| 维度 | D1 | Durable Objects |
|------|----|-----------------|
| 入门成本 | 免费计划可用 | **必须 Workers 付费计划（$5/月起步）** |
| 计费模型 | 按读/写行数 + 存储；免费档每天 500 万行读、10 万行写、5GB 存储 | 请求数（$0.15/百万）+ 运行时长（GB·s 计费）+ 存储，三者都收钱 |
| 本项目用量估算 | 写：client 聚合上报 + runner 快照 ≈ 每天几百到几千行；读：只有打开看板时才查；存储一年 <100MB | 同等逻辑每天数万次 DO 请求 + 常驻时长 |
| **本项目成本** | **免费额度内 $0** | **≥ $5/月** |
| 适用场景 | SQL 查询、聚合分析（GROUP BY 时间序列）——正是本项目需求 | 强一致协调、实时推送（如 TokenMonitor 的 SSE 秒级同步） |

结论：**D1 成本更低且完全够用**。本项目的查询都是「打开看板才查」的离线分析，没有实时协调需求，Durable Objects 的优势用不上。若未来要加实时推送，再单独评估。

## 3. cloudflare-hub（Workers + D1）

技术栈：TypeScript + Hono + wrangler。

### API

| 方法 | 路径 | 调用方 | 说明 |
|------|------|--------|------|
| POST | `/api/v1/ingest/usage` | client | 批量上报 usage_hourly 行（upsert，幂等） |
| POST | `/api/v1/ingest/quota` | runner | 批量写入 quota_snapshots |
| GET  | `/api/v1/summary?from=&to=&group_by=provider/model/day` | web / client | 用量汇总 |
| GET  | `/api/v1/usage/timeseries?from=&to=&interval=hour/day` | web / client | 时间序列 |
| GET  | `/api/v1/quota/current` | web / client | 每个 (provider, metric) 最新快照 |
| GET  | `/api/v1/quota/history?provider=&metric=&from=&to=` | web / client | 额度历史曲线 |
| GET  | `/api/v1/devices` | web | 设备与最近心跳 |
| GET  | `/api/v1/credentials` | web / client | 凭证列表（provider、hint、updated_at、updated_by，**不含明文**） |
| PUT  | `/api/v1/credentials/:provider` | web / client | 写入/更新凭证（明文 JSON 入参，hub 加密存储） |
| DELETE | `/api/v1/credentials/:provider` | web | 删除凭证 |
| GET  | `/api/v1/internal/credentials` | runner 专用 | 返回全部凭证**解密明文**，仅限 runner 的 service token |
| GET  | `/healthz` | 任何 | 健康检查 |

ingest 请求体（usage 示例）：

```json
{
  "device_id": "macbook-m4",
  "rows": [
    {
      "provider": "claude",
      "source": "claude-code",
      "model": "claude-sonnet-4-5",
      "bucket_hour": "2026-08-12T14:00:00Z",
      "input_tokens": 12000,
      "output_tokens": 3500,
      "cache_read_tokens": 480000,
      "cache_write_tokens": 20000,
      "cost_usd": 0.31,
      "requests": 14
    }
  ]
}
```

### 鉴权中间件

Access 已经在边缘拦截未认证请求，但 hub 仍做两层校验（纵深防御）：

1. 校验 `Cf-Access-Jwt-Assertion` 头中的 JWT：用 `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` 的公钥验证签名，`aud` 必须等于 hub 这个 Access App 的 AUD；
2. 按调用方身份做路由级授权（JWT 里的 `common_name` 或 `email` 声明）：

| 身份 | 允许的接口 |
|------|-----------|
| 用户身份（邮箱 JWT，web 浏览器与桌面 client 共用） | 全部 GET 查询接口、`POST /ingest/usage`、`GET/PUT/DELETE /api/v1/credentials*` |
| client service token（headless 备选） | 同用户身份，但不可 `DELETE /credentials` |
| runner service token | `POST /ingest/quota`、`GET /api/v1/internal/credentials` |

> 桌面 client 与 web 前端用的是同一个用户身份（Access 邮箱登录），所以 client 无需单独的 service token；`internal/credentials` 只对 runner token 开放，用户身份也无法读取明文凭证。

### 凭证加解密

- 加密密钥 `CREDENTIALS_KEY`（32 字节，base64）只配在 hub 的 Workers secret 里，是全系统唯一的对称密钥；
- 写入：AES-256-GCM 加密后存 `credentials.payload_enc`，`hint` 只保留末 4 位；
- 明文只在一个地方出现：`GET /api/v1/internal/credentials` 的响应（TLS + Access 双重保护，仅 runner token 可调）；
- 轮换：更换密钥时用旧密钥解密全部行、新密钥重加密（提供一次性 wrangler 脚本）。

### 目录

```
cloudflare-hub/
  wrangler.toml          # d1_databases 绑定、ACCESS_AUD 环境变量
  migrations/0001_init.sql
  src/
    index.ts             # Hono 路由入口
    auth.ts              # Access JWT 校验 + 路由级授权
    crypto.ts            # AES-256-GCM 凭证加解密
    ingest.ts            # 两个 ingest 端点
    query.ts             # 查询端点
    credentials.ts       # 凭证 CRUD + runner 内部接口
```

## 4. client（跨平台桌面应用，Wails + Go）

### 形态与 UI 框架

客户端是**跨平台桌面应用**，不是纯 CLI。形态参考 TokenMonitor（Javis603/token-monitor：本地采集 + 桌面 widget + hub 同步），但不采用它的 Electron 方案（内存 250MB+），改用更轻的：

| 候选框架 | 技术 | 体积 / 内存 | UI 效果 | 结论 |
|----------|------|-------------|---------|------|
| **Wails v3** | Go 后端 + 系统 webview（macOS WebKit / Windows WebView2 / Linux WebKitGTK），前端用任意 web 框架 | ~10MB / ~60MB | 精美，完整 web 技术栈 | **采用** |
| Fyne | 纯 Go 自绘 | ~15MB / ~80MB | 风格固定，效果一般 | 备选 |
| Tauri | Rust + webview | ~5MB / ~50MB | 精美 | 最轻，但违背 Go 技术栈 |
| Electron | 打包 Chromium | ~80MB / 250MB+ | 精美 | 过重，排除 |

选 **Wails v3 + Svelte（或 React）+ Tailwind + getlantern/systray**：

- Go 采集核心与 UI 解耦：collector / spool / upload 是纯 Go 包，UI 只是它们的视图；
- 前端与 `web/` 共享设计语言和图表组件（同一套 Tailwind 主题、Recharts 图表），降低维护成本；
- 托盘/菜单栏图标显示今日用量，点击弹出主窗口；
- 保留 headless 模式：`tokendash run` 不带 UI 跑在服务器上，复用同一套采集核心。

平台矩阵：

| 平台 | 形态 | 构建 |
|------|------|------|
| macOS (arm64/x64) | 菜单栏 + 窗口 | `wails build -platform darwin/...` |
| Windows (x64) | 系统托盘 + 窗口 | `wails build -platform windows/amd64` |
| Linux (x64) | 托盘（AppIndicator）+ 窗口；服务器可纯 headless | `wails build -platform linux/amd64` |

### Access 授权：应用内 loopback 登录（免 Service Token）

桌面 client **不需要去 Zero Trust 后台申请 Service Token**，改为应用内授权（参考 `cloudflared access login` 的开源实现）：

1. 首次启动，UI 显示「连接 Cloudflare Access」按钮；
2. 点击后 Go 侧在 localhost 起一次性回调监听，打开系统浏览器（或内嵌 webview）进入 Access 登录页，用户完成邮箱 OTP；
3. Access 登录完成后重定向回 localhost，把用户身份 token（`CF_Authorization` JWT）交给 client；
4. client 把 token 存入系统钥匙串，之后所有 hub 请求带 `Cookie: CF_Authorization=<jwt>`；
5. JWT 有效期 = Access App 的 session duration（建议配置 7~30 天）；过期后 hub 返回 401，UI 弹出「重新登录」按钮一键重走流程。

效果：**新设备装完点一下登录就能用**，和你登录网页版看板的体验完全一致。headless 服务器没有浏览器，保留 service token 作为备选（`tokendash login --service-token` 手动录入）。

### 采集行为（Go 核心，与 UI 无关）

以 5 分钟为周期运行：

1. 扫描各数据源日志的**增量**（checkpoint 记录每个文件的 offset 和 inode）；
2. 解析出 token 使用记录，按 `(provider, source, model, 小时桶)` 在内存聚合；
3. 先落本地 spool（JSONL 文件），再批量 POST 到 hub；成功后推进 checkpoint、清理 spool；失败保留待下次重试（离线可用）；
4. 同时上报 device 心跳。

### 数据源（collector 插件接口）

```go
type Collector interface {
    Name() string
    // 从 checkpoint 之后读取增量，返回聚合行与新 checkpoint
    Collect(cp Checkpoint) (rows []UsageRow, next Checkpoint, err error)
}
```

- **claude-code**：解析 `~/.claude/projects/**/*.jsonl`，assistant 消息的 `message.usage` 含 `input_tokens / output_tokens / cache_read_input_tokens / cache_creation_input_tokens`。provider 记为 `claude`，source 记为 `claude-code`。
- **cursor**：解析 Cursor 本地状态库 `state.vscdb`（sqlite），格式变动风险高，单独 collector 隔离。
- 后续可扩展：codex、opencode 等本地日志（TokenMonitor 支持 29+ 工具，其数据源清单可作参考）。

### 客户端 UI 视图

1. **Home**：今日用量卡片（按 provider）、今日估算花费、采集状态（checkpoint 健康度、spool 积压、最近上报时间）；
2. **额度**：调 hub `GET /quota/current`，展示各 plan 额度进度条与 reset 倒计时（与 web 端同一套卡片组件）；
3. **趋势**：本地/云端用量时序图；
4. **Settings**：
   - hub 地址、device 名称、采集开关与周期；
   - Access 授权状态（当前身份、有效期、重新登录按钮）；
   - **runner 凭证推送**：把本机才有的凭证（如 Claude sessionKey、Cursor session cookie）一键推送到 hub 供 runner 使用，支持「凭证即将过期自动重推」。

### 配置与凭证存储

配置文件：

- macOS：`~/Library/Application Support/tokendash/config.toml`
- Linux：`~/.config/tokendash/config.toml`
- Windows：`%APPDATA%\tokendash\config.toml`

```toml
hub_url     = "https://hub.example.com"
device_name = "macbook-m4"
interval    = "5m"

[sources]
claude_code = true
cursor      = false
```

**凭证一律不放配置文件**（Access 用户 token、可选 service token、本机各 provider 凭证）：

- 优先存系统钥匙串（macOS Keychain / Windows Credential Manager / Linux Secret Service，统一用 `zalando/go-keyring`），key 前缀 `tokendash/`；
- 无钥匙串环境（headless Linux）回退到 `<config目录>/credentials`，权限 0600。

### 命令（headless / 调试）

```
tokendash login                     # loopback 浏览器授权，token 存钥匙串
tokendash login --service-token     # 手动录入 service token（headless 备选）
tokendash run                       # 无 UI 常驻采集（launchd / systemd）
tokendash once                      # 立即采集并上报一次
tokendash status                    # checkpoint、spool 积压、最近上报结果
tokendash push-credential <provider>  # 把本机凭证推送到 hub（见第 5 节）
```

### 目录

```
client/
  cmd/tokendash/main.go     # CLI 入口（headless 模式）
  app.go                    # Wails 应用入口（UI 模式）
  frontend/                 # Svelte/React + Tailwind（Wails webview 前端）
  internal/
    config/      # toml 配置
    auth/        # keyring 读写 + loopback Access 登录流程
    collector/   # claudecode.go、cursor.go、interface
    state/       # checkpoint 存取（json）
    spool/       # 离线缓冲（jsonl）
    upload/      # http client（自动带 CF_Authorization / CF-Access-* 头），重试；含 pushCredential
    uiapi/       # 暴露给 Wails 前端的绑定方法
```

## 5. runner（额度采集）

内置 runner 与 hub 同进程（hub Worker 的 cron，如每 15 分钟）：

```
crons = ["*/15 * * * *"]
```

每次触发：

1. 用自己的 service token 调 hub 的 `GET /api/v1/internal/credentials`，拿到全部 provider 凭证（hub 解密后的明文）；
2. 遍历有凭证的 provider 适配器 → 拉取额度 → 归一化为 `quota_snapshots` 行；
3. 带 service token POST 到 hub 的 `/ingest/quota`。

单个适配器失败不影响其他；某 provider 无凭证则跳过。凭证更新（web 界面改的、client 推的）下一轮 cron 自动生效，无需重新部署。

```ts
interface QuotaAdapter {
  provider: string;
  fetch(cred: Record<string, string>): Promise<QuotaRow[]>;
}
```

**凭证不再用 wrangler secret 注入**（那样改一次凭证就要重新部署），全部来自 hub 的 credentials 表；runner 自身只保留两个 secret：`CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`。各适配器方案：

| 适配器 | 方案 | 凭证 |
|--------|------|------|
| codex | `chatgpt.com/backend-api/codex/usage`（非官方；按 `limit_window_seconds` 区分 5 小时/周窗口） | ChatGPT 订阅 OAuth access_token（`~/.codex/auth.json`，有效期约一周，过期重新粘贴；不做 refresh 自动续期，避免使本机 CLI 登录态作废） |
| kimi | `api.kimi.com/coding/v1/usages`（Kimi Code 订阅；周额度 + 5 小时滚动窗口） | kimi.com/code 控制台的 API Key（sk-kimi-*，与开放平台 key 不互通） |
| openai | 官方接口：`/v1/organization/costs`、`/v1/organization/usage/completions` | Admin API Key |
| deepseek | 官方接口：`GET /user/balance` | API Key |
| glm | bigmodel.cn 余额查询接口 | API Key |
| copilot | `GET /copilot_internal/user`（社区常用，返回 premium quota） | GitHub user token |
| claude | claude.ai 的 usage 接口（非官方，用 session cookie，可能失效需维护） | sessionKey |
| cursor | cursor.com 的 usage 接口（非官方，session cookie） | session cookie |

非官方适配器要做容错：接口变动时记录错误快照（`metric = "scrape_error"`），web 端显示「数据过期/采集失败」而不是空白。

### runner/（Go 独立版）

`api.kimi.com`、`chatgpt.com` 等对端套着 Cloudflare WAF（Bot Management），会拦截**来自 Cloudflare Workers 出口**的请求（数据中心 IP + `CF-Worker` 特征头，403 challenge 页），内置 runner 调这些接口必然失败。因此把这部分 provider 拆到 `runner/`：与内置 runner 同构的 Go 实现（拉凭证 → 适配器 → 上报快照），纯标准库、Docker 单容器部署在非 Cloudflare 网络的机器（NAS/VPS）上，用同一个 runner service token 认证。

分工由 hub 统一决定，runner 侧无需任何 provider 配置：hub 的 `GET /api/v1/internal/credentials` 按调用方身份过滤——外部 runner（service token 认证）只拿到 `EXTERNAL_RUNNER_PROVIDERS`（对端 WAF 拦截 Workers 出口的 provider，当前为 kimi/codex，定义在 `cloudflare-hub/src/credentials.ts`），内置 runner（进程内 loopback）拿其余全部。新增被 WAF 拦截的 provider 时加进这个集合即可。

## 6. web（Pages 前端）

技术栈：React + Vite + Tailwind + Recharts，构建产物部署到 Cloudflare Pages。

页面：

1. **Overview**：每个 provider 一张卡片——当前额度进度条（含 reset 倒计时）、今日 token 用量、今日估算花费；
2. **Usage**：按 provider/model 堆叠的时间序列图（小时/天切换）、明细表；
3. **Quota**：每个 metric 的历史曲线（观察额度消耗速率）；
4. **Devices**：各设备最近上报时间，发现采集掉线；
5. **Settings → Credentials**：管理 runner 凭证——每个 provider 一行表单（粘贴 key/cookie → `PUT /credentials/:provider`），显示 hint（末 4 位）、更新时间、更新来源（web 还是某台 client）、最近采集是否成功；可删除。敏感凭证（sessionKey 类）也可以提示「去 client 上一键推送」。

前端通过 fetch 调 hub API（`https://hub.example.com`）。两个 Access App 在同一 team、同主域的子域上，Access cookie 共享，浏览器只需登录一次；hub 端配置 CORS 允许 Pages 域并带 credentials。

## 7. Zero Trust 配置清单

1. Zero Trust 后台创建 team（`<team>.cloudflareaccess.com`），登录方式开 One-time PIN；
2. **Access App A：`hub.example.com`**：
   - 策略（OR）：Browser 允许你的邮箱（web 前端 + 桌面 client 共用此身份）；Service Auth 允许 service token `tokendash-runner`（及可选的 `tokendash-headless`）；
   - **Session duration 设为 7~30 天**（决定 client/web 多久需要重新登录一次）；
   - **CORS 设置**：允许 `dash.example.com`（Pages 域）和 client webview 的 origin（如 `wails://localhost`），并 Allow credentials，否则前端 fetch 会被浏览器拦截；
3. **Access App B：`dash.example.com`**（Pages）：Browser 策略，允许你的邮箱；
4. 凭证下发：
   - 桌面 client：**无需任何后台操作**，应用内 loopback 登录即可（见第 4 节）；
   - runner：`wrangler secret put CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET`；
   - headless client（可选）：申请一个 service token，`tokendash login --service-token` 录入；
5. hub 的 `ACCESS_AUD`（App A 的 AUD tag）写入 wrangler 环境变量，用于 JWT 校验；`CREDENTIALS_KEY`（32 字节随机数）用 `wrangler secret put` 配置。

## 8. 仓库结构

```
TokenDashboard/
  client/             # 跨平台桌面采集器（Wails + Go）
  cloudflare-hub/     # Workers + D1（含合并部署的内置 runner）
  runner/             # Go 独立额度采集器（kimi/codex，Docker 部署在非 Cloudflare 网络）
  web/                # Pages 前端
  design/             # 本文档
```

## 9. 里程碑

| 阶段 | 内容 | 验收 |
|------|------|------|
| M1 | hub：D1 schema、ingest/query API、JWT 校验 | curl 带 service token 写入/查询成功 |
| M2 | client：claude-code collector、spool、loopback 登录、Wails 窗口（Home/Settings） | 本机点一次登录后，Claude Code 用量出现在 D1，UI 可见 |
| M3 | web：Overview + Usage + Credentials 页，Access 登录打通 | 浏览器看到真实数据图表，可录入 runner 凭证 |
| M4 | runner：凭证从 hub 拉取 + openai / deepseek / glm 适配器 | web 录入 key 后 15 分钟内 quota_snapshots 更新 |
| M5 | runner：copilot / claude / cursor 非官方适配器 | 订阅额度卡片有数据 |
| M6 | client：cursor collector | Cursor 用量入库 |
