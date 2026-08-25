//
//  AppSettings.swift
//  TokenDashboard
//

import Foundation
import Observation
import Security

@MainActor
@Observable
final class AppSettings {
    private enum Key {
        static let hubURL = "settings.hubURL"
        static let authMode = "settings.authMode"
        static let accessClientID = "settings.accessClientID"
        static let accessClientSecret = "accessClientSecret"
        static let developerToken = "developerToken"
        static let accessCookieHeader = "accessCookieHeader"
    }

    private(set) var hubURL: String
    private(set) var authMode: AuthenticationMode
    private(set) var accessClientID: String
    private(set) var accessClientSecret: String
    private(set) var developerToken: String
    private(set) var accessCookieHeader: String
    private(set) var revision = 0

    var configuration: APIConfiguration {
        APIConfiguration(
            hubURL: hubURL,
            authMode: authMode,
            accessClientID: accessClientID,
            accessClientSecret: accessClientSecret,
            developerToken: developerToken,
            accessCookieHeader: accessCookieHeader
        )
    }

    var isConfigured: Bool { configuration.isComplete }

    init(defaults: UserDefaults? = nil) {
        let defaults = defaults ?? SharedConfiguration.defaults
        hubURL = defaults.string(forKey: Key.hubURL) ?? ""
        authMode = AuthenticationMode(
            rawValue: defaults.string(forKey: Key.authMode) ?? ""
        ) ?? .webAccess
        accessClientID = defaults.string(forKey: Key.accessClientID) ?? ""
        accessClientSecret = KeychainStore.read(Key.accessClientSecret) ?? ""
        developerToken = KeychainStore.read(Key.developerToken) ?? ""
        accessCookieHeader = KeychainStore.read(Key.accessCookieHeader) ?? ""
    }

    func update(
        hubURL: String,
        authMode: AuthenticationMode,
        accessClientID: String,
        accessClientSecret: String,
        developerToken: String
    ) {
        let trimmedURL = hubURL.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let trimmedID = accessClientID.trimmingCharacters(in: .whitespacesAndNewlines)

        self.hubURL = trimmedURL
        self.authMode = authMode
        self.accessClientID = trimmedID
        self.accessClientSecret = accessClientSecret
        self.developerToken = developerToken
        revision += 1

        let defaults = SharedConfiguration.defaults
        defaults.set(trimmedURL, forKey: Key.hubURL)
        defaults.set(authMode.rawValue, forKey: Key.authMode)
        defaults.set(trimmedID, forKey: Key.accessClientID)
        KeychainStore.write(accessClientSecret, key: Key.accessClientSecret)
        KeychainStore.write(developerToken, key: Key.developerToken)
    }

    func recordWebAccessCookie(_ cookieHeader: String) {
        accessCookieHeader = cookieHeader
        authMode = .webAccess
        revision += 1

        SharedConfiguration.defaults.set(AuthenticationMode.webAccess.rawValue, forKey: Key.authMode)
        KeychainStore.write(cookieHeader, key: Key.accessCookieHeader)
    }

    func clearWebAccessCookie() {
        accessCookieHeader = ""
        revision += 1
        KeychainStore.write("", key: Key.accessCookieHeader)
    }
}

private enum KeychainStore {
    private static let service = "com.gouzuang.TokenDashboard"

    static func read(_ key: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecAttrAccessGroup as String: SharedConfiguration.keychainAccessGroup,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func write(_ value: String, key: String) {
        let identity: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecAttrAccessGroup as String: SharedConfiguration.keychainAccessGroup,
        ]

        if value.isEmpty {
            SecItemDelete(identity as CFDictionary)
            return
        }

        let attributes: [String: Any] = [
            kSecValueData as String: Data(value.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemUpdate(identity as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var item = identity
            attributes.forEach { item[$0.key] = $0.value }
            SecItemAdd(item as CFDictionary, nil)
        }
    }
}
