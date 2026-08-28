//
//  SharedDashboardView.swift
//  TokenDashboard
//

import Foundation
import SwiftUI

struct ConnectionGateView<Content: View>: View {
    @State private var settings = AppSettings()

    private let content: (AppSettings) -> Content

    init(@ViewBuilder content: @escaping (AppSettings) -> Content) {
        self.content = content
    }

    var body: some View {
        Group {
            if settings.isConfigured {
                content(settings)
                    .transition(.opacity)
            } else {
                StartView(settings: settings)
                    .id(settings.revision)
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: settings.isConfigured)
        .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
            guard let url = activity.webpageURL else { return }
            handleInvocation(url)
        }
        .onOpenURL(perform: handleInvocation)
    }

    private func handleInvocation(_ url: URL) {
        let invocation = HubInvocation(url: url)
        guard invocation.hubURL != nil || invocation.authenticationMode != nil else { return }

        settings.update(
            hubURL: invocation.hubURL ?? settings.hubURL,
            authMode: invocation.authenticationMode ?? settings.authMode,
            accessClientID: settings.accessClientID,
            accessClientSecret: settings.accessClientSecret,
            developerToken: settings.developerToken
        )
    }
}

enum QuotaDashboardMode {
    case fullApp
    case appClip

    var showsCollection: Bool { self == .fullApp }
    var showsCredentials: Bool { self == .fullApp }
    var showsRefreshButton: Bool { self == .appClip }
    var refreshesPeriodically: Bool { self == .fullApp }
}

struct QuotaDashboardView: View {
    let configuration: APIConfiguration
    let reloadID: Int
    let mode: QuotaDashboardMode
    let onShowCredentials: (() -> Void)?
    let onShowSettings: () -> Void
    let onRowsLoaded: ([QuotaSnapshot]) -> Void

#if os(iOS)
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
#endif
    @State private var state: QuotaLoadState = .idle
    @State private var isCollecting = false
    @State private var collectionNotice: CollectionNotice?

    init(
        configuration: APIConfiguration,
        reloadID: Int,
        mode: QuotaDashboardMode,
        onShowCredentials: (() -> Void)? = nil,
        onShowSettings: @escaping () -> Void,
        onRowsLoaded: @escaping ([QuotaSnapshot]) -> Void = { _ in }
    ) {
        self.configuration = configuration
        self.reloadID = reloadID
        self.mode = mode
        self.onShowCredentials = onShowCredentials
        self.onShowSettings = onShowSettings
        self.onRowsLoaded = onRowsLoaded
    }

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
            guard mode.refreshesPeriodically else { return }
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
                if mode.showsRefreshButton {
                    Button {
                        Task { await load(showLoading: false) }
                    } label: {
                        Label("刷新", systemImage: "arrow.clockwise")
                    }
                    .accessibilityIdentifier("appClipRefreshButton")
                }

                if mode.showsCollection {
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
                }

                if mode.showsCredentials, let onShowCredentials {
                    Button("凭证管理", systemImage: "key.horizontal", action: onShowCredentials)
                        .accessibilityIdentifier("credentialsButton")
                }

                Button("连接设置", systemImage: "gearshape", action: onShowSettings)
                    .accessibilityIdentifier(mode == .appClip ? "appClipSettingsButton" : "settingsButton")
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
        Group {
            if usesWideLayout {
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        HStack {
                            Label("\(rows.count) 项额度", systemImage: "rectangle.grid.2x2")
                            Spacer()
                            Text("更新于 ") + Text(refreshedAt, format: .dateTime.hour().minute().second())
                        }
                        .font(.subheadline)
                        .foregroundStyle(.secondary)

                        LazyVGrid(
                            columns: [GridItem(.adaptive(minimum: 300, maximum: 520), spacing: 16, alignment: .top)],
                            alignment: .leading,
                            spacing: 16
                        ) {
                            ForEach(QuotaGroup.group(rows)) { group in
                                QuotaGroupCard(group: group, configuration: configuration)
                            }
                        }
                    }
                    .padding(20)
                    .frame(maxWidth: 1400)
                    .frame(maxWidth: .infinity)
                }
                .refreshable {
                    await load(showLoading: false)
                }
            } else {
                List {
                    ForEach(QuotaGroup.group(rows)) { group in
                        Section {
                            ForEach(group.rows) { row in
                                quotaRow(row)
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

    @ViewBuilder
    private func quotaRow(_ row: QuotaSnapshot) -> some View {
        NavigationLink {
            QuotaHistoryDetailView(snapshot: row, configuration: configuration)
        } label: {
            QuotaRowView(snapshot: row)
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
            onRowsLoaded(rows)
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

private struct QuotaGroupCard: View {
    let group: QuotaGroup
    let configuration: APIConfiguration

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                Text(group.providerTitle)
                    .font(.headline)
                Spacer(minLength: 12)
                if !group.account.isEmpty {
                    Text(group.account)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)

            Divider()

            ForEach(Array(group.rows.enumerated()), id: \.element.id) { index, row in
                NavigationLink {
                    QuotaHistoryDetailView(snapshot: row, configuration: configuration)
                } label: {
                    HStack(spacing: 12) {
                        QuotaRowView(snapshot: row)
                        Image(systemName: "chevron.forward")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.tertiary)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 4)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                if index < group.rows.count - 1 {
                    Divider()
                        .padding(.leading, 16)
                }
            }
        }
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(.secondary.opacity(0.2), lineWidth: 0.5)
        }
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

struct QuotaRowView: View {
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

private struct QuotaTrendPoint: Hashable {
    let date: Date
    let value: Double
}

private struct QuotaHistoryChart: View {
    let snapshot: QuotaSnapshot
    let points: [QuotaTrendPoint]

    private let chartHeight: CGFloat = 168
    private let horizontalPlotInset: CGFloat = 5
    private let verticalPlotInset: CGFloat = 8

    var body: some View {
        if points.count >= 2 {
            VStack(alignment: .leading, spacing: 8) {
                Text("近 14 天趋势")
                    .font(.caption2)
                    .foregroundStyle(.secondary)

                HStack(alignment: .top, spacing: 8) {
                    VStack(alignment: .trailing) {
                        Text(chartValue(valueRange.upperBound))
                        Spacer()
                        Text(chartValue(valueRange.lowerBound))
                    }
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .frame(height: chartHeight)

                    Canvas { context, size in
                        let dates = dateRange
                        let values = valueRange
                        let plotBounds = CGRect(
                            x: horizontalPlotInset,
                            y: verticalPlotInset,
                            width: max(size.width - horizontalPlotInset * 2, 0),
                            height: max(size.height - verticalPlotInset * 2, 0)
                        )

                        for position in [0.0, 0.5, 1.0] {
                            var gridLine = Path()
                            let y = plotBounds.minY + plotBounds.height * position
                            gridLine.move(to: CGPoint(x: plotBounds.minX, y: y))
                            gridLine.addLine(to: CGPoint(x: plotBounds.maxX, y: y))
                            context.stroke(
                                gridLine,
                                with: .color(.secondary.opacity(0.2)),
                                lineWidth: 0.5
                            )
                        }

                        var line = Path()
                        for (index, point) in points.enumerated() {
                            let location = location(
                                for: point,
                                in: plotBounds,
                                dates: dates,
                                values: values
                            )
                            if index == points.startIndex {
                                line.move(to: location)
                            } else {
                                line.addLine(to: location)
                            }
                        }
                        context.stroke(
                            line,
                            with: .color(snapshot.tint),
                            style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round)
                        )

                        if let last = points.last {
                            let location = location(
                                for: last,
                                in: plotBounds,
                                dates: dates,
                                values: values
                            )
                            let marker = Path(
                                ellipseIn: CGRect(
                                    x: location.x - 3,
                                    y: location.y - 3,
                                    width: 6,
                                    height: 6
                                )
                            )
                            context.fill(marker, with: .color(snapshot.tint))
                        }
                    }
                    .frame(height: chartHeight)
                    .accessibilityLabel("\(snapshot.metricTitle)近 14 天趋势")
                }

                HStack {
                    if let first = points.first {
                        Text(first.date.formatted(.dateTime.month().day()))
                    }
                    Spacer()
                    if let last = points.last {
                        Text(last.date.formatted(.dateTime.month().day().hour()))
                    }
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
            }
            .padding(.top, 2)
        } else if !points.isEmpty {
            Text("正在积累趋势数据")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    private var valueRange: ClosedRange<Double> {
        let values = points.map(\.value)
        let minimum = min(values.min() ?? 0, 0)
        let maximum = max(values.max() ?? 0, 0)
        if minimum == maximum {
            return minimum...(minimum + 1)
        }
        return minimum...maximum
    }

    private var dateRange: ClosedRange<TimeInterval> {
        let lower = points.first?.date.timeIntervalSinceReferenceDate ?? 0
        let upper = points.last?.date.timeIntervalSinceReferenceDate ?? lower
        return lower...(upper > lower ? upper : lower + 1)
    }

    private func location(
        for point: QuotaTrendPoint,
        in bounds: CGRect,
        dates: ClosedRange<TimeInterval>,
        values: ClosedRange<Double>
    ) -> CGPoint {
        let x = (point.date.timeIntervalSinceReferenceDate - dates.lowerBound)
            / (dates.upperBound - dates.lowerBound)
        let y = (point.value - values.lowerBound)
            / (values.upperBound - values.lowerBound)
        return CGPoint(
            x: bounds.minX + min(max(x, 0), 1) * bounds.width,
            y: bounds.maxY - min(max(y, 0), 1) * bounds.height
        )
    }

    private func chartValue(_ value: Double) -> String {
        if snapshot.isPercentMetric {
            return value.formatted(.number.precision(.fractionLength(0))) + "%"
        }
        if abs(value) >= 1_000 {
            return (value / 1_000).formatted(.number.precision(.fractionLength(0...1))) + "k"
        }
        return value.formatted(.number.precision(.fractionLength(0...1)))
    }
}

private struct QuotaHistoryDetailView: View {
    let snapshot: QuotaSnapshot
    let configuration: APIConfiguration

    @State private var state: QuotaHistoryLoadState = .loading

    var body: some View {
        List {
            Section {
                QuotaRowView(snapshot: snapshot)
            }

            Section("趋势") {
                switch state {
                case .loading:
                    HStack {
                        Spacer()
                        ProgressView("正在读取趋势…")
                        Spacer()
                    }
                    .listRowSeparator(.hidden)
                case .loaded(let history):
                    QuotaHistoryChart(snapshot: snapshot, points: history)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .listRowSeparator(.hidden)
                case .failed(let message):
                    ContentUnavailableView(
                        "无法读取趋势",
                        systemImage: "exclamationmark.triangle",
                        description: Text(message)
                    )
                    .listRowSeparator(.hidden)
                }
            }
        }
#if os(macOS)
        .listStyle(.inset)
#else
        .listStyle(.insetGrouped)
#endif
        .navigationTitle(snapshot.metricTitle)
#if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
#endif
        .task {
            await loadHistory()
        }
        .refreshable {
            await loadHistory()
        }
    }

    @MainActor
    private func loadHistory() async {
        state = .loading
        do {
            let from = Calendar.current.date(byAdding: .day, value: -14, to: Date()) ?? Date()
            let response = try await QuotaAPIClient(configuration: configuration).fetchQuotaHistory(
                provider: snapshot.provider,
                metric: snapshot.metric,
                account: snapshot.account,
                from: from
            )
            guard !Task.isCancelled else { return }
            state = .loaded(Self.trendPoints(from: response.rows))
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled else { return }
            state = .failed(error.localizedDescription)
        }
    }

    private static func trendPoints(from rows: [QuotaSnapshot]) -> [QuotaTrendPoint] {
        let maximumPointCount = 80
        let sampledRows: [QuotaSnapshot]
        if rows.count > maximumPointCount {
            let lastIndex = rows.count - 1
            sampledRows = (0..<maximumPointCount).map { position in
                let index = Int(
                    (Double(position) * Double(lastIndex) / Double(maximumPointCount - 1)).rounded()
                )
                return rows[index]
            }
        } else {
            sampledRows = rows
        }

        // /quota/history guarantees captured_at ascending, so sample before date parsing.
        return sampledRows.compactMap { snapshot in
            snapshot.capturedDate.map { QuotaTrendPoint(date: $0, value: snapshot.value) }
        }
    }
}

private struct CollectionNotice: Identifiable {
    let id = UUID()
    let title: String
    let message: String
}

private enum QuotaLoadState {
    case idle
    case loading
    case loaded([QuotaSnapshot], Date)
    case failed(String)
}

private enum QuotaHistoryLoadState {
    case loading
    case loaded([QuotaTrendPoint])
    case failed(String)
}
