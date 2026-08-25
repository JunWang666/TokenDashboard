//
//  QuotaModels.swift
//  TokenDashboard
//

import SwiftUI

struct QuotaCurrentResponse: Codable {
    let rows: [QuotaSnapshot]

    /// 与 Web 的 quotaDisplay 保持一致：按 provider 选择主指标，不展示采集错误占位行。
    var displayRows: [QuotaSnapshot] {
        let errorMetrics = Set(["scrape_error", "scrape_warn"])
        let validRows = rows.filter { !errorMetrics.contains($0.metric) }
        let groups = Dictionary(grouping: validRows) { "\($0.provider)|\($0.account)" }

        return groups.values.flatMap { snapshots -> [QuotaSnapshot] in
            guard let provider = snapshots.first?.provider.lowercased() else { return [] }
            let by: (String) -> QuotaSnapshot? = { metric in
                snapshots.first { $0.metric == metric }
            }
            let existing: ([String]) -> [QuotaSnapshot] = { metrics in
                metrics.compactMap(by)
            }

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
            case "anyrouter":
                return existing([
                    "balance_usd",
                    "monthly_balance_usd",
                    "topup_balance_usd",
                    "today_cost_usd",
                    "used_usd",
                ])
            default:
                return snapshots
            }
        }
    }
}

struct QuotaSnapshot: Codable, Identifiable, Hashable {
    let provider: String
    let metric: String
    let account: String
    let value: Double
    let limitValue: Double?
    let unit: String?
    let resetAt: String?
    let capturedAt: String

    var id: String { "\(provider)|\(account)|\(metric)" }

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

    var formattedLimit: String? {
        guard let limit = isPercentMetric ? 100 : limitValue, limit > 0 else { return nil }
        if isPercentMetric {
            return limit.formatted(.number.precision(.fractionLength(1))) + "%"
        }
        return limit.formatted(.number.precision(.fractionLength(0...2)))
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

    var tint: Color {
        guard let displayFraction else { return .accentColor }
        if displayFraction >= 0.9 { return .red }
        return .green
    }

    var resetDate: Date? { Self.parseDate(resetAt) }

    var capturedDateText: String {
        guard let date = Self.parseDate(capturedAt) else { return capturedAt }
        return date.formatted(.dateTime.month().day().hour().minute())
    }

    private var isPercentMetric: Bool {
        unit == "percent" || metric.hasSuffix("_pct") || metric.contains("_pct_")
    }

    private static func parseDate(_ string: String?) -> Date? {
        guard let string else { return nil }
        let normalized = string
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
}

struct QuotaGroup: Identifiable {
    let provider: String
    let account: String
    let rows: [QuotaSnapshot]

    var id: String { "\(provider)|\(account)" }

    var providerTitle: String {
        switch provider.lowercased() {
        case "codex": return "Codex"
        case "openai": return "OpenAI"
        case "claude": return "Claude"
        case "kimi": return "Kimi"
        case "copilot": return "GitHub Copilot"
        case "deepseek": return "DeepSeek"
        case "glm": return "GLM"
        case "cursor": return "Cursor"
        case "minimax": return "MiniMax Token Plan"
        case "zai": return "Z.ai Coding Plan"
        case "anyrouter": return "AnyRouter"
        default: return provider.capitalized
        }
    }

    static func group(_ rows: [QuotaSnapshot]) -> [QuotaGroup] {
        let grouped = Dictionary(grouping: rows) { "\($0.provider)|\($0.account)" }
        return grouped.values
            .compactMap { snapshots in
                guard let first = snapshots.first else { return nil }
                return QuotaGroup(
                    provider: first.provider,
                    account: first.account,
                    rows: snapshots.sorted {
                        let lhs = metricOrder.firstIndex(of: $0.metric) ?? Int.max
                        let rhs = metricOrder.firstIndex(of: $1.metric) ?? Int.max
                        return lhs == rhs ? $0.metric < $1.metric : lhs < rhs
                    }
                )
            }
            .sorted {
                if $0.provider == $1.provider { return $0.account < $1.account }
                let lhs = providerOrder.firstIndex(of: $0.provider) ?? Int.max
                let rhs = providerOrder.firstIndex(of: $1.provider) ?? Int.max
                return lhs == rhs ? $0.provider < $1.provider : lhs < rhs
            }
    }

    private static let providerOrder = [
        "claude", "codex", "kimi", "minimax", "zai", "anyrouter",
        "openai", "copilot", "glm", "deepseek", "cursor",
    ]

    private static let metricOrder = [
        "weekly_used_pct", "session_used_pct", "monthly_used_pct", "monthly_mcp_used_pct",
        "auto_used_pct", "api_used_pct", "plan_used_pct", "requests_used",
        "balance_usd", "monthly_balance_usd", "topup_balance_usd", "today_cost_usd",
        "used_usd", "month_cost_usd", "premium_used", "balance_cny",
    ]
}

extension QuotaSnapshot {
    static let previewSession = QuotaSnapshot(
        provider: "codex",
        metric: "session_used_pct",
        account: "personal",
        value: 37,
        limitValue: 100,
        unit: "percent",
        resetAt: "2026-08-23T18:00:00Z",
        capturedAt: "2026-08-23T15:30:00Z"
    )

    static let previewBalance = QuotaSnapshot(
        provider: "openai",
        metric: "balance_usd",
        account: "default",
        value: 18.42,
        limitValue: nil,
        unit: "usd",
        resetAt: nil,
        capturedAt: "2026-08-23T15:30:00Z"
    )
}
