//
//  TokenDashboardApp.swift
//  TokenDashboard
//

import SwiftUI

@main
struct TokenDashboardApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
#if os(macOS)
        .defaultSize(width: 760, height: 680)
#endif
    }
}
