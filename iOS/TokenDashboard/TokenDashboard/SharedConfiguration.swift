//
//  SharedConfiguration.swift
//  TokenDashboard
//

import Foundation

enum SharedConfiguration {
    static let appGroup = "group.com.gouzuang.TokenDashboard"
    static let keychainAccessGroup: String? = {
#if APP_CLIP
        // App Clips use their default keychain access group unless the
        // App Clip's provisioning profile explicitly grants a shared group.
        return nil
#else
        return "4RN53WGN2C.com.gouzuang.TokenDashboard.shared"
#endif
    }()
    static let widgetCacheKey = "widget.quotaRows"

    static var defaults: UserDefaults {
        UserDefaults(suiteName: appGroup) ?? .standard
    }
}
