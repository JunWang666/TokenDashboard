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
    static func cookieHeader(for url: URL) async -> String? {
        let cookies = await WKWebsiteDataStore.default().httpCookieStore.allCookies()
        return cookieHeader(from: cookies, for: url)
    }

    static func refreshCookieHeader(
        for url: URL,
        replacing currentHeader: String?
    ) async -> String? {
        await WebAccessCookieRefresher.shared.refreshCookieHeader(
            for: url,
            replacing: currentHeader
        )
    }

    static func cookieHeader(
        from cookies: [HTTPCookie],
        for url: URL,
        now: Date = Date()
    ) -> String? {
        guard let host = url.host?.lowercased() else { return nil }
        let requestPath = url.path.isEmpty ? "/" : url.path
        let matching = cookies.filter { cookie in
            ["CF_Authorization", "CF_Binding"].contains(cookie.name)
                && matches(host: host, cookieDomain: cookie.domain)
                && matches(requestPath: requestPath, cookiePath: cookie.path)
                && (cookie.expiresDate == nil || cookie.expiresDate! > now)
        }

        let selected = Dictionary(grouping: matching, by: \.name)
            .compactMap { _, candidates in
                candidates.max { lhs, rhs in
                    let left = (normalizedDomain(lhs.domain).count, lhs.path.count)
                    let right = (normalizedDomain(rhs.domain).count, rhs.path.count)
                    return left < right
                }
            }
        guard selected.contains(where: { $0.name == "CF_Authorization" }) else { return nil }

        return selected
            .sorted { $0.name < $1.name }
            .map { "\($0.name)=\($0.value)" }
            .joined(separator: "; ")
    }

    static func clear() async {
        let store = WKWebsiteDataStore.default().httpCookieStore
        let cookies = await store.allCookies()
        for cookie in cookies where ["CF_Authorization", "CF_Binding"].contains(cookie.name) {
            await store.deleteCookie(cookie)
        }
    }

    private static func matches(host: String, cookieDomain: String) -> Bool {
        let domain = normalizedDomain(cookieDomain)
        return host == domain || host.hasSuffix(".\(domain)")
    }

    private static func matches(requestPath: String, cookiePath: String) -> Bool {
        guard cookiePath != "/" else { return true }
        let normalizedPath = cookiePath.hasSuffix("/") ? cookiePath : "\(cookiePath)/"
        return requestPath == cookiePath || requestPath.hasPrefix(normalizedPath)
    }

    private static func normalizedDomain(_ domain: String) -> String {
        domain
            .trimmingCharacters(in: CharacterSet(charactersIn: "."))
            .lowercased()
    }
}

@MainActor
private final class WebAccessCookieRefresher {
    static let shared = WebAccessCookieRefresher()

    private var inFlight: [String: Task<String?, Never>] = [:]

    func refreshCookieHeader(
        for url: URL,
        replacing currentHeader: String?
    ) async -> String? {
        let key = "\(url.scheme ?? "")://\(url.host ?? ""):\(url.port ?? 0)"
        if let task = inFlight[key] {
            return await task.value
        }

        let operation = WebAccessCookieRefreshOperation(
            url: url,
            currentHeader: currentHeader
        )
        let task = Task { @MainActor in
            await operation.run()
        }
        inFlight[key] = task
        let result = await task.value
        inFlight[key] = nil
        return result
    }
}

@MainActor
private final class WebAccessCookieRefreshOperation: NSObject, WKNavigationDelegate, WKHTTPCookieStoreObserver {
    private let url: URL
    private let currentHeader: String?
    private var continuation: CheckedContinuation<String?, Never>?
    private var timeoutTask: Task<Void, Never>?
    private var webView: WKWebView?

    init(url: URL, currentHeader: String?) {
        self.url = url
        self.currentHeader = currentHeader
    }

    func run() async -> String? {
        await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                self.continuation = continuation
                start()
            }
        } onCancel: {
            Task { @MainActor [weak self] in
                self?.finish(with: nil)
            }
        }
    }

    private func start() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        let webView = WKWebView(frame: .zero, configuration: configuration)
        self.webView = webView
        webView.navigationDelegate = self
        configuration.websiteDataStore.httpCookieStore.add(self)
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))

        timeoutTask = Task { @MainActor [weak self] in
            do {
                try await Task.sleep(for: .seconds(15))
            } catch {
                return
            }
            self?.finish(with: nil)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation?) {
        inspectCookies(finishIfUnchanged: webView.url?.host == url.host)
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation?,
        withError error: Error
    ) {
        finish(with: nil)
    }

    func webView(
        _ webView: WKWebView,
        didFail navigation: WKNavigation?,
        withError error: Error
    ) {
        finish(with: nil)
    }

    func cookiesDidChange(in cookieStore: WKHTTPCookieStore) {
        inspectCookies(finishIfUnchanged: false)
    }

    private func inspectCookies(finishIfUnchanged: Bool) {
        guard let webView else { return }
        webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { [weak self] cookies in
            Task { @MainActor in
                guard let self, self.continuation != nil else { return }
                let header = WebAccessCookieStore.cookieHeader(from: cookies, for: self.url)
                if let header, header != self.currentHeader {
                    self.finish(with: header)
                } else if finishIfUnchanged {
                    self.finish(with: nil)
                }
            }
        }
    }

    private func finish(with cookieHeader: String?) {
        guard let continuation else { return }
        self.continuation = nil
        timeoutTask?.cancel()
        timeoutTask = nil
        if let webView {
            webView.configuration.websiteDataStore.httpCookieStore.remove(self)
            webView.stopLoading()
            webView.navigationDelegate = nil
        }
        webView = nil
        continuation.resume(returning: cookieHeader)
    }
}
