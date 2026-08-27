// Service Worker：接收 hub 的 Web Push 推送并展示系统通知

self.addEventListener("push", (event) => {
  let title = "TokenDashboard";
  let body = "收到新的额度告警";
  try {
    if (event.data) {
      const data = event.data.json();
      if (data && typeof data.title === "string") title = data.title;
      if (data && typeof data.body === "string") body = data.body;
    }
  } catch {
    // payload 解析失败时使用兜底文案
  }
  event.waitUntil(self.registration.showNotification(title, { body }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((wins) => {
        for (const win of wins) {
          if ("focus" in win) return win.focus();
        }
        return clients.openWindow("/");
      }),
  );
});
