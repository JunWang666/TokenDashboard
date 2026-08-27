//
//  AppClipContentView.swift
//  TokenDashboardAppClip
//

import SwiftUI

struct AppClipContentView: View {
    @State private var presentedSheet: AppClipSheet?

    var body: some View {
        ConnectionGateView { settings in
            NavigationStack {
                QuotaDashboardView(
                    configuration: settings.configuration,
                    reloadID: settings.revision,
                    mode: .appClip,
                    onShowSettings: { presentedSheet = .connection }
                )
                .navigationTitle("额度速览")
                .navigationBarTitleDisplayMode(.inline)
            }
            .sheet(item: $presentedSheet) { _ in
                StartView(settings: settings)
                    .id(settings.revision)
            }
        }
    }
}

private enum AppClipSheet: String, Identifiable {
    case connection

    var id: String { rawValue }
}
