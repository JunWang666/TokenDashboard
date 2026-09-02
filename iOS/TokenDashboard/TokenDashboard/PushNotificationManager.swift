//
//  PushNotificationManager.swift
//  TokenDashboard
//

#if os(iOS)
import UIKit
import UserNotifications

extension Notification.Name {
    static let pushRegistrationStatusDidChange = Notification.Name("PushRegistrationStatusDidChange")
}

enum PushNotificationError: LocalizedError {
    case missingToken
    case delivery(String)

    var errorDescription: String? {
        switch self {
        case .missingToken:
            "尚未取得 APNs device token，请确认通知权限后重试。"
        case .delivery(let reason):
            "测试推送失败：\(reason)"
        }
    }
}

/// iOS 推送注册、Hub 同步、环境选择与可见状态；macOS 下整个文件编译为空。
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    private enum Key {
        static let enabled = "pushNotificationsEnabled"
        static let lastToken = "lastPushToken"
        static let lastEnvironment = "lastPushEnvironment"
        static let statusMessage = "pushRegistrationStatusMessage"
        static let statusIsError = "pushRegistrationStatusIsError"
    }

    static var isEnabled: Bool {
        SharedConfiguration.defaults.bool(forKey: Key.enabled)
    }

    static var statusMessage: String {
        SharedConfiguration.defaults.string(forKey: Key.statusMessage)
            ?? (isEnabled ? "等待 APNs 注册" : "未启用")
    }

    static var statusIsError: Bool {
        SharedConfiguration.defaults.bool(forKey: Key.statusIsError)
    }

    /// Debug 签名拿到 sandbox token；Archive/Release 签名拿到 production token。
    static var buildEnvironment: String {
#if DEBUG
        "sandbox"
#else
        "production"
#endif
    }

    private static func updateStatus(_ message: String, isError: Bool = false) {
        SharedConfiguration.defaults.set(message, forKey: Key.statusMessage)
        SharedConfiguration.defaults.set(isError, forKey: Key.statusIsError)
        NotificationCenter.default.post(name: .pushRegistrationStatusDidChange, object: nil)
    }

    // MARK: - 本地开关

    static func setEnabled(_ enabled: Bool) {
        if enabled {
            registerForPush()
            return
        }

        // 授权回调已经把值设为 false 时，不要覆盖“权限被拒绝”的诊断。
        guard isEnabled else { return }
        SharedConfiguration.defaults.set(false, forKey: Key.enabled)
        UIApplication.shared.unregisterForRemoteNotifications()
        guard let token = SharedConfiguration.defaults.string(forKey: Key.lastToken),
              !token.isEmpty else {
            updateStatus("未启用")
            return
        }

        updateStatus("正在从 Hub 退订…")
        Task { @MainActor in
            let client = QuotaAPIClient(configuration: AppSettings().configuration)
            do {
                try await client.pushUnsubscribe(token: token)
                SharedConfiguration.defaults.removeObject(forKey: Key.lastToken)
                SharedConfiguration.defaults.removeObject(forKey: Key.lastEnvironment)
                updateStatus("未启用")
            } catch {
                updateStatus("Hub 退订失败：\(error.localizedDescription)", isError: true)
            }
        }
    }

    /// 请求通知授权，授权通过后注册 APNs。拒绝时保持开关关闭。
    static func registerForPush(completion: (@MainActor (Bool) -> Void)? = nil) {
        updateStatus("正在请求系统通知权限…")
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            DispatchQueue.main.async {
                if let error {
                    SharedConfiguration.defaults.set(false, forKey: Key.enabled)
                    updateStatus("通知授权失败：\(error.localizedDescription)", isError: true)
                } else if granted {
                    SharedConfiguration.defaults.set(true, forKey: Key.enabled)
                    updateStatus("已授权，正在向 APNs 注册…")
                    UIApplication.shared.registerForRemoteNotifications()
                } else {
                    SharedConfiguration.defaults.set(false, forKey: Key.enabled)
                    updateStatus("通知权限未授予，请到系统设置中允许通知", isError: true)
                }
                if let completion {
                    MainActor.assumeIsolated {
                        completion(granted && error == nil)
                    }
                }
            }
        }
    }

    /// 使用上次 token 重试同步，同时让系统刷新 token；用于启动和连接设置变更后。
    static func retrySubscription() {
        guard isEnabled else { return }
        UIApplication.shared.registerForRemoteNotifications()
        guard let token = SharedConfiguration.defaults.string(forKey: Key.lastToken),
              !token.isEmpty else {
            updateStatus("等待 APNs 返回 device token…")
            return
        }
        let environment = SharedConfiguration.defaults.string(forKey: Key.lastEnvironment) ?? buildEnvironment
        upload(token: token, environment: environment)
    }

    private static func upload(token: String, environment: String) {
        updateStatus("正在同步 APNs token 到 Hub（\(environment)）…")
        Task { @MainActor in
            let client = QuotaAPIClient(configuration: AppSettings().configuration)
            do {
                try await client.pushSubscribe(token: token, environment: environment)
                updateStatus("已连接 Hub（\(environment)）")
            } catch {
                updateStatus("Hub 订阅失败：\(error.localizedDescription)", isError: true)
            }
        }
    }

    static func sendTestPush() async throws {
        guard let token = SharedConfiguration.defaults.string(forKey: Key.lastToken),
              !token.isEmpty else {
            updateStatus("尚未取得 APNs device token，请确认通知权限后重试", isError: true)
            throw PushNotificationError.missingToken
        }
        updateStatus("正在发送测试通知…")
        do {
            let response = try await QuotaAPIClient(configuration: AppSettings().configuration)
                .pushTest(token: token)
            guard response.ok else {
                updateStatus("测试推送失败：\(response.reason)", isError: true)
                throw PushNotificationError.delivery(response.reason)
            }
            updateStatus("测试通知已交给 APNs")
        } catch {
            if !(error is PushNotificationError) {
                updateStatus("测试推送失败：\(error.localizedDescription)", isError: true)
            }
            throw error
        }
    }

    // MARK: - UIApplicationDelegate

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        if Self.isEnabled {
            Self.retrySubscription()
        }
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        let environment = Self.buildEnvironment
        SharedConfiguration.defaults.set(token, forKey: Key.lastToken)
        SharedConfiguration.defaults.set(environment, forKey: Key.lastEnvironment)
        Self.upload(token: token, environment: environment)
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        Self.updateStatus("APNs 注册失败：\(error.localizedDescription)", isError: true)
    }

    // MARK: - UNUserNotificationCenterDelegate

    /// 前台也展示横幅和提示音。
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }
}
#endif
