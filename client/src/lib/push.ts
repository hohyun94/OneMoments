import { ApiError, api } from "./api.ts";

export type PushState = "unsupported" | "subscribed" | "unsubscribed";

export function pushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

function base64UrlToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function pushRegistration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  return navigator.serviceWorker.ready;
}

export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return null;
  return registration.pushManager.getSubscription();
}

export async function enablePush(): Promise<void> {
  if (!pushSupported()) {
    throw new Error("이 브라우저는 푸시 알림을 지원하지 않습니다.");
  }
  if (Notification.permission === "denied") {
    throw new Error("브라우저 설정에서 알림이 차단되어 있습니다. 사이트 권한을 변경해 주세요.");
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("알림 권한이 필요합니다.");
  }

  const registration = await pushRegistration();
  let publicKey: string;
  try {
    ({ publicKey } = await api<{ publicKey: string }>("/api/push/public-key"));
  } catch (error) {
    if (error instanceof ApiError && error.status === 503) {
      throw new Error("서버에서 푸시 알림이 설정되지 않았습니다.");
    }
    throw error;
  }

  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToUint8Array(publicKey),
    });
  }

  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
    throw new Error("푸시 구독 정보를 만들 수 없습니다.");
  }
  await api("/api/push/subscriptions", {
    method: "POST",
    body: {
      endpoint: json.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    },
  }).catch((error: unknown) => {
    if (error instanceof ApiError && error.status === 503) {
      throw new Error("서버에서 푸시 알림이 설정되지 않았습니다.");
    }
    throw error;
  });
}

export async function disablePush(): Promise<void> {
  if (!pushSupported()) return;
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  try {
    await api("/api/push/subscriptions", {
      method: "DELETE",
      body: { endpoint: subscription.endpoint },
    });
  } finally {
    await subscription.unsubscribe();
  }
}
