//
//  SharedConfiguration.swift
//  TokenDashboard
//

import Foundation

enum SharedConfiguration {
    static let appGroup = "group.com.gouzuang.TokenDashboard"
    static let keychainAccessGroup = "4RN53WGN2C.com.gouzuang.TokenDashboard.shared"
    static let widgetCacheKey = "widget.quotaRows"

    static var defaults: UserDefaults {
        UserDefaults(suiteName: appGroup) ?? .standard
    }
}
