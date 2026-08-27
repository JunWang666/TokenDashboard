# TokenDashboard Apple App

SwiftUI 额度客户端，共享一套业务代码支持：

- iOS / iPadOS 18.0+
- macOS 15.6+
- iOS / iPadOS App Clip（额度速览）
- iOS、iPadOS 和 macOS 桌面 Widget

## 功能

- 首次启动要求填写 Hub 终结点并验证登录，成功后才进入额度主页
- 查看与 Web Dashboard 一致的账号额度指标
- 手动触发“立即采集”
- 新建、局部修改 Hub 凭证（Hub 只返回末尾提示，不读取密钥明文）
- Claude、Cursor 可在本机 WebKit 登录并直接上传目标域所需 Cookie
- Kimi、Codex 可在本机 WebKit 登录，自动检测目标 API 请求的 Authorization Bearer Token
- 在 App 内完成 Cloudflare Access 登录并将授权 Cookie 保存到共享 Keychain
- App 与 Widget 通过 App Group 共享配置和缓存
- App Clip 可从调用 URL 自动识别 Hub、完成登录并查看当前额度
- 中号 Widget 最多显示四个账号，每个账号独立选择最多四项指标

## 构建

在 Xcode 中打开 `TokenDashboard.xcodeproj`，选择 `TokenDashboard` Scheme：

- iOS：选择 iPhone / iPad Simulator 或真机
- macOS：选择 My Mac

项目使用自动签名，Team 为项目 Build Settings 中的 `DEVELOPMENT_TEAM`。App 与 Widget 都需要启用 App Groups 和 Keychain Sharing；macOS Target 还需要 App Sandbox 的 Outgoing Connections 权限。

### App Clip

选择 `TokenDashboardAppClip` Scheme 后可直接运行。共享 Scheme 默认使用以下测试调用 URL：

```text
https://token.example.com/appclip?auth=none
```

运行前可在 Scheme 的 Run > Arguments > Environment Variables 中修改 `_XCAppClipURL`。调用参数支持：

- `hub`：可选的完整 Hub URL；未提供时使用调用 URL 的协议、域名和端口
- `auth`：可选，支持 `web`、`access`、`developer`、`none`

示例：

```text
https://clip.example.com/appclip?hub=https%3A%2F%2Ftoken.example.com&auth=web
```

App Clip 与完整 App 共用 App Group 和 Keychain，用户在 Clip 中保存的连接信息可由完整 App 继续使用。Clip 与完整 App 复用连接流程、当前额度 Dashboard 和历史趋势；用量、立即采集和凭证管理仍由完整 App 提供。

发布前还需要完成与部署域名相关的配置：

1. 在完整 App 与 App Clip target 的 Associated Domains 中加入 `appclips:<调用域名>`。
2. 在该域名部署包含 `appclips.apps` 的 `apple-app-site-association` 文件，值使用 `4RN53WGN2C.com.gouzuang.TokenDashboard.Clip`。
3. 在 App Store Connect 配置默认或高级 App Clip Experience，并使用相同的调用 URL。
