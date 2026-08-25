//
//  CredentialManagementView.swift
//  TokenDashboard
//

import SwiftUI

struct CredentialManagementView: View {
    @Environment(\.dismiss) private var dismiss

    let configuration: APIConfiguration

    @State private var state: CredentialLoadState = .loading
    @State private var editor: CredentialEditorContext?

    var body: some View {
        NavigationStack {
            Group {
                switch state {
                case .loading:
                    ContentUnavailableView {
                        ProgressView()
                    } description: {
                        Text("正在读取凭证…")
                    }
                case .failed(let message):
                    ContentUnavailableView {
                        Label("无法读取凭证", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(message)
                    } actions: {
                        Button("重试") { Task { await load() } }
                            .buttonStyle(.borderedProminent)
                    }
                case .loaded(let rows):
                    credentialList(rows)
                }
            }
            .navigationTitle("凭证管理")
#if !os(macOS)
            .navigationBarTitleDisplayMode(.inline)
#endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") { dismiss() }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button("新建凭证", systemImage: "plus") {
                        editor = .create
                    }
                }
            }
        }
        .task { await load() }
        .sheet(item: $editor) { context in
            CredentialEditorView(configuration: configuration, context: context) {
                Task { await load() }
            }
#if os(macOS)
            .frame(minWidth: 520, idealWidth: 600, minHeight: 540, idealHeight: 650)
#endif
        }
    }

    private func credentialList(_ rows: [CredentialSummary]) -> some View {
        List {
            if rows.isEmpty {
                ContentUnavailableView(
                    "还没有凭证",
                    systemImage: "key.horizontal",
                    description: Text("点右上角“+”添加第一把 Key。")
                )
            } else {
                ForEach(grouped(rows), id: \.provider.id) { group in
                    Section(group.provider.title) {
                        ForEach(group.rows) { credential in
                            Button {
                                editor = .edit(credential)
                            } label: {
                                CredentialSummaryRow(credential: credential)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }

            Section {
                Label(
                    "Hub 仅返回名称和末尾提示，App 无法读取已保存的完整密钥。修改时只覆盖本次填写的字段。",
                    systemImage: "lock.shield"
                )
                .font(.footnote)
                .foregroundStyle(.secondary)
            }
        }
#if os(macOS)
        .listStyle(.inset)
#else
        .listStyle(.insetGrouped)
#endif
        .refreshable { await load() }
    }

    private func grouped(_ rows: [CredentialSummary]) -> [(provider: CredentialProvider, rows: [CredentialSummary])] {
        let byProvider = Dictionary(grouping: rows, by: \.provider)
        let known = CredentialProvider.all.compactMap { provider -> (CredentialProvider, [CredentialSummary])? in
            guard let values = byProvider[provider.id], !values.isEmpty else { return nil }
            return (provider, values.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending })
        }
        let knownIDs = Set(CredentialProvider.all.map(\.id))
        let unknown = byProvider.keys
            .filter { !knownIDs.contains($0) }
            .sorted()
            .map { id in (CredentialProvider.find(id), byProvider[id] ?? []) }
        return known + unknown
    }

    @MainActor
    private func load() async {
        do {
            let response = try await QuotaAPIClient(configuration: configuration).fetchCredentials()
            guard !Task.isCancelled else { return }
            state = .loaded(response.rows)
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled else { return }
            state = .failed(error.localizedDescription)
        }
    }
}

private struct CredentialSummaryRow: View {
    let credential: CredentialSummary

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "key.horizontal.fill")
                .foregroundStyle(.tint)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 3) {
                Text(credential.name)
                    .foregroundStyle(.primary)
                if let hint = credential.hint, !hint.isEmpty {
                    Text(hint)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("打开修改凭证表单")
    }
}

private enum CredentialLoadState {
    case loading
    case loaded([CredentialSummary])
    case failed(String)
}

private enum CredentialEditorContext: Identifiable {
    case create
    case edit(CredentialSummary)

    var id: String {
        switch self {
        case .create: "create"
        case .edit(let credential): "edit/\(credential.id)"
        }
    }
}

private struct CredentialEditorView: View {
    @Environment(\.dismiss) private var dismiss

    let configuration: APIConfiguration
    let context: CredentialEditorContext
    let onSaved: @MainActor () -> Void

    @State private var providerID: String
    @State private var name: String
    @State private var primaryValue = ""
    @State private var extraValue = ""
    @State private var isSaving = false
    @State private var browserSheet: CredentialBrowserSheet?
    @State private var errorMessage: String?
    @State private var browserSaveNotice: String?

    init(
        configuration: APIConfiguration,
        context: CredentialEditorContext,
        onSaved: @escaping @MainActor () -> Void
    ) {
        self.configuration = configuration
        self.context = context
        self.onSaved = onSaved
        switch context {
        case .create:
            _providerID = State(initialValue: CredentialProvider.all[0].id)
            _name = State(initialValue: "")
        case .edit(let credential):
            _providerID = State(initialValue: credential.provider)
            _name = State(initialValue: credential.name)
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if isCreating {
                        Picker("服务商", selection: $providerID) {
                            ForEach(CredentialProvider.all) { provider in
                                Text(provider.title).tag(provider.id)
                            }
                        }
                        TextField("名称（留空为“默认”）", text: $name)
                    } else {
                        LabeledContent("服务商", value: provider.title)
                        LabeledContent("名称", value: name)
                    }

                    SecureField(provider.primary.label, text: $primaryValue, prompt: Text(provider.primary.placeholder))
#if !os(macOS)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
#endif

                    if let extra = provider.extra {
                        SecureField(extra.label, text: $extraValue, prompt: Text(extra.placeholder))
#if !os(macOS)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
#endif
                    }
                } header: {
                    Text("凭证")
                } footer: {
                    Text(isCreating ? "新建同名凭证会整组覆盖。" : "留空不会清除旧值，只更新本次填写的字段。")
                }

                if let recipe = provider.cookieRecipe {
                    Section {
                        Button("打开 \(provider.title) 登录页", systemImage: "safari") {
                            browserSheet = .cookie(recipe)
                        }
                        if let browserSaveNotice {
                            Label(browserSaveNotice, systemImage: "checkmark.circle.fill")
                                .foregroundStyle(.green)
                        }
                    } header: {
                        Text("网页登录采集")
                    } footer: {
                        Text("登录数据留在本机 WebKit；保存时只上传 \(recipe.targetDomain) 域所需的登录 Cookie。")
                    }
                }

                if let recipe = provider.authorizationRecipe {
                    Section {
                        Button("从 \(provider.title) 网页获取 Authorization", systemImage: "safari") {
                            browserSheet = .authorization(recipe)
                        }
                        .disabled(
                            isCreating
                                && recipe.requiresPrimaryBeforeCapture
                                && primaryValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        )
                        if let browserSaveNotice {
                            Label(browserSaveNotice, systemImage: "checkmark.circle.fill")
                                .foregroundStyle(.green)
                        }
                    } header: {
                        Text("网页登录采集")
                    } footer: {
                        if isCreating, recipe.requiresPrimaryBeforeCapture {
                            Text("请先填写 Kimi Code API Key。登录后只监听 kimi.com 域下 /apiv2/ 请求的 Authorization Bearer Token。")
                        } else {
                            Text("登录后只监听 \(recipe.targetDomain) 域下 \(recipe.targetPathPrefix) 请求的 Authorization Bearer Token。")
                        }
                    }
                }

                if let hint = provider.hint {
                    Section("说明") {
                        Text(hint)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle(isCreating ? "新建凭证" : "修改凭证")
#if !os(macOS)
            .navigationBarTitleDisplayMode(.inline)
#endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                        .disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { await saveAndDismiss() }
                    } label: {
                        if isSaving {
                            ProgressView()
                                .controlSize(.small)
                        } else {
                            Text("保存")
                        }
                    }
                    .disabled(!canSave || isSaving)
                }
            }
        }
        .onChange(of: providerID) {
            primaryValue = ""
            extraValue = ""
            browserSaveNotice = nil
        }
        .sheet(item: $browserSheet) { sheet in
            switch sheet {
            case .cookie(let recipe):
                ProviderCookieLoginView(recipe: recipe) { payload in
                    try await save(payload: try mergedBrowserPayload(payload))
                    browserSaveNotice = "已保存到 Hub"
                }
#if os(macOS)
                .frame(minWidth: 760, idealWidth: 900, minHeight: 620, idealHeight: 760)
#endif
            case .authorization(let recipe):
                ProviderAuthorizationLoginView(recipe: recipe) { payload in
                    try await save(payload: try mergedBrowserPayload(payload))
                    browserSaveNotice = "已保存到 Hub"
                }
#if os(macOS)
                .frame(minWidth: 760, idealWidth: 900, minHeight: 620, idealHeight: 760)
#endif
            }
        }
        .alert("无法保存凭证", isPresented: Binding(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } }
        )) {
            Button("好", role: .cancel) {}
        } message: {
            Text(errorMessage ?? "未知错误")
        }
    }

    private var provider: CredentialProvider {
        CredentialProvider.find(providerID)
    }

    private var isCreating: Bool {
        if case .create = context { return true }
        return false
    }

    private var canSave: Bool {
        if isCreating {
            return !primaryValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        return !primaryValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !extraValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    @MainActor
    private func saveAndDismiss() async {
        isSaving = true
        defer { isSaving = false }
        do {
            try await save(payload: typedPayload)
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    @MainActor
    private func save(payload: [String: String]) async throws {
        guard !payload.isEmpty else { throw CredentialEditorError.emptyPayload }
        let client = QuotaAPIClient(configuration: configuration)
        if isCreating {
            _ = try await client.createCredential(
                provider: provider.id,
                name: name,
                payload: payload
            )
        } else {
            _ = try await client.updateCredential(
                provider: provider.id,
                name: name,
                payload: payload
            )
        }
        onSaved()
    }

    private var typedPayload: [String: String] {
        var payload: [String: String] = [:]
        let primary = primaryValue.trimmingCharacters(in: .whitespacesAndNewlines)
        if !primary.isEmpty { payload[provider.primary.key] = primary }
        if let extra = provider.extra {
            let value = extraValue.trimmingCharacters(in: .whitespacesAndNewlines)
            if !value.isEmpty { payload[extra.key] = value }
        }
        return payload
    }

    private func mergedBrowserPayload(_ captured: [String: String]) throws -> [String: String] {
        var payload = typedPayload
        payload.merge(captured) { _, capturedValue in capturedValue }
        if isCreating,
           payload[provider.primary.key]?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false {
            throw CredentialEditorError.missingPrimary(provider.primary.label)
        }
        return payload
    }
}

private enum CredentialEditorError: LocalizedError {
    case emptyPayload
    case missingPrimary(String)

    var errorDescription: String? {
        switch self {
        case .emptyPayload:
            "请至少填写一个凭证字段。"
        case .missingPrimary(let field):
            "新建凭证前请先填写 \(field)。"
        }
    }
}

private enum CredentialBrowserSheet: Identifiable {
    case cookie(ProviderCookieRecipe)
    case authorization(ProviderAuthorizationRecipe)

    var id: String {
        switch self {
        case .cookie(let recipe): "cookie/\(recipe.id)"
        case .authorization(let recipe): "authorization/\(recipe.id)"
        }
    }
}
