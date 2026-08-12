# client（tokendash）

跨平台桌面采集器：Go 核心（Wails + React 前端）+ headless CLI。解析本地工具日志（Claude Code、Cursor），聚合后批量上报 hub。

## 构建

```bash
# CLI（headless）
go build ./cmd/tokendash

# 桌面应用（Wails v2）
cd frontend && npm install && npm run build && cd ..
wails build        # 或 go build -tags wails
```

依赖：Go 1.22+；桌面构建需要系统 webview（macOS WebKit / Windows WebView2 / Linux WebKitGTK）。

## 使用

```bash
tokendash config                   # 生成 ~/.config/tokendash/config.toml（macOS: ~/Library/Application Support/tokendash）
tokendash login --team my-team --aud <hub_aud>   # loopback 浏览器授权（Access 邮箱 OTP），token 存钥匙串
tokendash run                      # 常驻采集（launchd/systemd 部署）
tokendash once                     # 立即采集并上报一次
tokendash status                   # checkpoint / spool 积压 / 最近同步
tokendash push-credential claude   # 从 ~/.claude/.credentials.json 推送 sessionKey 到 hub
tokendash logout
```

`login` 也可用 `--service-token` 手动录入（headless 服务器备选，无浏览器）。

## 配置

```toml
hub_url     = "https://hub.example.com"
device_name = "macbook-m4"
interval    = "5m"
access_team = "my-team"    # 登录用
access_aud  = "a1b2c3..."  # hub Access App 的 AUD

[sources]
claude_code = true
cursor      = false
```

凭证一律不落配置文件：Access 用户 token / service token 存系统钥匙串
（`zalando/go-keyring`；无钥匙串环境回退 `<配置目录>/credentials`，权限 0600）。

## 数据源

| 采集器 | 位置 | 说明 |
|--------|------|------|
| claude-code | `~/.claude/projects/**/*.jsonl` | assistant 消息的 `message.usage`；按 inode+offset 增量，追加写入只读新尾部；价目表估算 cost |
| cursor | `~/.cursor/state.vscdb` 的 `ai_usage` 表 | 只读 sqlite；格式变动风险高，失败静默跳过 |

## 架构（Go 核心，与 UI 解耦）

```
collector（增量解析）→ aggregate（小时桶聚合）→ spool（JSONL 离线缓冲）
      → upload（带 Access 认证 + 重试的批量上报）→ 推进 checkpoint
```

上报幂等：hub 按 (device, provider, source, model, hour) upsert，重试安全。

## 测试

```bash
go test ./...
go vet ./...
```
