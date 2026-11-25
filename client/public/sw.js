/* OneMoments 서비스 워커 — 정적 앱 셸 캐시와 Web Push 알림을 담당한다. */
const CACHE_NAME = "onemoments-static-v3";
const PRECACHE = [
  "/",
  "/manifest.webmanifest",
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
];

async function precache() {
  const cache = await caches.open(CACHE_NAME);
  await cache.addAll(PRECACHE);
  // 첫 방문에서도 오프라인 앱 셸이 동작하도록 index.html의 해시 자산을 함께 캐시한다.
  try {
    const response = await fetch("/");
    if (!response.ok) return;
    await cache.put("/", response.clone());
    const html = await response.text();
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(
      (match) => match[1],
    );
    await Promise.all(
      assets.map(async (asset) => {
        try {
          const assetResponse = await fetch(asset);
          if (assetResponse.ok) await cache.put(asset, assetResponse);
        } catch {
          // 한 자산 실패가 전체 설치를 막지 않게 한다.
        }
      }),
    );
  } catch {
    // 오프라인 설치 시도는 다음 방문에서 보완된다.
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("onemoments-static-") && key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

async function networkFirstNavigation(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put("/", response.clone());
    return response;
  } catch {
    const cached = await cache.match("/");
    if (cached) return cached;
    return new Response("오프라인 상태입니다. 네트워크에 연결한 뒤 다시 시도해 주세요.", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // API·첨부(암호문)는 캐시하지 않는다.
  if (url.pathname.startsWith("/api/") || url.pathname === "/ws") return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  if (
    url.pathname.startsWith("/assets/") ||
    url.pathname.startsWith("/icon") ||
    url.pathname === "/manifest.webmanifest" ||
    url.pathname === "/apple-touch-icon.png"
  ) {
    event.respondWith(cacheFirst(request));
  }
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }

  const title = typeof payload.title === "string" ? payload.title : "OneMoments";
  const isCall = payload.type === "call";
  const options = {
    body:
      typeof payload.body === "string"
        ? payload.body
        : isCall
          ? "부재중 전화가 있습니다."
          : "새 메시지가 도착했습니다.",
    icon: "/icon.svg",
    badge: "/icon.svg",
    tag:
      typeof payload.tag === "string"
        ? payload.tag
        : isCall
          ? "onemoments-call"
          : "onemoments-message",
    data: {
      conversationId:
        typeof payload.conversationId === "string" ? payload.conversationId : null,
      // 보안 알림처럼 앱 내 특정 화면으로 보내고 싶을 때 사용한다(예: /devices).
      url: typeof payload.url === "string" ? payload.url : null,
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data ?? {};
  const conversationId = data.conversationId;
  const explicitUrl =
    typeof data.url === "string" && data.url.startsWith("/") ? data.url : null;
  const target =
    explicitUrl ??
    (typeof conversationId === "string" && conversationId.length > 0
      ? `/c/${encodeURIComponent(conversationId)}`
      : "/");

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
