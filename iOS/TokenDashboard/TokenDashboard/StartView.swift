//
//  StartView.swift
//  TokenDashboard
//

import SwiftUI

struct StartView: View {
    let settings: AppSettings

    @State private var hubURL = ""
    @State private var authMode: AuthenticationMode = .webAccess
    @State private var accessClientID = ""
    @State private var accessClientSecret = ""
    @State private var developerToken = ""
    @State private var capturedWebCookie = ""
    @State private var presentedSheet: StartSheet?
    @State private var isConnecting = false
    @State private var errorMessage: String?

    init(settings: AppSettings) {
        self.settings = settings
        _hubURL = State(initialValue: settings.hubURL)
        _authMode = State(initialValue: settings.authMode)
        _accessClientID = State(initialValue: settings.accessClientID)
        _accessClientSecret = State(initialValue: settings.accessClientSecret)
        _developerToken = State(initialValue: settings.developerToken)
        _capturedWebCookie = State(initialValue: settings.accessCookieHeader)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(spacing: 14) {
                        Image(systemName: "gauge.with.dots.needle.50percent")
                            .font(.system(size: 48, weight: .medium))
                            .foregroundStyle(.tint)
                            .accessibilityHidden(true)
                        VStack(spacing: 5) {
                            Text("连接 TokenDashboard")
                                .font(.title2.bold())
                            Text("提供 Hub 终结点并完成登录，即可查看各账号剩余额度。")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .multilineTextAlignment(.center)
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .listRowBackground(Color.clear)
                }

                Section("Hub 终结点") {
                    TextField("https://token.example.com", text: $hubURL)
#if !os(macOS)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
#endif
                        .accessibilityIdentifier("startHubURLField")
                }

                Section {
                    Picker("登录方式", selection: $authMode) {
                        ForEach(AuthenticationMode.allCases) { mode in
                            Text(mode.title).tag(mode)
                        }
                    }

                    authenticationFields
                } header: {
                    Text("登录")
                } footer: {
                    authenticationHelp
                }

                Section {
                    Button {
                        primaryAction()
                    } label: {
                        HStack {
                            Spacer()
                            if isConnecting {
                                ProgressView()
                                    .controlSize(.small)
                                Text("正在验证…")
                            } else {
                                Label(primaryActionTitle, systemImage: primaryActionIcon)
                            }
                            Spacer()
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(!canStart || isConnecting)
                    .accessibilityIdentifier("startConnectButton")

                    if authMode == .webAccess, !capturedWebCookie.isEmpty {
                        Button("重新登录 Cloudflare Access") {
                            presentedSheet = .webLogin
                        }
                        .disabled(!hasValidEndpoint || isConnecting)
                        .frame(maxWidth: .infinity)
                    }

                    if let errorMessage {
                        Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }

                Section {
                    Label("终结点保存在 App Group；Secret 和登录 Cookie 仅保存在本机共享 Keychain。", systemImage: "lock.shield")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .formStyle(.grouped)
            .navigationTitle("开始")
#if !os(macOS)
            .navigationBarTitleDisplayMode(.inline)
#endif
        }
        .frame(maxWidth: 640)
        .frame(maxWidth: .infinity)
        .onChange(of: hubURL) {
            capturedWebCookie = ""
            errorMessage = nil
        }
        .onChange(of: authMode) {
            errorMessage = nil
        }
        .sheet(item: $presentedSheet) { sheet in
            switch sheet {
            case .webLogin:
                AccessLoginView(hubURL: normalizedHubURL) { cookieHeader in
                    capturedWebCookie = cookieHeader
                    Task { await verifyAndSave(webCookie: cookieHeader) }
                }
#if os(macOS)
                .frame(minWidth: 720, idealWidth: 860, minHeight: 600, idealHeight: 720)
#endif
            }
        }
    }

    @ViewBuilder
    private var authenticationFields: some View {
        switch authMode {
        case .webAccess:
            if capturedWebCookie.isEmpty {
                Label("尚未登录", systemImage: "person.crop.circle.badge.questionmark")
                    .foregroundStyle(.secondary)
            } else {
                Label("已获取登录授权，等待验证", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
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
            Label("不发送鉴权信息", systemImage: "network")
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var authenticationHelp: some View {
        switch authMode {
        case .webAccess:
            Text("将在 App 内打开 Hub 的 Cloudflare Access 登录页，只采集 Hub 域的授权 Cookie。")
        case .cloudflareAccess:
            Text("填写具备 client 权限的 Cloudflare Access Service Token。")
        case .developerToken:
            Text("仅用于启用了 DEV_TOKEN 的本地开发环境。")
        case .none:
            Text("仅适用于未启用鉴权的本地测试服务。")
        }
    }

    private var normalizedHubURL: String {
        hubURL.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }

    private var draftConfiguration: APIConfiguration {
        APIConfiguration(
            hubURL: normalizedHubURL,
            authMode: authMode,
            accessClientID: accessClientID.trimmingCharacters(in: .whitespacesAndNewlines),
            accessClientSecret: accessClientSecret,
            developerToken: developerToken,
            accessCookieHeader: capturedWebCookie
        )
    }

    private var hasValidEndpoint: Bool {
        draftConfiguration.endpointURL != nil
    }

    private var canStart: Bool {
        guard hasValidEndpoint else { return false }
        switch authMode {
        case .webAccess:
            return true
        case .cloudflareAccess:
            return !accessClientID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                && !accessClientSecret.isEmpty
        case .developerToken:
            return !developerToken.isEmpty
        case .none:
            return true
        }
    }

    private var primaryActionTitle: String {
        if authMode == .webAccess, capturedWebCookie.isEmpty {
            return "登录并连接"
        }
        return "验证并开始"
    }

    private var primaryActionIcon: String {
        authMode == .webAccess && capturedWebCookie.isEmpty
            ? "person.badge.key"
            : "arrow.right.circle.fill"
    }

    private func primaryAction() {
        errorMessage = nil
        if authMode == .webAccess, capturedWebCookie.isEmpty {
            presentedSheet = .webLogin
        } else {
            Task { await verifyAndSave(webCookie: capturedWebCookie) }
        }
    }

    @MainActor
    private func verifyAndSave(webCookie: String) async {
        guard !isConnecting else { return }
        isConnecting = true
        defer { isConnecting = false }

        var configuration = draftConfiguration
        configuration.accessCookieHeader = webCookie
        do {
            _ = try await QuotaAPIClient(configuration: configuration).fetchCurrentQuota()
            guard !Task.isCancelled else { return }
            settings.update(
                hubURL: normalizedHubURL,
                authMode: authMode,
                accessClientID: accessClientID,
                accessClientSecret: accessClientSecret,
                developerToken: developerToken
            )
            if authMode == .webAccess {
                settings.recordWebAccessCookie(webCookie)
            }
        } catch is CancellationError {
            return
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private enum StartSheet: String, Identifiable {
    case webLogin

    var id: String { rawValue }
}
