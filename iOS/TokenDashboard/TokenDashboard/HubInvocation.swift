//
//  HubInvocation.swift
//  TokenDashboard
//

import Foundation

struct HubInvocation: Equatable {
    let hubURL: String?
    let authenticationMode: AuthenticationMode?

    init(url: URL) {
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let queryItems = components?.queryItems ?? []

        let explicitHubValue = queryItems
            .first(where: { $0.name.caseInsensitiveCompare("hub") == .orderedSame })?
            .value
        let explicitHub: String?
        if let explicitHubValue {
            explicitHub = Self.validHubURL(explicitHubValue)
        } else {
            explicitHub = nil
        }

        hubURL = explicitHub ?? Self.originURL(from: url)

        let authValue = queryItems
            .first(where: { $0.name.caseInsensitiveCompare("auth") == .orderedSame })?
            .value?
            .lowercased()
        switch authValue {
        case "web", "webaccess":
            authenticationMode = .webAccess
        case "access", "cloudflareaccess":
            authenticationMode = .cloudflareAccess
        case "developer", "developertoken":
            authenticationMode = .developerToken
        case "none":
            authenticationMode = AuthenticationMode.none
        default:
            authenticationMode = nil
        }
    }

    private static func validHubURL(_ value: String) -> String? {
        guard let url = URL(string: value),
              let scheme = url.scheme?.lowercased(),
              ["http", "https"].contains(scheme),
              url.host != nil else {
            return nil
        }
        return value.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }

    private static func originURL(from url: URL) -> String? {
        guard let scheme = url.scheme?.lowercased(),
              ["http", "https"].contains(scheme),
              let host = url.host,
              host != "appclip.apple.com",
              !host.hasSuffix(".appclip.apple.com") else {
            return nil
        }

        var components = URLComponents()
        components.scheme = scheme
        components.host = host
        components.port = url.port
        return components.url?.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }
}
