//
//  SettingsView.swift
//  TokenDashboard
//

import Foundation
import Combine
import SwiftUI

struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    let settings: AppSettings

    @State private var hubURL: String
    @State private var authMode: AuthenticationMode
    @State private var accessClientID: String
    @State private var accessClientSecret: String
    @State private var developerToken: String
    @State private var isShowingWebLogin = false
#if os(iOS)
    @State private var pushEnabled: Bool
    @State private var pushStatus: String
    @State private var pushStatusIsError: Bool
    @State private var isTestingPush = false
#endif

    init(settings: AppSettings) {
        self.settings = settings
        _hubURL = State(initialValue: settings.hubURL)
        _authMode = State(initialValue: settings.authMode)
        _accessClientID = State(initialValue: settings.accessClientID)
        _accessClientSecret = State(initialValue: settings.accessClientSecret)
        _developerToken = State(initialValue: settings.developerToken)
#if os(iOS)
        _pushEnabled = State(initialValue: AppDelegate.isEnabled)
        _pushStatus = State(initialValue: AppDelegate.statusMessage)
        _pushStatusIsError = State(initialValue: AppDelegate.statusIsError)
#endif
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Hub") {
                    TextField("https://token.example.com", text: $hubURL)
#if !os(macOS)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
#endif
                }

                Section {
                    Picker("鉴权方式", selection: $authMode) {
                        ForEach(AuthenticationMode.allCases) { mode in
                            Text(mode.title).tag(mode)
                        }
                    }

                    switch authMode {
                    case .webAccess:
                        if settings.accessCookieHeader.isEmpty {
                            Button("登录 Cloudflare Access", systemImage: "person.badge.key") {
                                beginWebLogin(clearExisting: false)
                            }
                            .disabled(!hasValidHubURL)
                        } else {
                            LabeledContent("登录状态") {
                                Text("已记录")
                                    .foregroundStyle(.green)
                            }
                            Button("重新登录") {
                                beginWebLogin(clearExisting: true)
                            }
                            .disabled(!hasValidHubURL)
                            Button("退出登录", role: .destructive) {
                                Task {
                                    settings.clearWebAccessCookie()
                                    await WebAccessCookieStore.clear()
                                }
                            }
                        }
                    case .cloudflareAccess:
                        TextField("Client ID", text: $accessClientID)
#if !os(macOS)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
#endif
                        SecureField("Client Secret", text: $accessClientSecret)
#if !os(macOS)
                            .textInputAutocapitalization(.never)
#endif
                    case .developerToken:
                        SecureField("DEV_TOKEN", text: $developerToken)
#if !os(macOS)
                            .textInputAutocapitalization(.never)
#endif
                    case .none:
                        EmptyView()
                    }
                } header: {
                    Text("鉴权")
                } footer: {
                    switch authMode {
                    case .webAccess:
                        Text("在 App 内打开 Hub 的 Cloudflare Access 登录页；登录成功后，只保存 Hub 域的授权 Cookie 到本机 Keychain。")
                    case .cloudflareAccess:
                        Text("使用允许 client 角色的 Service Token；当前 Hub 默认识别 common_name 为 tokendash-headless 或 headless 开头的令牌。Secret 仅保存在本机 Keychain。")
                    case .developerToken:
                        Text("仅用于本地 Worker 的 DEV_TOKEN，不要在生产环境启用。令牌仅保存在本机 Keychain。")
                    case .none:
                        Text("仅适用于未启用鉴权的测试服务。")
                    }
                }

#if os(iOS)
                Section {
                    Toggle("启用推送通知", isOn: $pushEnabled)
                        .onChange(of: pushEnabled) { _, newValue in
                            if newValue {
                                // 授权被拒绝时把开关拨回关闭
                                AppDelegate.registerForPush { granted in
                                    pushEnabled = granted
                                }
                            } else {
                                AppDelegate.setEnabled(false)
                            }
                        }
                    LabeledContent("连接状态") {
                        Text(pushStatus)
                            .foregroundStyle(pushStatusIsError ? Color.red : Color.secondary)
                            .multilineTextAlignment(.trailing)
                    }
                    if pushEnabled {
                        HStack {
                            Button("重试注册", systemImage: "arrow.clockwise") {
                                persistDraft(mode: authMode)
                            }
                            Spacer()
                            Button("发送测试通知", systemImage: "bell.badge") {
                                persistDraft(mode: authMode, retryPush: false)
                                isTestingPush = true
                                Task {
                                    defer { isTestingPush = false }
                                    try? await AppDelegate.sendTestPush()
                                }
                            }
                            .disabled(isTestingPush)
                        }
                    }
                } header: {
                    Text("推送通知")
                } footer: {
                    Text("Debug 包使用 APNs sandbox，Release 包使用 production。状态会显示 token 是否成功同步到 Hub；测试按钮会返回 APNs 的具体错误。")
                }
#endif

                Section {
                    Label("额度页面只读取数据；“立即采集”和“凭证管理”会按你的操作写入 Hub。App 不提供删除凭证功能。", systemImage: "lock.shield")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("连接设置")
#if !os(macOS)
            .navigationBarTitleDisplayMode(.inline)
#endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        persistDraft(mode: authMode)
                        dismiss()
                    }
                    .disabled(hubURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .sheet(isPresented: $isShowingWebLogin) {
            AccessLoginView(hubURL: hubURL) { cookieHeader in
                settings.recordWebAccessCookie(cookieHeader)
            }
#if os(macOS)
            .frame(minWidth: 720, idealWidth: 860, minHeight: 600, idealHeight: 720)
#endif
        }
#if os(iOS)
        .onReceive(NotificationCenter.default.publisher(for: .pushRegistrationStatusDidChange)) { _ in
            pushStatus = AppDelegate.statusMessage
            pushStatusIsError = AppDelegate.statusIsError
        }
#endif
    }

    private var hasValidHubURL: Bool {
        guard let url = URL(string: hubURL.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            return false
        }
        return ["http", "https"].contains(url.scheme?.lowercased() ?? "") && url.host != nil
    }

    private func persistDraft(mode: AuthenticationMode, retryPush: Bool = true) {
        settings.update(
            hubURL: hubURL,
            authMode: mode,
            accessClientID: accessClientID,
            accessClientSecret: accessClientSecret,
            developerToken: developerToken
        )
#if os(iOS)
        if retryPush && pushEnabled {
            AppDelegate.retrySubscription()
        }
#endif
    }

    private func beginWebLogin(clearExisting: Bool) {
        persistDraft(mode: .webAccess, retryPush: false)
        Task {
            if clearExisting {
                settings.clearWebAccessCookie()
                await WebAccessCookieStore.clear()
            }
            isShowingWebLogin = true
        }
    }
}

#Preview {
    SettingsView(settings: AppSettings())
}
