//
//  TokenDashboardApp.swift
//  TokenDashboard
//

import SwiftUI

@main
struct TokenDashboardApp: App {
#if os(iOS)
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
#endif

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
#if os(macOS)
        .defaultSize(width: 1120, height: 760)
#endif
    }
}
