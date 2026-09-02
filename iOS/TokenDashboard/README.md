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
- iOS 推送会按 Debug/Release 自动选择 APNs sandbox/production，并在连接设置中显示 Hub 注册状态与测试发送结果
- App Clip 可从调用 URL 自动识别 Hub、完成登录并查看当前额度
- 中号 Widget 最多显示四个账号，每个账号独立选择最多四项指标

## 构建

在 Xcode 中打开 `TokenDashboard.xcodeproj`，选择 `TokenDashboard` Scheme：

- iOS：选择 iPhone / iPad Simulator 或真机
- macOS：选择 My Mac

本地开发使用自动签名，Team 为项目 Build Settings 中的 `DEVELOPMENT_TEAM`；GitHub Actions 的 iOS Release 归档使用下述手动分发签名。App 与 Widget 都需要启用 App Groups 和 Keychain Sharing；iOS App target 还需为 App ID/Provisioning Profile 启用 Push Notifications，macOS Target 需要 App Sandbox 的 Outgoing Connections 权限。Debug 的 `aps-environment` 为 `development`，Release 为 `production`。

## GitHub Actions 与 TestFlight

仓库通过 `.github/workflows/ios-testflight.yml` 构建 iOS：

- iOS 目录或工作流有变更时，所有分支的 Push 和 Pull Request 都会执行 Simulator 编译。
- `main` 分支的 Push 会在编译通过后签名归档，并自动上传到 TestFlight；也可从 `main` 手动触发。
- GitHub Run ID 与重试次数会组成唯一的构建号，例如 `123456789.1`。
- `TokenDashboard` 共享 Scheme 会让归档同时包含 Widget 和 App Clip。

首次启用前，在 Apple Developer 后台确认 Team `4RN53WGN2C` 已注册以下 App ID，并启用工程所需的 App Groups、Keychain Sharing、Push Notifications、Associated Domains 等能力：

- `com.gouzuang.TokenDashboard`
- `com.gouzuang.TokenDashboard.Widget`
- `com.gouzuang.TokenDashboard.Clip`
- App Group `group.com.gouzuang.TokenDashboard`

创建一张 Apple Distribution 证书，并为三个 Bundle ID 分别创建 `IOS_APP_STORE` 描述文件。描述文件必须关联同一张分发证书，并使用以下名称（与工程及 `ExportOptions.plist` 一致）：

- `AppStore com.gouzuang.TokenDashboard`
- `AppStore com.gouzuang.TokenDashboard.Widget`
- `AppStore com.gouzuang.TokenDashboard.Clip`

然后在 GitHub 仓库的 Settings > Secrets and variables > Actions 中配置：

| 类型 | 名称 | 内容 |
| --- | --- | --- |
| Variable | `APPSTORE_ISSUER_ID` | App Store Connect API Issuer ID |
| Variable | `APPSTORE_API_KEY_ID` | App Store Connect API Key ID |
| Secret | `APPSTORE_API_PRIVATE_KEY` | `AuthKey_*.p8` 的完整文本内容；API Key 至少授予 App Manager 权限 |
| Secret | `APPSTORE_CERTIFICATES_FILE_BASE64` | 包含分发证书和私钥的 `.p12` 文件的单行 Base64 |
| Secret | `APPSTORE_CERTIFICATES_PASSWORD` | 导出 `.p12` 时设置的密码 |

App Store Connect 中还必须预先存在 Bundle ID 为 `com.gouzuang.TokenDashboard` 的 App 记录。上传完成并经 Apple 处理后，构建会显示在该 App 的 TestFlight 页面；测试组和外部测试审核仍在 App Store Connect 中管理。

仓库中的 Xcode Cloud 脚本已经删除。如果此前已在 Apple 服务端创建 Xcode Cloud 工作流，还需在 App Store Connect 的 Xcode Cloud 页面将其禁用或删除，避免同一次提交被重复构建；服务端工作流不受仓库文件控制。

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
