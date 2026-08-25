//
//  ProviderCookieLoginView.swift
//  TokenDashboard
//

import SwiftUI
import WebKit

struct ProviderCookieLoginView: View {
    @Environment(\.dismiss) private var dismiss

    let recipe: ProviderCookieRecipe
    let onUpload: @MainActor @Sendable ([String: String]) async throws -> Void

    @State private var captureRequest = 0
    @State private var isUploading = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            ProviderCookieWebView(
                url: recipe.loginURL,
                recipe: recipe,
                captureRequest: captureRequest
            ) { result in
                handle(result)
            }
            .navigationTitle(recipe.title)
#if !os(macOS)
            .navigationBarTitleDisplayMode(.inline)
#endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                        .disabled(isUploading)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        captureRequest += 1
                    } label: {
                        if isUploading {
                            ProgressView()
                                .controlSize(.small)
                        } else {
                            Label("读取并保存到 Hub", systemImage: "icloud.and.arrow.up")
                        }
                    }
                    .disabled(isUploading)
                }
            }
            .safeAreaInset(edge: .bottom) {
                Text("登录完成后点“读取并保存到 Hub”。只读取 \(recipe.targetDomain) 域的登录 Cookie。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal)
                    .padding(.vertical, 10)
                    .background(.bar)
            }
            .alert("无法保存凭证", isPresented: Binding(
                get: { errorMessage != nil },
                set: { if !$0 { errorMessage = nil } }
            )) {
                Button("好", role: .cancel) {}
            } message: {
                Text(errorMessage ?? "未知错误")
            }
        }
    }

    private func handle(_ result: ProviderCookieCaptureResult) {
        switch result {
        case .failure(let message):
            errorMessage = message
        case .success(let payload):
            isUploading = true
            Task {
                do {
                    try await onUpload(payload)
                    dismiss()
                } catch {
                    errorMessage = error.localizedDescription
                }
                isUploading = false
            }
        }
    }
}

@MainActor
private func makeProviderCookieWebView(
    url: URL,
    coordinator: ProviderCookieWebCoordinator
) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .default()

    let webView = WKWebView(frame: .zero, configuration: configuration)
    webView.navigationDelegate = coordinator
    webView.allowsBackForwardNavigationGestures = true
    webView.load(URLRequest(url: url))
    return webView
}

#if os(macOS)
private struct ProviderCookieWebView: NSViewRepresentable {
    let url: URL
    let recipe: ProviderCookieRecipe
    let captureRequest: Int
    let onCaptured: @MainActor @Sendable (ProviderCookieCaptureResult) -> Void

    func makeCoordinator() -> ProviderCookieWebCoordinator {
        ProviderCookieWebCoordinator(recipe: recipe) { result in
            onCaptured(result)
        }
    }

    func makeNSView(context: Context) -> WKWebView {
        makeProviderCookieWebView(url: url, coordinator: context.coordinator)
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        context.coordinator.captureIfRequested(captureRequest, from: webView)
    }

    static func dismantleNSView(_ webView: WKWebView, coordinator: ProviderCookieWebCoordinator) {
        webView.navigationDelegate = nil
    }
}
#else
private struct ProviderCookieWebView: UIViewRepresentable {
    let url: URL
    let recipe: ProviderCookieRecipe
    let captureRequest: Int
    let onCaptured: @MainActor @Sendable (ProviderCookieCaptureResult) -> Void

    func makeCoordinator() -> ProviderCookieWebCoordinator {
        ProviderCookieWebCoordinator(recipe: recipe) { result in
            onCaptured(result)
        }
    }

    func makeUIView(context: Context) -> WKWebView {
        makeProviderCookieWebView(url: url, coordinator: context.coordinator)
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.captureIfRequested(captureRequest, from: webView)
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: ProviderCookieWebCoordinator) {
        webView.navigationDelegate = nil
    }
}
#endif

@MainActor
private final class ProviderCookieWebCoordinator: NSObject, WKNavigationDelegate {
    private let recipe: ProviderCookieRecipe
    private let onCaptured: @MainActor @Sendable (ProviderCookieCaptureResult) -> Void
    private var lastCaptureRequest = 0

    init(
        recipe: ProviderCookieRecipe,
        onCaptured: @escaping @MainActor @Sendable (ProviderCookieCaptureResult) -> Void
    ) {
        self.recipe = recipe
        self.onCaptured = onCaptured
    }

    func captureIfRequested(_ request: Int, from webView: WKWebView) {
        guard request != lastCaptureRequest else { return }
        lastCaptureRequest = request

        webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { [weak self] cookies in
            guard let self else { return }
            do {
                self.onCaptured(.success(try self.recipe.payload(from: cookies)))
            } catch {
                self.onCaptured(.failure(error.localizedDescription))
            }
        }
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation?,
        withError error: Error
    ) {
        onCaptured(.failure(error.localizedDescription))
    }
}

private enum ProviderCookieCaptureResult: Sendable {
    case success([String: String])
    case failure(String)
}
