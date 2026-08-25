# TokenDashboard Apple App

SwiftUI 额度客户端，共享一套业务代码支持：

- iOS / iPadOS 18.0+
- macOS 15.6+
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
- 中号 Widget 最多显示四个账号，每个账号独立选择最多四项指标

## 构建

在 Xcode 中打开 `TokenDashboard.xcodeproj`，选择 `TokenDashboard` Scheme：

- iOS：选择 iPhone / iPad Simulator 或真机
- macOS：选择 My Mac

项目使用自动签名，Team 为项目 Build Settings 中的 `DEVELOPMENT_TEAM`。App 与 Widget 都需要启用 App Groups 和 Keychain Sharing；macOS Target 还需要 App Sandbox 的 Outgoing Connections 权限。
