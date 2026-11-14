/* OneMoments 서비스 워커 — Web Push 알림 표시와 클릭 이동만 담당한다. */
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }

  const title = typeof payload.title === "string" ? payload.title : "OneMoments";
  const options = {
    body:
      typeof payload.body === "string"
        ? payload.body
        : "새 메시지가 도착했습니다.",
    icon: "/icon.svg",
    badge: "/icon.svg",
    tag:
      typeof payload.tag === "string"
        ? payload.tag
        : "onemoments-message",
    data: {
      conversationId:
        typeof payload.conversationId === "string" ? payload.conversationId : null,
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const conversationId = event.notification.data?.conversationId;
  const target =
    typeof conversationId === "string" && conversationId.length > 0
      ? `/c/${encodeURIComponent(conversationId)}`
      : "/";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          if ("focus" in client) {
            if ("navigate" in client) void client.navigate(target);
            return client.focus();
          }
        }
        return self.clients.openWindow(target);
      }),
  );
});
