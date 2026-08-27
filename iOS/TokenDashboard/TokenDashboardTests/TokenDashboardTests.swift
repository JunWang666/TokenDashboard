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

    @Test @MainActor func claudeCookieRecipeUploadsOnlySessionKey() throws {
        let payload = try ProviderCookieRecipe.claude.payload(from: [
            cookie(name: "sessionKey", value: "sk-ant-test", domain: ".claude.ai"),
            cookie(name: "analytics", value: "ignored", domain: ".claude.ai"),
        ])

        #expect(payload == ["session_key": "sk-ant-test"])
    }

    @Test @MainActor func cursorCookieRecipeUploadsCompleteCursorCookieHeader() throws {
        let payload = try ProviderCookieRecipe.cursor.payload(from: [
            cookie(name: "WorkosCursorSessionToken", value: "token", domain: ".cursor.com"),
            cookie(name: "other", value: "value", domain: "www.cursor.com"),
            cookie(name: "unrelated", value: "ignored", domain: ".example.com"),
        ])

        #expect(payload["session"] == "WorkosCursorSessionToken=token; other=value")
    }

    @Test @MainActor func providerFieldsStayAlignedWithWebCredentialSchema() {
        #expect(CredentialProvider.find("claude").primary.key == "session_key")
        #expect(CredentialProvider.find("cursor").primary.key == "session")
        #expect(CredentialProvider.find("kimi").extra?.key == "web_token")
        #expect(CredentialProvider.all.count == 11)
    }

    @Test @MainActor func kimiAuthorizationRecipeExtractsBearerTokenFromAPIV2Only() throws {
        let payload = try ProviderAuthorizationRecipe.kimi.payload(
            requestURL: "https://www.kimi.com/apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats",
            authorization: "Bearer web-token-test"
        )

        #expect(payload == ["web_token": "web-token-test"])

        var rejectedForeignDomain = false
        do {
            _ = try ProviderAuthorizationRecipe.kimi.payload(
                requestURL: "https://example.com/apiv2/usage",
                authorization: "Bearer must-not-upload"
            )
        } catch {
            rejectedForeignDomain = true
        }
        #expect(rejectedForeignDomain)
    }

    @Test @MainActor func codexAuthorizationRecipeExtractsChatGPTAccessToken() throws {
        let payload = try ProviderAuthorizationRecipe.codex.payload(
            requestURL: "https://chatgpt.com/backend-api/wham/usage",
            authorization: "bearer codex-web-token"
        )

        #expect(payload == ["access_token": "codex-web-token"])
    }

    @Test @MainActor func configurationRequiresEndpointAndSelectedAuthentication() {
        let base = APIConfiguration(
            hubURL: "https://token.example.com",
            authMode: .webAccess,
            accessClientID: "",
            accessClientSecret: "",
            developerToken: "",
            accessCookieHeader: ""
        )

        #expect(!base.isComplete)

        var web = base
        web.accessCookieHeader = "CF_Authorization=test"
        #expect(web.isComplete)

        var service = base
        service.authMode = .cloudflareAccess
        service.accessClientID = "client-id"
        service.accessClientSecret = "client-secret"
        #expect(service.isComplete)

        var invalidEndpoint = web
        invalidEndpoint.hubURL = "token.example.com"
        #expect(!invalidEndpoint.isComplete)
    }

    @Test @MainActor func webAccessCookieHeaderUsesCurrentMostSpecificCookies() throws {
        let url = try #require(URL(string: "https://token.example.com/api/v1/quota/current"))
        let now = Date()
        let cookies = [
            cookie(name: "CF_Authorization", value: "parent", domain: ".example.com"),
            cookie(name: "CF_Authorization", value: "current", domain: "token.example.com"),
            cookie(name: "CF_Binding", value: "binding", domain: "token.example.com"),
            expiringCookie(
                name: "CF_Authorization",
                value: "expired",
                domain: "token.example.com",
                expires: now.addingTimeInterval(-60)
            ),
            cookie(name: "CF_Authorization", value: "foreign", domain: "other.example.com"),
        ]

        let header = WebAccessCookieStore.cookieHeader(from: cookies, for: url, now: now)

        #expect(header == "CF_Authorization=current; CF_Binding=binding")
    }

    @Test @MainActor func webAccessRefreshDetectionCoversAccessResponsesOnly() {
        #expect(QuotaAPIClient.shouldRefreshWebAccess(statusCode: 401, contentType: "text/html"))
        #expect(QuotaAPIClient.shouldRefreshWebAccess(statusCode: 403, contentType: "application/json"))
        #expect(QuotaAPIClient.shouldRefreshWebAccess(statusCode: 200, contentType: "text/html"))
        #expect(!QuotaAPIClient.shouldRefreshWebAccess(statusCode: 200, contentType: "application/json"))
        #expect(!QuotaAPIClient.shouldRefreshWebAccess(statusCode: 500, contentType: "text/html"))
    }

    @Test @MainActor func invocationUsesCallingOriginAndAuthenticationHint() throws {
        let invocation = HubInvocation(
            url: try #require(URL(string: "https://token.example.com:8443/appclip?auth=none"))
        )

        #expect(invocation.hubURL == "https://token.example.com:8443")
        #expect(invocation.authenticationMode == AuthenticationMode.none)
    }

    @Test @MainActor func invocationPrefersExplicitHubURL() throws {
        let invocation = HubInvocation(
            url: try #require(URL(string: "https://clip.example.com/open?hub=https%3A%2F%2Ftoken.example.com%2F&auth=web"))
        )

        #expect(invocation.hubURL == "https://token.example.com")
        #expect(invocation.authenticationMode == .webAccess)
    }

    @Test @MainActor func defaultAppleAppClipURLDoesNotBecomeHub() throws {
        let invocation = HubInvocation(
            url: try #require(URL(string: "https://appclip.apple.com/id?p=com.gouzuang.TokenDashboard.Clip"))
        )

        #expect(invocation.hubURL == nil)
    }

    private func cookie(name: String, value: String, domain: String) -> HTTPCookie {
        HTTPCookie(properties: [
            .name: name,
            .value: value,
            .domain: domain,
            .path: "/",
            .secure: "TRUE",
        ])!
    }

    private func expiringCookie(
        name: String,
        value: String,
        domain: String,
        expires: Date
    ) -> HTTPCookie {
        HTTPCookie(properties: [
            .name: name,
            .value: value,
            .domain: domain,
            .path: "/",
            .secure: "TRUE",
            .expires: expires,
        ])!
    }
}
