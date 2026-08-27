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
| GET/POST/DELETE | `/api/v1/push/...` | user/client | 推送订阅管理 |
| GET/PUT | `/api/v1/alerts/settings` | GET user/client，PUT user | 告警开关与阈值 |
| GET/PUT | `/api/v1/notify-channels` | GET user/client，PUT user | 第三方通知渠道（飞书/Bark） |
| GET | `/healthz` | 公开 | 健康检查 |

## 额度推送通知

cron 每 15 分钟采集后会扫一轮额度告警（`quota_low` 越过阈值 / `reset_soon` 即将刷新 / `reset_done` 已刷新），按 `alert_events.dedupe_key` 去重后推送到 `push_subscriptions` 里的订阅。开关与阈值见 `GET/PUT /api/v1/alerts/settings`。

secrets / vars：

- web push（VAPID）：`node scripts/gen-vapid.mjs` 生成密钥对；`VAPID_PUBLIC_KEY` 可作普通 var，`VAPID_PRIVATE_KEY` 用 `npx wrangler secret put VAPID_PRIVATE_KEY` 写入；`VAPID_SUBJECT` 填 `mailto:` 联系方式。
- iOS（APNs）：Apple Developer → Certificates, Identifiers & Profiles → Keys 新建启用 APNs 的 key，下载 `.p8`（只下一次）。`APNS_KEY_P8` 填 .p8 全文（含 BEGIN/END 行）、`APNS_KEY_ID` 填 key 的 10 位 ID、`APNS_TEAM_ID` 填 Team ID，均用 `wrangler secret put`；调试期 `APNS_USE_SANDBOX=1`。

web 端订阅流程：`GET /api/v1/push/vapid-public-key` 取公钥 → 浏览器 `pushManager.subscribe({ applicationServerKey })` → 把 `subscription.endpoint` 与 `keys.p256dh/auth` POST 到 `/api/v1/push/subscriptions`（platform=web）。iOS 端把 APNs device token 以 platform=ios 注册到同一接口。

### 第三方通知渠道（飞书 / Bark）

除浏览器推送和 APNs 外，同一批告警事件还会发到 `GET/PUT /api/v1/notify-channels` 配置的渠道，配置存 settings 表（密钥用 CREDENTIALS_KEY 加密）：

```bash
# 飞书自定义机器人（secret 为机器人的签名校验密钥，可选）
curl -X PUT $HUB/api/v1/notify-channels -H ... \
  -d '{"feishu": {"url": "https://open.feishu.cn/open-apis/bot/v2/hook/xxx", "secret": "可选"}}'

# Bark（server 默认官方 https://api.day.app，可填自建；key 为设备 key）
curl -X PUT $HUB/api/v1/notify-channels -H ... \
  -d '{"bark": {"server": "https://api.day.app", "key": "你的设备key"}}'

# 清除某渠道：对应字段传空串，如 {"feishu": {"url": ""}}
```

secret/key 只在 PUT 时提交，GET 只回传 `hasSecret`/`hasKey`。url/server 不变时可省略密钥字段，旧密钥保留。

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
