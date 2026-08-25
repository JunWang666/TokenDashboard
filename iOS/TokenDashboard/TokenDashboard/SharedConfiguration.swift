//
//  SharedConfiguration.swift
//  TokenDashboard
//

import Foundation

enum SharedConfiguration {
    static let appGroup = "group.com.gouzuang.TokenDashboard"
    static let widgetCacheKey = "widget.quotaRows"

    static var defaults: UserDefaults {
        UserDefaults(suiteName: appGroup) ?? .standard
    }
}
