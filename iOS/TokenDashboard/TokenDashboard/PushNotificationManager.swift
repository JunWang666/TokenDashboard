//
//  PushNotificationManager.swift
//  TokenDashboard
//

#if os(iOS)
import UIKit
import UserNotifications

/// iOS 推送注册与开关管理；macOS 下整个文件编译为空。
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    private enum Key {
        static let enabled = "pushNotificationsEnabled"
        static let lastToken = "lastPushToken"
    }

    // MARK: - 本地开关

    static var isEnabled: Bool {
        SharedConfiguration.defaults.bool(forKey: Key.enabled)
    }

    static func setEnabled(_ enabled: Bool) {
        SharedConfiguration.defaults.set(enabled, forKey: Key.enabled)
        if enabled {
            registerForPush()
        } else {
            UIApplication.shared.unregisterForRemoteNotifications()
            // 用上次保存的 token 退订；token 不存在说明从未注册成功，无需请求 Hub
            guard let token = SharedConfiguration.defaults.string(forKey: Key.lastToken),
                  !token.isEmpty else { return }
            Task { @MainActor in
                let client = QuotaAPIClient(configuration: AppSettings().configuration)
                do {
                    try await client.pushUnsubscribe(token: token)
                } catch {
                    print("推送退订失败：\(error.localizedDescription)")
                }
            }
        }
    }

    /// 请求通知授权，授权通过后注册 APNs。拒绝时保持开关关闭。
    static func registerForPush(completion: (@MainActor (Bool) -> Void)? = nil) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            if let error {
                print("推送授权失败：\(error.localizedDescription)")
            }
            DispatchQueue.main.async {
                SharedConfiguration.defaults.set(granted, forKey: Key.enabled)
                if granted {
                    UIApplication.shared.registerForRemoteNotifications()
                }
                if let completion {
                    MainActor.assumeIsolated {
                        completion(granted)
                    }
                }
            }
        }
    }

    // MARK: - UIApplicationDelegate

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        // 开关已开时静默重注册：token 可能轮换，重复订阅对 Hub 是幂等的
        if Self.isEnabled {
            application.registerForRemoteNotifications()
        }
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        SharedConfiguration.defaults.set(token, forKey: Key.lastToken)
        Task { @MainActor in
            let client = QuotaAPIClient(configuration: AppSettings().configuration)
            do {
                try await client.pushSubscribe(token: token)
            } catch {
                print("推送订阅失败：\(error.localizedDescription)")
            }
        }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        print("APNs 注册失败：\(error.localizedDescription)")
    }

    // MARK: - UNUserNotificationCenterDelegate

    /// 前台也展示横幅和提示音
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }
}
#endif
