//
//  TokenDashboardTests.swift
//  TokenDashboardTests
//

import Foundation
import Testing
@testable import TokenDashboard

struct TokenDashboardTests {
    @Test @MainActor func decodesQuotaAndPreservesWebUsagePercent() throws {
        let data = Data(#"{"rows":[{"provider":"codex","metric":"session_used_pct","account":"personal","value":37,"limit_value":100,"unit":"percent","reset_at":null,"captured_at":"2026-08-23T12:00:00Z"}]}"#.utf8)
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase

        let response = try decoder.decode(QuotaCurrentResponse.self, from: data)

        #expect(response.rows.count == 1)
        #expect(response.rows[0].value == 37)
        #expect(response.rows[0].displayFraction == 0.37)
    }

    @Test @MainActor func copilotUsesSamePrimaryMetricAsWeb() {
        let used = QuotaSnapshot(
            provider: "copilot", metric: "premium_used", account: "default",
            value: 20, limitValue: 100, unit: "requests", resetAt: nil, capturedAt: "now"
        )
        let remaining = QuotaSnapshot(
            provider: "copilot", metric: "premium_remaining", account: "default",
            value: 80, limitValue: 100, unit: "requests", resetAt: nil, capturedAt: "now"
        )

        let rows = QuotaCurrentResponse(rows: [used, remaining]).displayRows

        #expect(rows == [used])
    }
}
