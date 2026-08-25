//
//  AccessLoginView.swift
//  TokenDashboard
//

import SwiftUI
import WebKit

struct AccessLoginView: View {
    @Environment(\.dismiss) private var dismiss

    let hubURL: String
    let onAuthenticated: @MainActor @Sendable (String) -> Void

    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Group {
                if let loginURL {
                    AccessWebView(url: loginURL) { cookieHeader in
                        onAuthenticated(cookieHeader)
                        dismiss()
                    } onError: { message in
                        errorMessage = message
                    }
                } else {
                    ContentUnavailableView(
                        "Hub 地址无效",
                        systemImage: "link.badge.plus",
                        description: Text("请返回连接设置，填写完整的 Hub 地址。")
                    )
                }
            }
            .navigationTitle("Cloudflare Access")
#if !os(macOS)
            .navigationBarTitleDisplayMode(.inline)
#endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
            }
            .alert("登录页加载失败", isPresented: Binding(
                get: { errorMessage != nil },
                set: { if !$0 { errorMessage = nil } }
            )) {
                Button("好", role: .cancel) {}
            } message: {
                Text(errorMessage ?? "未知错误")
            }
        }
    }

    private var loginURL: URL? {
        guard let baseURL = URL(string: hubURL.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            return nil
        }
        return baseURL
            .appendingPathComponent("api")
            .appendingPathComponent("v1")
            .appendingPathComponent("quota")
            .appendingPathComponent("current")
    }
}

@MainActor
private func makeAccessWebView(url: URL, coordinator: AccessWebCoordinator) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .default()

    let webView = WKWebView(frame: .zero, configuration: configuration)
    webView.navigationDelegate = coordinator
    webView.allowsBackForwardNavigationGestures = true
    configuration.websiteDataStore.httpCookieStore.add(coordinator)
    webView.load(URLRequest(url: url))
    return webView
}

@MainActor
private func dismantleAccessWebView(_ webView: WKWebView, coordinator: AccessWebCoordinator) {
    webView.configuration.websiteDataStore.httpCookieStore.remove(coordinator)
    webView.navigationDelegate = nil
}

#if os(macOS)
private struct AccessWebView: NSViewRepresentable {
    let url: URL
    let onCookieCaptured: @MainActor @Sendable (String) -> Void
    let onError: @MainActor @Sendable (String) -> Void

    func makeCoordinator() -> AccessWebCoordinator {
        AccessWebCoordinator(
            host: url.host ?? "",
            onCookieCaptured: { value in onCookieCaptured(value) },
            onError: { value in onError(value) }
        )
    }

    func makeNSView(context: Context) -> WKWebView {
        makeAccessWebView(url: url, coordinator: context.coordinator)
    }

    func updateNSView(_ webView: WKWebView, context: Context) {}

    static func dismantleNSView(_ webView: WKWebView, coordinator: AccessWebCoordinator) {
        dismantleAccessWebView(webView, coordinator: coordinator)
    }
}
#else
private struct AccessWebView: UIViewRepresentable {
    let url: URL
    let onCookieCaptured: @MainActor @Sendable (String) -> Void
    let onError: @MainActor @Sendable (String) -> Void

    func makeCoordinator() -> AccessWebCoordinator {
        AccessWebCoordinator(
            host: url.host ?? "",
            onCookieCaptured: { value in onCookieCaptured(value) },
            onError: { value in onError(value) }
        )
    }

    func makeUIView(context: Context) -> WKWebView {
        makeAccessWebView(url: url, coordinator: context.coordinator)
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    static func dismantleUIView(_ webView: WKWebView, coordinator: AccessWebCoordinator) {
        dismantleAccessWebView(webView, coordinator: coordinator)
    }
}
#endif

@MainActor
private final class AccessWebCoordinator: NSObject, WKNavigationDelegate, WKHTTPCookieStoreObserver {
    private let host: String
    private let onCookieCaptured: @MainActor @Sendable (String) -> Void
    private let onError: @MainActor @Sendable (String) -> Void
    private var didComplete = false

    init(
        host: String,
        onCookieCaptured: @escaping @MainActor @Sendable (String) -> Void,
        onError: @escaping @MainActor @Sendable (String) -> Void
    ) {
        self.host = host.lowercased()
        self.onCookieCaptured = onCookieCaptured
        self.onError = onError
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation?) {
        captureCookies(from: webView.configuration.websiteDataStore.httpCookieStore)
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation?,
        withError error: Error
    ) {
        onError(error.localizedDescription)
    }

    func cookiesDidChange(in cookieStore: WKHTTPCookieStore) {
        captureCookies(from: cookieStore)
    }

    private func captureCookies(from store: WKHTTPCookieStore) {
        guard !didComplete else { return }
        store.getAllCookies { [weak self] cookies in
            guard let self, !self.didComplete else { return }
            let matching = cookies.filter {
                ["CF_Authorization", "CF_Binding"].contains($0.name)
                    && self.matchesHubDomain($0.domain)
            }
            guard matching.contains(where: { $0.name == "CF_Authorization" }) else { return }

            self.didComplete = true
            let header = matching
                .sorted { $0.name < $1.name }
                .map { "\($0.name)=\($0.value)" }
                .joined(separator: "; ")
            self.onCookieCaptured(header)
        }
    }

    private func matchesHubDomain(_ cookieDomain: String) -> Bool {
        let domain = cookieDomain
            .trimmingCharacters(in: CharacterSet(charactersIn: "."))
            .lowercased()
        return host == domain || host.hasSuffix(".\(domain)")
    }
}

@MainActor
enum WebAccessCookieStore {
    static func clear() async {
        let store = WKWebsiteDataStore.default().httpCookieStore
        let cookies = await store.allCookies()
        for cookie in cookies where ["CF_Authorization", "CF_Binding"].contains(cookie.name) {
            await store.deleteCookie(cookie)
        }
    }
}
