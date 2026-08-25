//
//  WidgetCache.swift
//  TokenDashboard
//

import Foundation
import WidgetKit

enum WidgetCache {
    static func save(_ rows: [QuotaSnapshot]) {
        guard let data = try? JSONEncoder().encode(rows) else { return }
        SharedConfiguration.defaults.set(data, forKey: SharedConfiguration.widgetCacheKey)
        WidgetCenter.shared.reloadTimelines(ofKind: "TokenDashboardQuotaWidget")
    }
}
