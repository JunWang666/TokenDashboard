//
//  TokenDashboardWidget.swift
//  TokenDashboardWidget
//

import AppIntents
import Security
import SwiftUI
import WidgetKit

private enum WidgetSharedConfiguration {
    static let appGroup = "group.com.gouzuang.TokenDashboard"
    static let keychainAccessGroup = "4RN53WGN2C.com.gouzuang.TokenDashboard.shared"
    static let keychainService = "com.gouzuang.TokenDashboard"
    static let cacheKey = "widget.quotaRows"

    static var defaults: UserDefaults {
        UserDefaults(suiteName: appGroup) ?? .standard
    }
}

private struct WidgetQuotaResponse: Decodable {
    let rows: [WidgetQuotaRow]

    var displayRows: [WidgetQuotaRow] {
        let errorMetrics = Set(["scrape_error", "scrape_warn"])
        let validRows = rows.filter { !errorMetrics.contains($0.metric) }
        let groups = Dictionary(grouping: validRows) { "\($0.provider)|\($0.account)" }

        return groups.values.flatMap { snapshots -> [WidgetQuotaRow] in
            guard let provider = snapshots.first?.provider.lowercased() else { return [] }
            let by: (String) -> WidgetQuotaRow? = { metric in
                snapshots.first { $0.metric == metric }
            }
            let existing: ([String]) -> [WidgetQuotaRow] = { metrics in metrics.compactMap(by) }

            switch provider {
            case "claude":
                return [by("weekly_used_pct") ?? by("session_used_pct")].compactMap { $0 }
            case "codex", "minimax":
                return existing(["weekly_used_pct", "session_used_pct"])
            case "kimi":
                return existing(["weekly_used_pct", "session_used_pct", "monthly_used_pct"])
            case "zai":
                return existing(["weekly_used_pct", "session_used_pct", "monthly_mcp_used_pct"])
            case "openai":
                return existing(["month_cost_usd"])
            case "copilot":
                return existing(["premium_used"])
            case "glm", "deepseek":
                return [by("balance_cny") ?? by("balance_usd")].compactMap { $0 }
            case "cursor":
                let splitPools = existing(["auto_used_pct", "api_used_pct"])
                if !splitPools.isEmpty { return splitPools }
                if let plan = by("plan_used_pct") { return [plan] }
                return existing(["requests_used"])
            case "anyrouter", "anyrouter_top":
                return existing([
                    "balance_usd", "monthly_balance_usd", "topup_balance_usd",
                    "today_cost_usd", "used_usd",
                ])
            default:
                return snapshots
            }
        }
    }
}

private struct WidgetQuotaRow: Codable, Identifiable, Hashable {
    let provider: String
    let metric: String
    let account: String
    let value: Double
    let limitValue: Double?
    let unit: String?
    let resetAt: String?
    let capturedAt: String

    var id: String { "\(provider)|\(account)|\(metric)" }
    var accountID: String { "\(provider)|\(account)" }

    var displayFraction: Double? {
        let limit = isPercentMetric ? 100 : limitValue
        guard let limit, limit > 0 else { return nil }
        return min(max(value / limit, 0), 1)
    }

    var formattedValue: String {
        switch unit {
        case _ where isPercentMetric:
            return value.formatted(.number.precision(.fractionLength(1))) + "%"
        case "usd", "USD":
            return value.formatted(.currency(code: "USD"))
        case "cny", "CNY":
            return value.formatted(.currency(code: "CNY"))
        case "usd_cents":
            return (value / 100).formatted(.currency(code: "USD"))
        case "requests":
            return value.formatted(.number.precision(.fractionLength(0)))
        case let currency? where currency.count == 3:
            return value.formatted(.currency(code: currency.uppercased()))
        default:
            return value.formatted(.number.precision(.fractionLength(0...2)))
        }
    }

    var metricTitle: String {
        if metric.hasPrefix("session_used_pct_") {
            return "5 小时 · \(metric.dropFirst("session_used_pct_".count))"
        }
        switch metric {
        case "weekly_used_pct": return "周额度"
        case "session_used_pct": return "5 小时窗口"
        case "monthly_used_pct": return "月额度"
        case "monthly_mcp_used_pct": return "月 MCP 额度"
        case "monthly_remaining": return "月剩余"
        case "credits_usd": return "充值余额"
        case "balance_usd": return "余额 USD"
        case "balance_cny": return "余额 CNY"
        case "month_cost_usd": return "本月花费"
        case "monthly_balance_usd": return "月度余额 USD"
        case "topup_balance_usd": return "充值余额 USD"
        case "used_usd": return "累计消费 USD"
        case "today_cost_usd": return "今日消费 USD"
        case "premium_used": return "高级请求已用"
        case "premium_remaining": return "高级请求剩余"
        case "auto_used_pct": return "Cursor Models"
        case "api_used_pct": return "Other Models"
        case "plan_used_pct": return "套餐用量"
        case "requests_used": return "已用额度"
        case "requests_remaining": return "剩余额度"
        default: return metric
        }
    }

    var resetDate: Date? {
        guard let resetAt else { return nil }
        let normalized = resetAt
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: " ", with: "T")
        let hasTimeZone = normalized.hasSuffix("Z")
            || normalized.range(of: #"[+-]\d{2}:?\d{2}$"#, options: .regularExpression) != nil
        let value = hasTimeZone ? normalized : normalized + "Z"

        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }

        let standard = ISO8601DateFormatter()
        standard.formatOptions = [.withInternetDateTime]
        return standard.date(from: value)
    }

    var providerTitle: String {
        switch provider.lowercased() {
        case "codex": "Codex"
        case "openai": "OpenAI API"
        case "claude": "Claude"
        case "copilot": "Copilot"
        case "glm": "GLM"
        case "minimax": "MiniMax Token Plan"
        case "zai": "Z.ai Coding Plan"
        case "anyrouter": "AnyRouter"
        case "anyrouter_top": "AnyRouter.top"
        default: provider.capitalized
        }
    }

    var compactMetricTitle: String {
        if metric.contains("weekly") { return "周" }
        if metric.contains("session") { return "窗口" }
        if metric.contains("monthly_mcp") { return "月 MCP" }
        if metric.contains("monthly") { return "月" }
        if metric.contains("premium") { return "Premium" }
        if metric.contains("requests") { return "请求" }
        if metric.contains("balance") { return "余额" }
        if metric.contains("credits") { return "Credits" }
        return metricTitle
    }

    private var isPercentMetric: Bool {
        unit == "percent" || metric.hasSuffix("_pct") || metric.contains("_pct_")
    }

    static let preview = WidgetQuotaRow(
        provider: "cursor",
        metric: "session_used_pct",
        account: "goudaijun",
        value: 37,
        limitValue: 100,
        unit: "percent",
        resetAt: "2026-08-23T18:00:00Z",
        capturedAt: "2026-08-23T15:30:00Z"
    )

    static let previewWeekly = WidgetQuotaRow(
        provider: "cursor",
        metric: "weekly_used_pct",
        account: "goudaijun",
        value: 24,
        limitValue: 100,
        unit: "percent",
        resetAt: "2026-08-29T18:00:00Z",
        capturedAt: "2026-08-23T15:30:00Z"
    )

    static let previewPremium = WidgetQuotaRow(
        provider: "cursor",
        metric: "premium_requests_used_pct",
        account: "goudaijun",
        value: 61,
        limitValue: 100,
        unit: "percent",
        resetAt: "2026-08-29T18:00:00Z",
        capturedAt: "2026-08-23T15:30:00Z"
    )
}

private struct QuotaEntry: TimelineEntry {
    let date: Date
    let rows: [WidgetQuotaRow]
    let errorMessage: String?
}

private struct WidgetAccountSelection {
    let accountID: String?
    let metricIDs: [String]
}

private extension ConfigureQuotaWidgetIntent {
    var accountSelections: [WidgetAccountSelection] {
        [
            WidgetAccountSelection(
                accountID: account1?.id,
                metricIDs: account1Metrics.map(\.id)
            ),
            WidgetAccountSelection(
                accountID: account2?.id,
                metricIDs: account2Metrics.map(\.id)
            ),
            WidgetAccountSelection(
                accountID: account3?.id,
                metricIDs: account3Metrics.map(\.id)
            ),
            WidgetAccountSelection(
                accountID: account4?.id,
                metricIDs: account4Metrics.map(\.id)
            ),
        ]
    }
}

private struct QuotaProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> QuotaEntry {
        QuotaEntry(
            date: Date(),
            rows: [.preview, .previewWeekly, .previewPremium],
            errorMessage: nil
        )
    }

    func snapshot(for configuration: ConfigureQuotaWidgetIntent, in context: Context) async -> QuotaEntry {
        if context.isPreview {
            return placeholder(in: context)
        }
        return QuotaEntry(
            date: Date(),
            rows: filtered(WidgetQuotaLoader.cachedRows(), using: configuration),
            errorMessage: nil
        )
    }

    func timeline(for configuration: ConfigureQuotaWidgetIntent, in context: Context) async -> Timeline<QuotaEntry> {
        let result = await WidgetQuotaLoader.load()
        let entry = QuotaEntry(
            date: Date(),
            rows: filtered(result.rows, using: configuration),
            errorMessage: result.errorMessage
        )
        let refreshDate = Calendar.current.date(byAdding: .minute, value: 15, to: Date())
            ?? Date(timeIntervalSinceNow: 900)
        return Timeline(entries: [entry], policy: .after(refreshDate))
    }

    private func filtered(
        _ rows: [WidgetQuotaRow],
        using configuration: ConfigureQuotaWidgetIntent
    ) -> [WidgetQuotaRow] {
        let selections = configuration.accountSelections
        let hasExplicitAccounts = selections.contains { $0.accountID != nil }

        if hasExplicitAccounts {
            var seenAccounts = Set<String>()
            return selections.flatMap { selection -> [WidgetQuotaRow] in
                guard let accountID = selection.accountID,
                      seenAccounts.insert(accountID).inserted else {
                    return []
                }
                return selectedRows(
                    from: rows,
                    accountID: accountID,
                    metricIDs: selection.metricIDs
                )
            }
        }

        // 新增 Widget 时保持零配置可用：自动选前四个账号，同时仍允许每个位置预选不同指标。
        let automaticAccountIDs = Set(rows.map(\.accountID)).sorted()
        return automaticAccountIDs.prefix(4).enumerated().flatMap { index, accountID in
            selectedRows(
                from: rows,
                accountID: accountID,
                metricIDs: selections[index].metricIDs
            )
        }
    }

    private func selectedRows(
        from rows: [WidgetQuotaRow],
        accountID: String,
        metricIDs: [String]
    ) -> [WidgetQuotaRow] {
        let accountRows = rows.filter { $0.accountID == accountID }
        if metricIDs.isEmpty {
            return Array(accountRows.sorted(by: metricSort).prefix(4))
        }

        let rowsByMetric = Dictionary(grouping: accountRows, by: \.metric)
        return metricIDs.prefix(4).compactMap { rowsByMetric[$0]?.first }
    }

    private func metricSort(_ lhs: WidgetQuotaRow, _ rhs: WidgetQuotaRow) -> Bool {
        let lhsRank = Self.defaultMetricRank(lhs.metric)
        let rhsRank = Self.defaultMetricRank(rhs.metric)
        if lhsRank != rhsRank { return lhsRank < rhsRank }
        return lhs.metric < rhs.metric
    }

    private static func defaultMetricRank(_ metric: String) -> Int {
        let order = [
            "weekly_used_pct", "session_used_pct", "monthly_used_pct", "monthly_mcp_used_pct",
            "auto_used_pct", "api_used_pct", "plan_used_pct", "requests_used",
            "balance_usd", "monthly_balance_usd", "topup_balance_usd", "today_cost_usd",
            "used_usd", "month_cost_usd", "premium_used", "balance_cny",
        ]
        return order.firstIndex(of: metric) ?? Int.max
    }
}

private enum WidgetQuotaLoader {
    struct Result {
        let rows: [WidgetQuotaRow]
        let errorMessage: String?
    }

    static func load() async -> Result {
        do {
            let rows = try await fetch()
            if let data = try? JSONEncoder().encode(rows) {
                WidgetSharedConfiguration.defaults.set(data, forKey: WidgetSharedConfiguration.cacheKey)
            }
            return Result(rows: rows, errorMessage: nil)
        } catch {
            let cached = cachedRows()
            return Result(
                rows: cached,
                errorMessage: cached.isEmpty ? error.localizedDescription : nil
            )
        }
    }

    static func cachedRows() -> [WidgetQuotaRow] {
        guard let data = WidgetSharedConfiguration.defaults.data(forKey: WidgetSharedConfiguration.cacheKey) else {
            return []
        }
        return (try? JSONDecoder().decode([WidgetQuotaRow].self, from: data)) ?? []
    }

    private static func fetch() async throws -> [WidgetQuotaRow] {
        let defaults = WidgetSharedConfiguration.defaults
        guard let rawHubURL = defaults.string(forKey: "settings.hubURL"),
              let baseURL = URL(string: rawHubURL),
              baseURL.host != nil else {
            throw WidgetLoadError.notConfigured
        }

        let endpoint = baseURL
            .appendingPathComponent("api")
            .appendingPathComponent("v1")
            .appendingPathComponent("quota")
            .appendingPathComponent("current")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 15

        switch defaults.string(forKey: "settings.authMode") {
        case "webAccess":
            guard let cookie = readSecret("accessCookieHeader"), !cookie.isEmpty else {
                throw WidgetLoadError.notLoggedIn
            }
            request.setValue(cookie, forHTTPHeaderField: "Cookie")
        case "cloudflareAccess":
            guard let clientID = defaults.string(forKey: "settings.accessClientID"),
                  let secret = readSecret("accessClientSecret") else {
                throw WidgetLoadError.notLoggedIn
            }
            request.setValue(clientID, forHTTPHeaderField: "CF-Access-Client-Id")
            request.setValue(secret, forHTTPHeaderField: "CF-Access-Client-Secret")
        case "developerToken":
            guard let token = readSecret("developerToken") else {
                throw WidgetLoadError.notLoggedIn
            }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        case "none":
            break
        default:
            throw WidgetLoadError.notConfigured
        }

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw WidgetLoadError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 401 || http.statusCode == 403 {
                throw WidgetLoadError.notLoggedIn
            }
            throw WidgetLoadError.server(http.statusCode)
        }

        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(WidgetQuotaResponse.self, from: data).displayRows
    }

    private static func readSecret(_ account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: WidgetSharedConfiguration.keychainService,
            kSecAttrAccount as String: account,
            kSecAttrAccessGroup as String: WidgetSharedConfiguration.keychainAccessGroup,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
}

private enum WidgetLoadError: LocalizedError {
    case notConfigured
    case notLoggedIn
    case invalidResponse
    case server(Int)

    var errorDescription: String? {
        switch self {
        case .notConfigured: "请先打开 App 完成配置"
        case .notLoggedIn: "请打开 App 重新登录"
        case .invalidResponse: "额度服务响应无效"
        case .server(let status): "额度服务错误（\(status)）"
        }
    }
}

private struct TokenDashboardWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: QuotaEntry

    private var groups: [WidgetAccountGroup] {
        WidgetAccountGroup.makeGroups(from: entry.rows)
    }

    var body: some View {
        Group {
            if groups.isEmpty {
                emptyView
            } else if family == .systemSmall {
                smallView(groups[0])
            } else {
                mediumView(Array(groups.prefix(4)))
            }
        }
        .padding(family == .systemSmall ? 10 : 8)
        .containerBackground(.fill.tertiary, for: .widget)
    }

    private var emptyView: some View {
        VStack(alignment: .leading, spacing: 8) {
            Image(systemName: "gauge.with.dots.needle.50percent")
                .font(.title)
                .foregroundStyle(.secondary)
            Text("额度")
                .font(.headline)
            Text(entry.errorMessage ?? "暂无额度数据")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    private func smallView(_ group: WidgetAccountGroup) -> some View {
        VStack(spacing: 3) {
            AccountIdentityView(group: group)

            ConcentricQuotaRings(
                rows: Array(group.rows.prefix(4))
            )
            .frame(width: 96, height: 96)

            ResetTimeView(date: group.nextResetDate)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func mediumView(_ groups: [WidgetAccountGroup]) -> some View {
        GeometryReader { proxy in
            let spacing: CGFloat = 5
            let count = CGFloat(max(groups.count, 1))
            let columnWidth = (proxy.size.width - spacing * (count - 1)) / count
            let ringSize = max(1, min(columnWidth, proxy.size.height - 34))

            HStack(alignment: .top, spacing: spacing) {
                ForEach(groups) { group in
                    VStack(spacing: 2) {
                        AccountIdentityView(group: group)

                        ConcentricQuotaRings(
                            rows: Array(group.rows.prefix(4))
                        )
                        .frame(width: ringSize, height: ringSize)

                        ResetTimeView(date: group.nextResetDate)
                    }
                    .frame(width: columnWidth)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

private struct AccountIdentityView: View {
    let group: WidgetAccountGroup

    var body: some View {
        VStack(spacing: -1) {
            Text(group.accountTitle)
                .font(.system(size: 10, weight: .bold, design: .rounded))
                .foregroundStyle(.primary)
            Text(group.providerTitle)
                .font(.system(size: 7.5, weight: .semibold))
                .foregroundStyle(.secondary)
        }
        .lineLimit(1)
        .minimumScaleFactor(0.55)
        .frame(maxWidth: .infinity)
    }
}

private struct WidgetAccountGroup: Identifiable {
    let provider: String
    let account: String
    let rows: [WidgetQuotaRow]

    var id: String { "\(provider)|\(account)" }
    var providerTitle: String { rows.first?.providerTitle ?? provider.capitalized }
    var accountTitle: String { account.isEmpty ? "默认账号" : account }
    var nextResetDate: Date? { rows.compactMap(\.resetDate).min() }

    static func makeGroups(from rows: [WidgetQuotaRow]) -> [WidgetAccountGroup] {
        var order: [String] = []
        var grouped: [String: [WidgetQuotaRow]] = [:]

        for row in rows {
            if grouped[row.accountID] == nil {
                order.append(row.accountID)
            }
            grouped[row.accountID, default: []].append(row)
        }

        return order.compactMap { id in
            guard let rows = grouped[id], let first = rows.first else { return nil }
            return WidgetAccountGroup(provider: first.provider, account: first.account, rows: rows)
        }
    }
}

private struct ConcentricQuotaRings: View {
    let rows: [WidgetQuotaRow]

    private var ringRows: [WidgetQuotaRow] {
        Array(rows.filter { $0.displayFraction != nil }.prefix(4))
    }

    var body: some View {
        GeometryReader { proxy in
            let lineWidth = max(3.5, min(6, proxy.size.width / 18.5))
            let spacing = max(1, lineWidth * 0.28)

            ZStack {
                ForEach(Array(ringRows.enumerated()), id: \.element.id) { index, row in
                    let inset = CGFloat(index) * (lineWidth + spacing) + lineWidth / 2
                    let color = WidgetRingPalette.color(for: row.metric, in: [])

                    Circle()
                        .inset(by: inset)
                        .stroke(color.opacity(0.14), lineWidth: lineWidth)

                    Circle()
                        .inset(by: inset)
                        .trim(from: 0, to: row.displayFraction ?? 0)
                        .stroke(
                            color,
                            style: StrokeStyle(lineWidth: lineWidth, lineCap: .round)
                        )
                        .rotationEffect(.degrees(-90))
                }

                if let primary = ringRows.first ?? rows.first {
                    VStack(spacing: -1) {
                        Text(primary.formattedValue)
                            .font(.system(
                                size: proxy.size.width < 85 ? 11 : 14,
                                weight: .bold,
                                design: .rounded
                            ))
                            .foregroundStyle(.primary)
                        Text(primary.compactMetricTitle)
                            .font(.system(size: proxy.size.width < 85 ? 6.5 : 8, weight: .semibold))
                            .foregroundStyle(.secondary)
                    }
                    .minimumScaleFactor(0.55)
                    .lineLimit(1)
                    .padding(CGFloat(ringRows.count) * (lineWidth + spacing) + 1)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("额度用量")
            .accessibilityValue(
                rows.map { "\($0.metricTitle)\($0.formattedValue)" }.joined(separator: "，")
            )
        }
    }
}

private struct ResetTimeView: View {
    let date: Date?

    var body: some View {
        if let date {
            HStack(spacing: 2) {
                Image(systemName: "arrow.clockwise")
                Text(date, style: .relative)
                    .monospacedDigit()
            }
            .font(.system(size: 8, weight: .medium))
            .foregroundStyle(.tertiary)
            .lineLimit(1)
            .minimumScaleFactor(0.7)
            .accessibilityLabel("重置时间")
        } else {
            Text("无重置时间")
                .font(.system(size: 8))
                .foregroundStyle(.tertiary)
        }
    }
}

private enum WidgetRingPalette {
    private static let fallback: [Color] = [
        color(52, 211, 153), color(56, 189, 248), color(167, 139, 250),
        color(251, 191, 36), color(251, 113, 133), color(244, 114, 182),
        color(45, 212, 191), color(129, 140, 248),
    ]

    static func color(for metric: String, in _: [String]) -> Color {
        switch metric {
        case "weekly_used_pct", "balance_usd", "premium_remaining", "plan_used_pct", "requests_remaining":
            return color(52, 211, 153)
        case "session_used_pct", "balance_cny", "auto_used_pct":
            return color(56, 189, 248)
        case "monthly_used_pct", "premium_used", "api_used_pct":
            return color(167, 139, 250)
        case "monthly_remaining":
            return color(192, 132, 252)
        case "credits_usd":
            return color(251, 191, 36)
        case "month_cost_usd", "requests_used":
            return color(251, 113, 133)
        default:
            if metric.hasPrefix("session_used_pct_") { return color(125, 211, 252) }
            let hash = metric.unicodeScalars.reduce(0) { ($0 &* 31) &+ Int($1.value) }
            return fallback[Int(hash.magnitude % UInt(fallback.count))]
        }
    }

    private static func color(_ red: Double, _ green: Double, _ blue: Double) -> Color {
        Color(red: red / 255, green: green / 255, blue: blue / 255)
    }
}

@main
struct TokenDashboardQuotaWidget: Widget {
    let kind = "TokenDashboardQuotaWidget"

    var body: some WidgetConfiguration {
        AppIntentConfiguration(
            kind: kind,
            intent: ConfigureQuotaWidgetIntent.self,
            provider: QuotaProvider()
        ) { entry in
            TokenDashboardWidgetView(entry: entry)
        }
        .configurationDisplayName("额度")
        .description("每个账号可独立选择指标，并用同心环查看最新额度用量。")
        .supportedFamilies([.systemSmall, .systemMedium])
        .contentMarginsDisabled()
    }
}

#Preview(as: .systemSmall) {
    TokenDashboardQuotaWidget()
} timeline: {
    QuotaEntry(date: .now, rows: [.preview, .previewWeekly, .previewPremium], errorMessage: nil)
}

#Preview(as: .systemMedium) {
    TokenDashboardQuotaWidget()
} timeline: {
    QuotaEntry(date: .now, rows: [.preview, .previewWeekly, .previewPremium], errorMessage: nil)
}
