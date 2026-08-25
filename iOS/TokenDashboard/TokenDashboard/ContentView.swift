//
//  ContentView.swift
//  TokenDashboard
//

import SwiftUI

struct ContentView: View {
    @State private var settings = AppSettings()
    @State private var presentedSheet: RootSheet?

    var body: some View {
        Group {
            if settings.isConfigured {
                dashboard
                    .transition(.opacity)
            } else {
                StartView(settings: settings)
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: settings.isConfigured)
        .sheet(item: $presentedSheet) { sheet in
            switch sheet {
            case .credentials:
                CredentialManagementView(configuration: settings.configuration)
#if os(macOS)
                    .frame(minWidth: 620, idealWidth: 700, minHeight: 560, idealHeight: 680)
#endif
            case .settings:
                SettingsView(settings: settings)
#if os(macOS)
                    .frame(minWidth: 540, idealWidth: 620, minHeight: 560, idealHeight: 680)
#endif
            }
        }
    }

    private var dashboard: some View {
        NavigationStack {
            QuotaDashboardView(
                configuration: settings.configuration,
                reloadID: settings.revision,
                onShowCredentials: { presentedSheet = .credentials },
                onShowSettings: { presentedSheet = .settings }
            )
            .navigationTitle("额度")
        }
    }
}

private enum RootSheet: String, Identifiable {
    case credentials
    case settings

    var id: String { rawValue }
}

private struct QuotaDashboardView: View {
    let configuration: APIConfiguration
    let reloadID: Int
    let onShowCredentials: () -> Void
    let onShowSettings: () -> Void

    @State private var state: QuotaLoadState = .idle
    @State private var isCollecting = false
    @State private var collectionNotice: CollectionNotice?

    var body: some View {
        Group {
            switch state {
            case .idle, .loading:
                ContentUnavailableView {
                    ProgressView()
                } description: {
                    Text("正在读取额度…")
                }
            case .loaded(let rows, let refreshedAt):
                if rows.isEmpty {
                    ContentUnavailableView(
                        "暂无额度",
                        systemImage: "gauge.with.dots.needle.50percent",
                        description: Text("Hub 还没有可展示的额度快照。")
                    )
                } else {
                    quotaList(rows: rows, refreshedAt: refreshedAt)
                }
            case .failed(let message):
                ContentUnavailableView {
                    Label("无法读取额度", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(message)
                } actions: {
                    Button("重试") {
                        Task { await load(showLoading: true) }
                    }
                    .buttonStyle(.borderedProminent)
                }
            }
        }
        .task(id: reloadID) {
            await load(showLoading: true)
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: .seconds(120))
                } catch {
                    return
                }
                await load(showLoading: false)
            }
        }
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button {
                    Task { await collectNow() }
                } label: {
                    if isCollecting {
                        ProgressView()
                            .controlSize(.small)
                            .accessibilityLabel("正在采集")
                    } else {
                        Label("立即采集", systemImage: "arrow.triangle.2.circlepath")
                    }
                }
                .disabled(isCollecting)
                .accessibilityIdentifier("collectButton")

                Button("凭证管理", systemImage: "key.horizontal", action: onShowCredentials)
                    .accessibilityIdentifier("credentialsButton")

                Button("连接设置", systemImage: "gearshape", action: onShowSettings)
                    .accessibilityIdentifier("settingsButton")
            }
        }
        .alert(item: $collectionNotice) { notice in
            Alert(
                title: Text(notice.title),
                message: Text(notice.message),
                dismissButton: .default(Text("好"))
            )
        }
    }

    private func quotaList(rows: [QuotaSnapshot], refreshedAt: Date) -> some View {
        List {
            ForEach(QuotaGroup.group(rows)) { group in
                Section {
                    ForEach(group.rows) { row in
                        QuotaRowView(snapshot: row)
                    }
                } header: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(group.providerTitle)
                        if !group.account.isEmpty {
                            Text(group.account)
                                .font(.caption2)
                                .textCase(nil)
                        }
                    }
                }
            }

            Section {
                LabeledContent("数据更新时间") {
                    Text(refreshedAt, format: .dateTime.hour().minute().second())
                        .foregroundStyle(.secondary)
                }
            }
        }
#if os(macOS)
        .listStyle(.inset)
#else
        .listStyle(.insetGrouped)
#endif
        .refreshable {
            await load(showLoading: false)
        }
    }

    @MainActor
    private func load(showLoading: Bool) async {
        if showLoading, case .loaded = state {
            // 保留已有内容，刷新时避免整页闪烁。
        } else if showLoading {
            state = .loading
        }

        do {
            let response = try await QuotaAPIClient(configuration: configuration).fetchCurrentQuota()
            guard !Task.isCancelled else { return }
            let rows = response.displayRows
            WidgetCache.save(rows)
            state = .loaded(rows, Date())
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled else { return }
            state = .failed(error.localizedDescription)
        }
    }

    @MainActor
    private func collectNow() async {
        guard !isCollecting else { return }
        isCollecting = true
        defer { isCollecting = false }

        do {
            let rows = try await QuotaAPIClient(configuration: configuration).collectNow()
            guard !Task.isCancelled else { return }
            await load(showLoading: false)
            collectionNotice = CollectionNotice(
                title: "采集完成",
                message: "已采集 \(rows) 条额度数据。"
            )
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled else { return }
            collectionNotice = CollectionNotice(
                title: "采集失败",
                message: error.localizedDescription
            )
        }
    }
}

private struct CollectionNotice: Identifiable {
    let id = UUID()
    let title: String
    let message: String
}

private struct QuotaRowView: View {
    let snapshot: QuotaSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text(snapshot.metricTitle)
                    .font(.headline)
                Spacer()
                Text(snapshot.formattedLimit.map { "\(snapshot.formattedValue) / \($0)" } ?? snapshot.formattedValue)
                    .font(.title3.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(snapshot.tint)
            }

            if let progress = snapshot.displayFraction {
                ProgressView(value: progress)
                    .tint(snapshot.tint)
                    .accessibilityLabel("\(snapshot.metricTitle)使用率")
                    .accessibilityValue(snapshot.formattedValue)
            }

            HStack {
                if let resetDate = snapshot.resetDate {
                    Label {
                        Text("重置 \(resetDate, format: .relative(presentation: .named))")
                    } icon: {
                        Image(systemName: "arrow.clockwise")
                    }
                } else {
                    Text("采集于 \(snapshot.capturedDateText)")
                }
                Spacer()
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 5)
    }
}

private enum QuotaLoadState {
    case idle
    case loading
    case loaded([QuotaSnapshot], Date)
    case failed(String)
}

#Preview("额度") {
    NavigationStack {
        List {
            QuotaRowView(snapshot: .previewSession)
            QuotaRowView(snapshot: .previewBalance)
        }
        .navigationTitle("额度")
    }
}
