//
//  ContentView.swift
//  TokenDashboard
//

import Charts
import Foundation
import SwiftUI

struct ContentView: View {
    @State private var presentedSheet: RootSheet?

    var body: some View {
        ConnectionGateView { settings in
            dashboard(settings: settings)
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
    }

    private func dashboard(settings: AppSettings) -> some View {
        AdaptiveDashboardView(
            settings: settings,
            onShowCredentials: { presentedSheet = .credentials },
            onShowSettings: { presentedSheet = .settings }
        )
    }
}

private struct AdaptiveDashboardView: View {
    let settings: AppSettings
    let onShowCredentials: () -> Void
    let onShowSettings: () -> Void

#if os(iOS)
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
#endif
    @State private var selection: DashboardDestination? = .quota

    var body: some View {
        if usesSidebar {
            NavigationSplitView {
                List(selection: $selection) {
                    Section("TokenDashboard") {
                        ForEach(DashboardDestination.allCases) { destination in
                            Label(destination.title, systemImage: destination.systemImage)
                                .tag(destination)
                        }
                    }

                    Section("管理") {
                        Button("凭证管理", systemImage: "key.horizontal", action: onShowCredentials)
                        Button("连接设置", systemImage: "gearshape", action: onShowSettings)
                    }
                }
                .navigationTitle("概览")
                .navigationSplitViewColumnWidth(min: 190, ideal: 220, max: 260)
            } detail: {
                dashboardNavigation(for: selection ?? .quota)
            }
            .navigationSplitViewStyle(.balanced)
        } else {
            TabView {
                dashboardNavigation(for: .quota)
                    .tabItem {
                        Label("额度", systemImage: "gauge.with.dots.needle.50percent")
                    }

                dashboardNavigation(for: .usage)
                    .tabItem {
                        Label("用量", systemImage: "chart.bar.xaxis")
                    }
            }
        }
    }

    private var usesSidebar: Bool {
#if os(macOS)
        true
#elseif os(iOS)
        horizontalSizeClass == .regular
#else
        true
#endif
    }

    @ViewBuilder
    private func dashboardNavigation(for destination: DashboardDestination) -> some View {
        NavigationStack {
            switch destination {
            case .quota:
                QuotaDashboardView(
                    configuration: settings.configuration,
                    reloadID: settings.revision,
                    mode: .fullApp,
                    onShowCredentials: onShowCredentials,
                    onShowSettings: onShowSettings,
                    onRowsLoaded: WidgetCache.save
                )
                .navigationTitle("额度")
            case .usage:
                UsageDashboardView(
                    configuration: settings.configuration,
                    reloadID: settings.revision
                )
                .navigationTitle("用量")
            }
        }
        .id(destination)
    }
}

private enum DashboardDestination: String, CaseIterable, Identifiable {
    case quota
    case usage

    var id: Self { self }

    var title: String {
        switch self {
        case .quota: "额度"
        case .usage: "用量"
        }
    }

    var systemImage: String {
        switch self {
        case .quota: "gauge.with.dots.needle.50percent"
        case .usage: "chart.bar.xaxis"
        }
    }
}

private enum RootSheet: String, Identifiable {
    case credentials
    case settings

    var id: String { rawValue }
}

private struct UsageDashboardView: View {
    let configuration: APIConfiguration
    let reloadID: Int

#if os(iOS)
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
#endif
    @State private var state: UsageLoadState = .idle
    @State private var range: UsageRange = .twoWeeks
    @State private var interval: UsageInterval = .day
    @State private var groupBy: UsageGroupBy = .provider
    @State private var metric: UsageMetric = .tokens

    private var requestID: String {
        "\(reloadID)-\(range.rawValue)-\(interval.rawValue)-\(groupBy.rawValue)"
    }

    var body: some View {
        Group {
            switch state {
            case .idle, .loading:
                ContentUnavailableView {
                    ProgressView()
                } description: {
                    Text("正在读取用量…")
                }
            case .loaded(let response):
                UsageChartContent(response: response, range: range, interval: interval, metric: metric)
            case .failed(let message):
                ContentUnavailableView {
                    Label("无法读取用量", systemImage: "exclamationmark.triangle")
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
        .safeAreaInset(edge: .top, spacing: 0) {
            usageFilters
                .padding(.horizontal)
                .padding(.vertical, 8)
                .background(.bar)
        }
        .task(id: requestID) {
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
        .refreshable {
            await load(showLoading: false)
        }
    }

    private var usageFilters: some View {
        Group {
            if usesWideLayout {
                HStack(spacing: 16) {
                    Picker("范围", selection: $range) {
                        ForEach(UsageRange.allCases) { range in
                            Text(range.title).tag(range)
                        }
                    }
                    .pickerStyle(.segmented)
                    .frame(maxWidth: 380)

                    Divider()
                        .frame(height: 22)

                    compactFilterPickers
                    Spacer(minLength: 0)
                }
            } else {
                VStack(spacing: 8) {
                    Picker("范围", selection: $range) {
                        ForEach(UsageRange.allCases) { range in
                            Text(range.title).tag(range)
                        }
                    }
                    .pickerStyle(.segmented)

                    compactFilterPickers
                }
            }
        }
    }

    private var compactFilterPickers: some View {
        HStack(spacing: 12) {
            Picker("间隔", selection: $interval) {
                ForEach(UsageInterval.allCases) { interval in
                    Text(interval.title).tag(interval)
                }
            }
            Picker("分组", selection: $groupBy) {
                ForEach(UsageGroupBy.allCases) { groupBy in
                    Text(groupBy.title).tag(groupBy)
                }
            }
            Picker("指标", selection: $metric) {
                ForEach(UsageMetric.allCases) { metric in
                    Text(metric.title).tag(metric)
                }
            }
        }
        .font(.caption)
    }

    private var usesWideLayout: Bool {
#if os(macOS)
        true
#elseif os(iOS)
        horizontalSizeClass == .regular
#else
        true
#endif
    }

    @MainActor
    private func load(showLoading: Bool) async {
        if showLoading, case .loaded = state {
            // 筛选变动时保留图表，等新数据返回后再替换。
        } else if showLoading {
            state = .loading
        }

        do {
            let start = Calendar.current.date(byAdding: .day, value: -range.rawValue, to: Date()) ?? Date()
            let response = try await QuotaAPIClient(configuration: configuration).fetchUsageTimeseries(
                from: start,
                // 服务端日聚合使用 UTC；始终获取小时桶，按本地日重新归并，避免跨日偏移。
                interval: .hour,
                groupBy: groupBy
            )
            guard !Task.isCancelled else { return }
            state = .loaded(response)
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled else { return }
            state = .failed(error.localizedDescription)
        }
    }
}

private struct UsageChartContent: View {
    let response: UsageTimeseriesResponse
    let range: UsageRange
    let interval: UsageInterval
    let metric: UsageMetric

#if os(iOS)
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
#endif

    private var buckets: [UsageBucket] {
        let calendar = Calendar.current
        let grouped = Dictionary(grouping: response.rows.compactMap { row -> (Date, UsageSnapshot)? in
            guard let date = row.date else { return nil }
            if interval == .day {
                return (calendar.startOfDay(for: date), row)
            }
            return (calendar.dateInterval(of: .hour, for: date)?.start ?? date, row)
        }) { $0.0 }

        return grouped.map { date, entries in
            let values = Dictionary(grouping: entries.map(\.1), by: \.series)
                .map { series, rows in
                    UsageSeriesValue(
                        series: series,
                        value: rows.reduce(0) { partial, row in
                            partial + (metric == .tokens ? row.totalTokens : row.costUsd)
                        }
                    )
                }
                .sorted { $0.series < $1.series }
            return UsageBucket(date: date, values: values)
        }
        .sorted { $0.date < $1.date }
    }

    private var series: [String] {
        Array(Set(buckets.flatMap { $0.values.map(\.series) })).sorted()
    }

    private var totals: [(series: String, value: Double)] {
        Dictionary(grouping: response.rows, by: \.series)
            .map { series, rows in
                (series, rows.reduce(0) { $0 + (metric == .tokens ? $1.totalTokens : $1.costUsd) })
            }
            .sorted { $0.value > $1.value }
    }

    var body: some View {
        Group {
            if buckets.isEmpty {
                ContentUnavailableView(
                    "暂无用量",
                    systemImage: "chart.bar.xaxis",
                    description: Text("客户端上报用量后会自动显示在这里。")
                )
            } else if usesWideLayout {
                ScrollView {
                    VStack(spacing: 16) {
                        DashboardCard(title: "\(rangeDescription) · \(groupDescription)") {
                            usageChart
                                .frame(minHeight: 280)
                        }

                        HStack(alignment: .top, spacing: 16) {
                            DashboardCard(title: "图例") {
                                legendContent
                            }
                            .frame(maxWidth: .infinity, alignment: .top)

                            DashboardCard(title: metric == .tokens ? "总 Token" : "估算花费") {
                                totalsContent
                            }
                            .frame(maxWidth: .infinity, alignment: .top)
                        }
                    }
                    .padding(20)
                    .frame(maxWidth: 1400)
                    .frame(maxWidth: .infinity)
                }
            } else {
                List {
                    Section {
                        usageChart
                            .frame(height: 260)
                    } header: {
                        Text("\(rangeDescription) · \(groupDescription)")
                    }

                    Section("图例") {
                        legendContent
                    }

                    Section(metric == .tokens ? "总 Token" : "估算花费") {
                        totalsContent
                    }
                }
#if os(macOS)
                .listStyle(.inset)
#else
                .listStyle(.insetGrouped)
#endif
            }
        }
    }

    private var usageChart: some View {
        Chart(buckets) { bucket in
            ForEach(bucket.values) { value in
                BarMark(
                    x: .value("时间", bucket.date),
                    y: .value(metric.title, value.value)
                )
                .foregroundStyle(by: .value("系列", value.series))
            }
        }
        .chartForegroundStyleScale(
            domain: series,
            range: series.map(usageSeriesColor)
        )
        .chartLegend(.hidden)
        .chartYScale(domain: .automatic(includesZero: true))
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: interval == .day ? 7 : 10)) { _ in
                AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5))
                AxisValueLabel(format: interval == .day
                    ? .dateTime.month(.defaultDigits).day()
                    : .dateTime.hour())
                    .font(.caption2)
            }
        }
        .chartYAxis {
            AxisMarks(position: .leading, values: .automatic(desiredCount: 5)) { value in
                AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5))
                AxisValueLabel {
                    Text(usageValue(value.as(Double.self) ?? 0))
                        .font(.caption2)
                }
            }
        }
        .accessibilityLabel("\(metric.title)用量图")
        .accessibilityValue(rangeDescription)
    }

    private var legendContent: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 110), alignment: .leading)], spacing: 10) {
            ForEach(series, id: \.self) { series in
                Label {
                    Text(series)
                        .lineLimit(1)
                } icon: {
                    Circle()
                        .fill(usageSeriesColor(series))
                        .frame(width: 9, height: 9)
                }
            }
        }
    }

    private var totalsContent: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 170), alignment: .leading)], spacing: 10) {
            ForEach(totals, id: \.series) { total in
                LabeledContent(total.series) {
                    Text(usageValue(total.value))
                        .monospacedDigit()
                        .foregroundStyle(usageSeriesColor(total.series))
                }
            }
        }
    }

    private var usesWideLayout: Bool {
#if os(macOS)
        true
#elseif os(iOS)
        horizontalSizeClass == .regular
#else
        true
#endif
    }

    private var rangeDescription: String { range.title }
    private var groupDescription: String { response.groupBy == UsageGroupBy.model.rawValue ? "按模型" : "按服务商" }

    private func usageValue(_ value: Double) -> String {
        if metric == .cost {
            return value.formatted(.currency(code: "USD"))
        }
        if abs(value) >= 1_000_000 {
            return (value / 1_000_000).formatted(.number.precision(.fractionLength(0...1))) + "M"
        }
        if abs(value) >= 1_000 {
            return (value / 1_000).formatted(.number.precision(.fractionLength(0...1))) + "k"
        }
        return value.formatted(.number.precision(.fractionLength(0...1)))
    }
}

private struct DashboardCard<Content: View>: View {
    let title: String
    let content: Content

    init(title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title)
                .font(.headline)
            content
        }
        .padding(18)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(.secondary.opacity(0.2), lineWidth: 0.5)
        }
    }
}

private struct UsageBucket: Identifiable {
    let date: Date
    let values: [UsageSeriesValue]

    var id: Date { date }
}

private struct UsageSeriesValue: Identifiable {
    let series: String
    let value: Double

    var id: String { series }
}

private func usageSeriesColor(_ series: String) -> Color {
    switch series.lowercased() {
    case "claude": return .orange
    case "codex", "openai": return .green
    case "kimi": return .purple
    case "copilot": return .blue
    case "cursor": return .cyan
    case "deepseek": return .indigo
    default:
        let palette: [Color] = [.pink, .teal, .mint, .yellow, .brown]
        let index = series.unicodeScalars.reduce(0) { $0 + Int($1.value) } % palette.count
        return palette[index]
    }
}

private enum UsageLoadState {
    case idle
    case loading
    case loaded(UsageTimeseriesResponse)
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

#Preview("用量图") {
    NavigationStack {
        UsageChartContent(
            response: UsageTimeseriesResponse(
                interval: "hour",
                groupBy: "provider",
                from: nil,
                to: nil,
                rows: [
                    UsageSnapshot(time: "2026-08-24T01:00:00Z", series: "codex", inputTokens: 4_200, outputTokens: 1_800, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.05, requests: 3),
                    UsageSnapshot(time: "2026-08-24T01:00:00Z", series: "claude", inputTokens: 2_400, outputTokens: 900, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.04, requests: 2),
                    UsageSnapshot(time: "2026-08-25T01:00:00Z", series: "codex", inputTokens: 7_800, outputTokens: 2_500, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.09, requests: 4),
                    UsageSnapshot(time: "2026-08-25T01:00:00Z", series: "claude", inputTokens: 1_200, outputTokens: 600, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.02, requests: 1),
                ]
            ),
            range: .week,
            interval: .day,
            metric: .tokens
        )
        .navigationTitle("用量")
    }
}
