//
//  QuotaWidgetConfiguration.swift
//  TokenDashboardWidget
//

import AppIntents
import Foundation

struct ConfigureQuotaWidgetIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "额度显示"
    static var description = IntentDescription("为每个位置分别选择账号和它要显示的额度指标。")

    @Parameter(
        title: "账号 1",
        description: "小号组件显示这个账号；全部留空时自动显示可用账号。"
    )
    var account1: QuotaAccountEntity?

    @Parameter(
        title: "账号 1 的指标",
        description: "仅作用于账号 1；留空时显示该账号的默认指标。",
        default: [],
        size: [
            .systemSmall: .init(min: 0, max: 4),
            .systemMedium: .init(min: 0, max: 4),
        ]
    )
    var account1Metrics: [QuotaMetricEntity]

    @Parameter(title: "账号 2", description: "留空时不使用这个位置。")
    var account2: QuotaAccountEntity?

    @Parameter(
        title: "账号 2 的指标",
        description: "仅作用于账号 2；留空时显示该账号的默认指标。",
        default: [],
        size: [.systemMedium: .init(min: 0, max: 4)]
    )
    var account2Metrics: [QuotaMetricEntity]

    @Parameter(title: "账号 3", description: "留空时不使用这个位置。")
    var account3: QuotaAccountEntity?

    @Parameter(
        title: "账号 3 的指标",
        description: "仅作用于账号 3；留空时显示该账号的默认指标。",
        default: [],
        size: [.systemMedium: .init(min: 0, max: 4)]
    )
    var account3Metrics: [QuotaMetricEntity]

    @Parameter(title: "账号 4", description: "留空时不使用这个位置。")
    var account4: QuotaAccountEntity?

    @Parameter(
        title: "账号 4 的指标",
        description: "仅作用于账号 4；留空时显示该账号的默认指标。",
        default: [],
        size: [.systemMedium: .init(min: 0, max: 4)]
    )
    var account4Metrics: [QuotaMetricEntity]

    static var parameterSummary: some ParameterSummary {
        Summary("显示 \(\.$account1) \(\.$account1Metrics)，\(\.$account2) \(\.$account2Metrics)，\(\.$account3) \(\.$account3Metrics)，\(\.$account4) \(\.$account4Metrics)")
    }
}

struct QuotaAccountEntity: AppEntity, Hashable {
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "额度账号")
    static var defaultQuery = QuotaAccountQuery()

    let id: String
    let provider: String
    let account: String

    init(provider: String, account: String) {
        self.id = "\(provider)|\(account)"
        self.provider = provider
        self.account = account
    }

    init(id: String) {
        let components = id.split(separator: "|", maxSplits: 1, omittingEmptySubsequences: false)
        provider = components.first.map(String.init) ?? ""
        account = components.count > 1 ? String(components[1]) : ""
        self.id = id
    }

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(providerDisplayName) · \(accountDisplayName)")
    }

    private var providerDisplayName: String {
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

    private var accountDisplayName: String {
        account.isEmpty ? "默认账号" : account
    }
}

struct QuotaAccountQuery: EntityQuery {
    func entities(for identifiers: [QuotaAccountEntity.ID]) async throws -> [QuotaAccountEntity] {
        let available = Dictionary(uniqueKeysWithValues: WidgetIntentOptions.accounts.map { ($0.id, $0) })
        return identifiers.map { available[$0] ?? QuotaAccountEntity(id: $0) }
    }

    func suggestedEntities() async throws -> [QuotaAccountEntity] {
        WidgetIntentOptions.accounts
    }
}

struct QuotaMetricEntity: AppEntity, Hashable {
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "额度指标")
    static var defaultQuery = QuotaMetricQuery()

    let id: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(WidgetIntentOptions.metricTitle(id))")
    }
}

struct QuotaMetricQuery: EntityQuery {
    func entities(for identifiers: [QuotaMetricEntity.ID]) async throws -> [QuotaMetricEntity] {
        identifiers.map { QuotaMetricEntity(id: $0) }
    }

    func suggestedEntities() async throws -> [QuotaMetricEntity] {
        WidgetIntentOptions.metrics
    }
}

private enum WidgetIntentOptions {
    private static let appGroup = "group.com.gouzuang.TokenDashboard"
    private static let cacheKey = "widget.quotaRows"

    static var accounts: [QuotaAccountEntity] {
        let unique = Dictionary(grouping: cachedRows, by: { "\($0.provider)|\($0.account)" })
            .values
            .compactMap(\.first)
            .map { QuotaAccountEntity(provider: $0.provider, account: $0.account) }
        return unique.sorted {
            if $0.provider != $1.provider { return $0.provider < $1.provider }
            return $0.account < $1.account
        }
    }

    static var metrics: [QuotaMetricEntity] {
        Set(cachedRows.map(\.metric))
            .filter { $0 != "scrape_error" && $0 != "scrape_warn" }
            .map { QuotaMetricEntity(id: $0) }
            .sorted { metricTitle($0.id) < metricTitle($1.id) }
    }

    static func metricTitle(_ metric: String) -> String {
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

    private static var cachedRows: [IntentQuotaRow] {
        guard let defaults = UserDefaults(suiteName: appGroup),
              let data = defaults.data(forKey: cacheKey) else {
            return []
        }
        return (try? JSONDecoder().decode([IntentQuotaRow].self, from: data)) ?? []
    }
}

private struct IntentQuotaRow: Decodable {
    let provider: String
    let metric: String
    let account: String
}
