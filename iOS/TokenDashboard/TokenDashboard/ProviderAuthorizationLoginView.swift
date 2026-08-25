//
//  ProviderAuthorizationLoginView.swift
//  TokenDashboard
//

import SwiftUI
import WebKit

struct ProviderAuthorizationLoginView: View {
    @Environment(\.dismiss) private var dismiss

    let recipe: ProviderAuthorizationRecipe
    let onUpload: @MainActor @Sendable ([String: String]) async throws -> Void

    @State private var detectedPayload: [String: String]?
    @State private var isUploading = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            ProviderAuthorizationWebView(url: recipe.loginURL, recipe: recipe) { result in
                switch result {
                case .success(let payload):
                    detectedPayload = payload
                    errorMessage = nil
                case .failure(let message):
                    errorMessage = message
                }
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
                        uploadDetectedToken()
                    } label: {
                        if isUploading {
                            ProgressView()
                                .controlSize(.small)
                        } else {
                            Label("保存到 Hub", systemImage: "icloud.and.arrow.up")
                        }
                    }
                    .disabled(detectedPayload == nil || isUploading)
                }
            }
            .safeAreaInset(edge: .bottom) {
                VStack(alignment: .leading, spacing: 5) {
                    if detectedPayload == nil {
                        Label("等待 Authorization…", systemImage: "wave.3.right")
                    } else {
                        Label("已检测到 Bearer Token", systemImage: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                    }
                    Text("登录后打开或刷新额度相关页面。只监听 \(recipe.targetDomain) 域下 \(recipe.targetPathPrefix) 请求，不记录请求内容或其他请求头。")
                }
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

    private func uploadDetectedToken() {
        guard let detectedPayload, !isUploading else { return }
        isUploading = true
        Task {
            do {
                try await onUpload(detectedPayload)
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
            }
            isUploading = false
        }
    }
}

@MainActor
private func makeProviderAuthorizationWebView(
    url: URL,
    coordinator: ProviderAuthorizationWebCoordinator
) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .default()
    configuration.userContentController.add(
        coordinator,
        name: ProviderAuthorizationWebCoordinator.messageName
    )
    configuration.userContentController.addUserScript(
        WKUserScript(
            source: ProviderAuthorizationWebCoordinator.interceptionScript,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false
        )
    )

    let webView = WKWebView(frame: .zero, configuration: configuration)
    webView.navigationDelegate = coordinator
    webView.allowsBackForwardNavigationGestures = true
    webView.load(URLRequest(url: url))
    return webView
}

@MainActor
private func dismantleProviderAuthorizationWebView(_ webView: WKWebView) {
    webView.configuration.userContentController.removeScriptMessageHandler(
        forName: ProviderAuthorizationWebCoordinator.messageName
    )
    webView.navigationDelegate = nil
}

#if os(macOS)
private struct ProviderAuthorizationWebView: NSViewRepresentable {
    let url: URL
    let recipe: ProviderAuthorizationRecipe
    let onCaptured: @MainActor @Sendable (ProviderAuthorizationCaptureResult) -> Void

    func makeCoordinator() -> ProviderAuthorizationWebCoordinator {
        ProviderAuthorizationWebCoordinator(recipe: recipe) { result in
            onCaptured(result)
        }
    }

    func makeNSView(context: Context) -> WKWebView {
        makeProviderAuthorizationWebView(url: url, coordinator: context.coordinator)
    }

    func updateNSView(_ webView: WKWebView, context: Context) {}

    static func dismantleNSView(_ webView: WKWebView, coordinator: ProviderAuthorizationWebCoordinator) {
        dismantleProviderAuthorizationWebView(webView)
    }
}
#else
private struct ProviderAuthorizationWebView: UIViewRepresentable {
    let url: URL
    let recipe: ProviderAuthorizationRecipe
    let onCaptured: @MainActor @Sendable (ProviderAuthorizationCaptureResult) -> Void

    func makeCoordinator() -> ProviderAuthorizationWebCoordinator {
        ProviderAuthorizationWebCoordinator(recipe: recipe) { result in
            onCaptured(result)
        }
    }

    func makeUIView(context: Context) -> WKWebView {
        makeProviderAuthorizationWebView(url: url, coordinator: context.coordinator)
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    static func dismantleUIView(_ webView: WKWebView, coordinator: ProviderAuthorizationWebCoordinator) {
        dismantleProviderAuthorizationWebView(webView)
    }
}
#endif

@MainActor
private final class ProviderAuthorizationWebCoordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    static let messageName = "tokenDashboardAuthorization"

    static let interceptionScript = #"""
    (() => {
      if (window.__tokenDashboardAuthorizationInstalled) return;
      window.__tokenDashboardAuthorizationInstalled = true;

      const handler = window.webkit?.messageHandlers?.tokenDashboardAuthorization;
      if (!handler) return;

      const report = (rawURL, rawHeaders) => {
        try {
          const url = new URL(String(rawURL || ''), window.location.href);
          const host = url.hostname.toLowerCase();
          const allowed = (
            (host === 'kimi.com' || host.endsWith('.kimi.com')) && url.pathname.startsWith('/apiv2/')
          ) || (
            (host === 'chatgpt.com' || host.endsWith('.chatgpt.com')) && url.pathname.startsWith('/backend-api/')
          );
          if (!allowed) return;

          const headers = new Headers(rawHeaders || {});
          const authorization = headers.get('Authorization');
          if (!authorization || !/^Bearer\s+\S+/i.test(authorization)) return;
          handler.postMessage({ url: url.href, authorization });
        } catch (_) {}
      };

      const originalFetch = window.fetch;
      if (typeof originalFetch === 'function') {
        window.fetch = function(input, init) {
          const requestURL = typeof input === 'string' || input instanceof URL
            ? String(input)
            : input?.url;
          const headers = init?.headers || input?.headers;
          report(requestURL, headers);
          return originalFetch.apply(this, arguments);
        };
      }

      const originalOpen = XMLHttpRequest.prototype.open;
      const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
      const originalSend = XMLHttpRequest.prototype.send;

      XMLHttpRequest.prototype.open = function(method, url) {
        this.__tokenDashboardURL = String(url || '');
        this.__tokenDashboardHeaders = {};
        return originalOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
        if (String(name).toLowerCase() === 'authorization') {
          this.__tokenDashboardHeaders.Authorization = String(value);
        }
        return originalSetRequestHeader.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function() {
        report(this.__tokenDashboardURL, this.__tokenDashboardHeaders);
        return originalSend.apply(this, arguments);
      };
    })();
    """#

    private let recipe: ProviderAuthorizationRecipe
    private let onCaptured: @MainActor @Sendable (ProviderAuthorizationCaptureResult) -> Void

    init(
        recipe: ProviderAuthorizationRecipe,
        onCaptured: @escaping @MainActor @Sendable (ProviderAuthorizationCaptureResult) -> Void
    ) {
        self.recipe = recipe
        self.onCaptured = onCaptured
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == Self.messageName,
              let body = message.body as? [String: Any],
              let requestURL = body["url"] as? String,
              let authorization = body["authorization"] as? String else {
            return
        }

        let documentHost = message.frameInfo.request.url?.host?.lowercased()
        guard let documentHost,
              documentHost == recipe.targetDomain || documentHost.hasSuffix(".\(recipe.targetDomain)") else {
            return
        }

        do {
            onCaptured(.success(try recipe.payload(
                requestURL: requestURL,
                authorization: authorization
            )))
        } catch {
            onCaptured(.failure(error.localizedDescription))
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

private enum ProviderAuthorizationCaptureResult: Sendable {
    case success([String: String])
    case failure(String)
}
