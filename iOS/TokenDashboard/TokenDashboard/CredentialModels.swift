//
//  CredentialModels.swift
//  TokenDashboard
//

import Foundation

struct CredentialListResponse: Decodable, Sendable {
    let rows: [CredentialSummary]
}

struct CredentialSummary: Decodable, Hashable, Identifiable, Sendable {
    let provider: String
    let name: String
    let hint: String?
    let updatedAt: String
    let updatedBy: String?

    var id: String { "\(provider)/\(name)" }
}

struct CredentialWriteResponse: Decodable, Sendable {
    let ok: Bool
    let provider: String
    let name: String
    let hint: String?
}

struct CredentialField: Hashable, Sendable {
    let key: String
    let label: String
    let placeholder: String
}

struct CredentialProvider: Hashable, Identifiable, Sendable {
    let id: String
    let title: String
    let primary: CredentialField
    let extra: CredentialField?
    let hint: String?
    let cookieRecipe: ProviderCookieRecipe?

    static let all: [CredentialProvider] = [
        .init(
            id: "claude", title: "Claude",
            primary: .init(key: "session_key", label: "claude.ai sessionKey", placeholder: "sk-ant-sid01-..."),
            extra: nil,
            hint: "sessionKey 有效期较短，可直接通过本机网页登录采集。",
            cookieRecipe: .claude
        ),
        .init(
            id: "codex", title: "Codex",
            primary: .init(key: "access_token", label: "Codex access_token", placeholder: "eyJhbGciOi..."),
            extra: nil,
            hint: "来自 ~/.codex/auth.json 的 tokens.access_token，不是 API Key。",
            cookieRecipe: nil
        ),
        .init(
            id: "kimi", title: "Kimi",
            primary: .init(key: "api_key", label: "Kimi Code API Key", placeholder: "sk-kimi-..."),
            extra: .init(key: "web_token", label: "网页 access_token（可选）", placeholder: "eyJhbGciOi..."),
            hint: "网页 token 来自 /apiv2/ 请求的 Authorization 头，不属于 Cookie，需手动填写。",
            cookieRecipe: nil
        ),
        .init(
            id: "minimax", title: "MiniMax Token Plan",
            primary: .init(key: "api_key", label: "Token Plan Subscription Key", placeholder: "sk-cp-..."),
            extra: nil,
            hint: "请填写 Token Plan 套餐专属 Key。",
            cookieRecipe: nil
        ),
        .init(
            id: "zai", title: "Z.ai Coding Plan",
            primary: .init(key: "api_key", label: "Coding Plan API Key", placeholder: "填写套餐专属 API Key"),
            extra: nil,
            hint: nil,
            cookieRecipe: nil
        ),
        .init(
            id: "anyrouter", title: "AnyRouter",
            primary: .init(key: "api_key", label: "AnyRouter API Key", placeholder: "sk-ar-v1-..."),
            extra: nil,
            hint: "Key 需要启用 Management 权限。",
            cookieRecipe: nil
        ),
        .init(
            id: "openai", title: "OpenAI",
            primary: .init(key: "api_key", label: "Admin/Org API Key", placeholder: "sk-..."),
            extra: nil,
            hint: nil,
            cookieRecipe: nil
        ),
        .init(
            id: "copilot", title: "GitHub Copilot",
            primary: .init(key: "token", label: "GitHub Personal Token", placeholder: "ghp_..."),
            extra: nil,
            hint: nil,
            cookieRecipe: nil
        ),
        .init(
            id: "glm", title: "GLM",
            primary: .init(key: "api_key", label: "智谱 API Key", placeholder: "sk-..."),
            extra: nil,
            hint: nil,
            cookieRecipe: nil
        ),
        .init(
            id: "deepseek", title: "DeepSeek",
            primary: .init(key: "api_key", label: "DeepSeek API Key", placeholder: "sk-..."),
            extra: nil,
            hint: nil,
            cookieRecipe: nil
        ),
        .init(
            id: "cursor", title: "Cursor",
            primary: .init(key: "session", label: "Cursor Cookie 串", placeholder: "WorkosCursorSessionToken=..."),
            extra: nil,
            hint: "必须上传 cursor.com 域下的完整 Cookie 串。",
            cookieRecipe: .cursor
        ),
    ]

    static func find(_ id: String) -> CredentialProvider {
        all.first { $0.id == id }
            ?? .init(
                id: id, title: id,
                primary: .init(key: "value", label: "凭证", placeholder: ""),
                extra: nil, hint: nil, cookieRecipe: nil
            )
    }
}

enum ProviderCookieRecipe: String, Hashable, Identifiable, Sendable {
    case claude
    case cursor

    var id: String { rawValue }

    var title: String {
        switch self {
        case .claude: "Claude 网页登录"
        case .cursor: "Cursor 网页登录"
        }
    }

    var loginURL: URL {
        switch self {
        case .claude: URL(string: "https://claude.ai/login")!
        case .cursor: URL(string: "https://www.cursor.com/dashboard")!
        }
    }

    var targetDomain: String {
        switch self {
        case .claude: "claude.ai"
        case .cursor: "cursor.com"
        }
    }

    func payload(from cookies: [HTTPCookie]) throws -> [String: String] {
        let matching = cookies.filter { cookie in
            let domain = cookie.domain
                .trimmingCharacters(in: CharacterSet(charactersIn: "."))
                .lowercased()
            return domain == targetDomain || domain.hasSuffix(".\(targetDomain)")
        }

        switch self {
        case .claude:
            guard let session = matching.first(where: { $0.name == "sessionKey" }),
                  !session.value.isEmpty else {
                throw ProviderCookieError.notLoggedIn("没有找到 sessionKey，请先完成 Claude 登录。")
            }
            return ["session_key": session.value]
        case .cursor:
            guard matching.contains(where: { $0.name == "WorkosCursorSessionToken" && !$0.value.isEmpty }) else {
                throw ProviderCookieError.notLoggedIn("没有找到 Cursor 登录 Cookie，请先完成登录并打开 Dashboard。")
            }
            let header = matching
                .filter { !$0.name.isEmpty && !$0.value.isEmpty }
                .sorted { $0.name < $1.name }
                .map { "\($0.name)=\($0.value)" }
                .joined(separator: "; ")
            return ["session": header]
        }
    }
}

enum ProviderCookieError: LocalizedError {
    case notLoggedIn(String)

    var errorDescription: String? {
        switch self {
        case .notLoggedIn(let message): message
        }
    }
}
