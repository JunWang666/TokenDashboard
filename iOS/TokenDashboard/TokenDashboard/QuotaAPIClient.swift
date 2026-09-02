//
//  QuotaAPIClient.swift
//  TokenDashboard
//

import Foundation

struct APIConfiguration: Hashable, Sendable {
    var hubURL: String
    var authMode: AuthenticationMode
    var accessClientID: String
    var accessClientSecret: String
    var developerToken: String
    var accessCookieHeader: String

    var endpointURL: URL? {
        let value = hubURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: value),
              let scheme = url.scheme?.lowercased(),
              ["http", "https"].contains(scheme),
              url.host != nil else {
            return nil
        }
        return url
    }

    var isComplete: Bool {
        guard endpointURL != nil else { return false }
        switch authMode {
        case .webAccess:
            return !accessCookieHeader.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case .cloudflareAccess:
            return !accessClientID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                && !accessClientSecret.isEmpty
        case .developerToken:
            return !developerToken.isEmpty
        case .none:
            return true
        }
    }
}

enum AuthenticationMode: String, CaseIterable, Identifiable, Sendable {
    case webAccess
    case cloudflareAccess
    case developerToken
    case none

    var id: Self { self }

    var title: String {
        switch self {
        case .webAccess: "网页登录"
        case .cloudflareAccess: "Access Service Token"
        case .developerToken: "本地开发令牌"
        case .none: "无需鉴权"
        }
    }
}

struct QuotaAPIClient: Sendable {
    let configuration: APIConfiguration

    func fetchCurrentQuota() async throws -> QuotaCurrentResponse {
        let request = try makeRequest(
            pathComponents: ["api", "v1", "quota", "current"],
            method: "GET",
            timeoutInterval: 20
        )
        return try await send(request, as: QuotaCurrentResponse.self)
    }

    func fetchQuotaHistory(
        provider: String,
        metric: String,
        account: String,
        from: Date
    ) async throws -> QuotaHistoryResponse {
        let request = try makeRequest(
            pathComponents: ["api", "v1", "quota", "history"],
            method: "GET",
            timeoutInterval: 20,
            queryItems: [
                URLQueryItem(name: "provider", value: provider),
                URLQueryItem(name: "metric", value: metric),
                URLQueryItem(name: "account", value: account),
                URLQueryItem(name: "from", value: Self.iso8601String(from: from)),
            ]
        )
        return try await send(request, as: QuotaHistoryResponse.self)
    }

    func fetchUsageTimeseries(
        from: Date,
        interval: UsageInterval,
        groupBy: UsageGroupBy
    ) async throws -> UsageTimeseriesResponse {
        let request = try makeRequest(
            pathComponents: ["api", "v1", "usage", "timeseries"],
            method: "GET",
            timeoutInterval: 20,
            queryItems: [
                URLQueryItem(name: "from", value: Self.iso8601String(from: from)),
                URLQueryItem(name: "interval", value: interval.rawValue),
                URLQueryItem(name: "group_by", value: groupBy.rawValue),
            ]
        )
        return try await send(request, as: UsageTimeseriesResponse.self)
    }

    func collectNow() async throws -> Int {
        let request = try makeRequest(
            pathComponents: ["api", "v1", "collect"],
            method: "POST",
            timeoutInterval: 60
        )
        let response = try await send(request, as: CollectResponse.self)
        guard response.ok else {
            throw QuotaAPIError.collectionFailed(response.error ?? "服务器未返回错误原因。")
        }
        return response.rows ?? 0
    }

    func fetchCredentials() async throws -> CredentialListResponse {
        let request = try makeRequest(
            pathComponents: ["api", "v1", "credentials"],
            method: "GET",
            timeoutInterval: 20
        )
        return try await send(request, as: CredentialListResponse.self)
    }

    func pushSubscribe(token: String, environment: String) async throws {
        var request = try makeRequest(
            pathComponents: ["api", "v1", "push", "subscriptions"],
            method: "POST",
            timeoutInterval: 20
        )
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(
            PushSubscribeRequest(platform: "ios", endpoint: token, environment: environment)
        )
        let response = try await send(request, as: PushSubscriptionResponse.self)
        guard response.ok else {
            throw QuotaAPIError.pushSubscriptionFailed(response.error ?? "服务器未返回错误原因。")
        }
    }

    func pushUnsubscribe(token: String) async throws {
        var request = try makeRequest(
            pathComponents: ["api", "v1", "push", "subscriptions"],
            method: "DELETE",
            timeoutInterval: 20
        )
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(
            PushUnsubscribeRequest(endpoint: token)
        )
        let response = try await send(request, as: PushSubscriptionResponse.self)
        guard response.ok else {
            throw QuotaAPIError.pushSubscriptionFailed(response.error ?? "服务器未返回错误原因。")
        }
    }

    func pushTest(token: String) async throws -> PushTestResponse {
        var request = try makeRequest(
            pathComponents: ["api", "v1", "push", "test"],
            method: "POST",
            timeoutInterval: 20
        )
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(
            PushUnsubscribeRequest(endpoint: token)
        )
        return try await send(request, as: PushTestResponse.self)
    }

    func createCredential(
        provider: String,
        name: String,
        payload: [String: String]
    ) async throws -> CredentialWriteResponse {
        try await writeCredential(
            provider: provider,
            name: name,
            payload: payload,
            method: "PUT"
        )
    }

    func updateCredential(
        provider: String,
        name: String,
        payload: [String: String]
    ) async throws -> CredentialWriteResponse {
        try await writeCredential(
            provider: provider,
            name: name,
            payload: payload,
            method: "PATCH"
        )
    }

    private func writeCredential(
        provider: String,
        name: String,
        payload: [String: String],
        method: String
    ) async throws -> CredentialWriteResponse {
        var request = try makeRequest(
            pathComponents: ["api", "v1", "credentials", provider],
            method: method,
            timeoutInterval: 20
        )
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(
            CredentialWriteRequest(
                name: name.trimmingCharacters(in: .whitespacesAndNewlines),
                payload: payload
            )
        )
        return try await send(request, as: CredentialWriteResponse.self)
    }

    private func makeRequest(
        pathComponents: [String],
        method: String,
        timeoutInterval: TimeInterval,
        queryItems: [URLQueryItem] = []
    ) throws -> URLRequest {
        guard let baseURL = configuration.endpointURL else {
            throw QuotaAPIError.invalidHubURL
        }

        let endpoint = pathComponents.reduce(baseURL) { url, component in
            url.appendingPathComponent(component)
        }
        guard var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else {
            throw QuotaAPIError.invalidHubURL
        }
        components.queryItems = queryItems.isEmpty ? nil : queryItems
        guard let requestURL = components.url else {
            throw QuotaAPIError.invalidHubURL
        }
        var request = URLRequest(url: requestURL)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.timeoutInterval = timeoutInterval

        switch configuration.authMode {
        case .webAccess:
            guard !configuration.accessCookieHeader.isEmpty else {
                throw QuotaAPIError.missingWebLogin
            }
            request.setValue(configuration.accessCookieHeader, forHTTPHeaderField: "Cookie")
            request.setValue("XMLHttpRequest", forHTTPHeaderField: "X-Requested-With")
        case .cloudflareAccess:
            guard !configuration.accessClientID.isEmpty,
                  !configuration.accessClientSecret.isEmpty else {
                throw QuotaAPIError.missingCredentials
            }
            request.setValue(configuration.accessClientID, forHTTPHeaderField: "CF-Access-Client-Id")
            request.setValue(configuration.accessClientSecret, forHTTPHeaderField: "CF-Access-Client-Secret")
        case .developerToken:
            guard !configuration.developerToken.isEmpty else {
                throw QuotaAPIError.missingCredentials
            }
            request.setValue("Bearer \(configuration.developerToken)", forHTTPHeaderField: "Authorization")
        case .none:
            break
        }

        return request
    }

    private static func iso8601String(from date: Date) -> String {
        ISO8601DateFormatter().string(from: date)
    }

    private func send<Response: Decodable>(
        _ request: URLRequest,
        as responseType: Response.Type
    ) async throws -> Response {
        var authenticatedRequest = request
        if configuration.authMode == .webAccess,
           let requestURL = request.url,
           let currentCookie = await WebAccessCookieStore.cookieHeader(for: requestURL) {
            authenticatedRequest.setValue(currentCookie, forHTTPHeaderField: "Cookie")
            await AppSettings.persistRefreshedWebAccessCookie(currentCookie)
        }

        var exchange = try await perform(authenticatedRequest)
        if configuration.authMode == .webAccess,
           Self.shouldRefreshWebAccess(
               statusCode: exchange.response.statusCode,
               contentType: exchange.response.value(forHTTPHeaderField: "Content-Type")
           ),
           let requestURL = authenticatedRequest.url,
           let refreshedCookie = await WebAccessCookieStore.refreshCookieHeader(
               for: requestURL,
               replacing: authenticatedRequest.value(forHTTPHeaderField: "Cookie")
           ) {
            await AppSettings.persistRefreshedWebAccessCookie(refreshedCookie)
            authenticatedRequest.setValue(refreshedCookie, forHTTPHeaderField: "Cookie")
            exchange = try await perform(authenticatedRequest)
        }

        return try decode(exchange, as: responseType)
    }

    private func perform(_ request: URLRequest) async throws -> HTTPExchange {
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw QuotaAPIError.invalidResponse
        }
        return HTTPExchange(data: data, response: httpResponse)
    }

    private func decode<Response: Decodable>(
        _ exchange: HTTPExchange,
        as responseType: Response.Type
    ) throws -> Response {
        let data = exchange.data
        let httpResponse = exchange.response
        guard (200..<300).contains(httpResponse.statusCode) else {
            if httpResponse.statusCode == 401 || httpResponse.statusCode == 403 {
                throw QuotaAPIError.unauthorized
            }
            let detail = String(data: data, encoding: .utf8) ?? ""
            throw QuotaAPIError.server(status: httpResponse.statusCode, detail: detail)
        }

        guard httpResponse.value(forHTTPHeaderField: "Content-Type")?.lowercased().contains("json") == true else {
            throw QuotaAPIError.unexpectedContent
        }

        do {
            let decoder = JSONDecoder()
            decoder.keyDecodingStrategy = .convertFromSnakeCase
            return try decoder.decode(responseType, from: data)
        } catch {
            throw QuotaAPIError.decoding(error)
        }
    }

    static func shouldRefreshWebAccess(statusCode: Int, contentType: String?) -> Bool {
        if statusCode == 401 || statusCode == 403 {
            return true
        }
        return (200..<300).contains(statusCode)
            && contentType?.lowercased().contains("json") != true
    }
}

private struct HTTPExchange {
    let data: Data
    let response: HTTPURLResponse
}

private struct CollectResponse: Decodable, Sendable {
    let ok: Bool
    let rows: Int?
    let error: String?
}

private struct CredentialWriteRequest: Encodable, Sendable {
    let name: String
    let payload: [String: String]
}

private struct PushSubscribeRequest: Encodable, Sendable {
    let platform: String
    let endpoint: String
    let environment: String
}

private struct PushUnsubscribeRequest: Encodable, Sendable {
    let endpoint: String
}

private struct PushSubscriptionResponse: Decodable, Sendable {
    let ok: Bool
    let error: String?
}

struct PushTestResponse: Decodable, Sendable {
    let ok: Bool
    let retryable: Bool
    let invalidSubscription: Bool
    let status: Int?
    let reason: String
    let providerMessageId: String?
}

enum QuotaAPIError: LocalizedError {
    case invalidHubURL
    case missingWebLogin
    case missingCredentials
    case invalidResponse
    case unauthorized
    case unexpectedContent
    case collectionFailed(String)
    case pushSubscriptionFailed(String)
    case server(status: Int, detail: String)
    case decoding(Error)

    var errorDescription: String? {
        switch self {
        case .invalidHubURL:
            "Hub 地址无效，请在连接设置中填写完整的 http(s) 地址。"
        case .missingWebLogin:
            "尚未登录 Cloudflare Access，请打开连接设置完成网页登录。"
        case .missingCredentials:
            "鉴权信息未填写完整，请打开连接设置。"
        case .invalidResponse:
            "服务器返回了无法识别的响应。"
        case .unauthorized:
            "Cloudflare Access 登录已失效，请重新登录或检查鉴权信息。"
        case .unexpectedContent:
            "服务器返回的不是 JSON，可能被重定向到了 Cloudflare 登录页。"
        case .collectionFailed(let message):
            "采集失败：\(message)"
        case .pushSubscriptionFailed(let message):
            "推送订阅失败：\(message)"
        case .server(let status, let detail):
            "请求失败（\(status)）：\(detail.prefix(200))"
        case .decoding(let error):
            "额度数据格式不兼容：\(error.localizedDescription)"
        }
    }
}
