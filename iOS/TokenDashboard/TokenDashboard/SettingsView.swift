//
//  SettingsView.swift
//  TokenDashboard
//

import Foundation
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

    init(settings: AppSettings) {
        self.settings = settings
        _hubURL = State(initialValue: settings.hubURL)
        _authMode = State(initialValue: settings.authMode)
        _accessClientID = State(initialValue: settings.accessClientID)
        _accessClientSecret = State(initialValue: settings.accessClientSecret)
        _developerToken = State(initialValue: settings.developerToken)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Hub") {
                    TextField("https://token.example.com", text: $hubURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
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
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        SecureField("Client Secret", text: $accessClientSecret)
                            .textInputAutocapitalization(.never)
                    case .developerToken:
                        SecureField("DEV_TOKEN", text: $developerToken)
                            .textInputAutocapitalization(.never)
                    case .none:
                        EmptyView()
                    }
                } header: {
                    Text("只读鉴权")
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

                Section {
                    Label("App 只调用 GET /api/v1/quota/current，不会写入或删除任何 Hub 数据。", systemImage: "lock.shield")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("连接设置")
            .navigationBarTitleDisplayMode(.inline)
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
        }
    }

    private var hasValidHubURL: Bool {
        guard let url = URL(string: hubURL.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            return false
        }
        return ["http", "https"].contains(url.scheme?.lowercased() ?? "") && url.host != nil
    }

    private func persistDraft(mode: AuthenticationMode) {
        settings.update(
            hubURL: hubURL,
            authMode: mode,
            accessClientID: accessClientID,
            accessClientSecret: accessClientSecret,
            developerToken: developerToken
        )
    }

    private func beginWebLogin(clearExisting: Bool) {
        persistDraft(mode: .webAccess)
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
