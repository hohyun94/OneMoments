/**
 * 서비스 워커 갱신 감지.
 *
 * sw.js 는 설치 시 `skipWaiting()` 을 호출하므로, 새 배포가 있으면 기존 페이지의
 * 컨트롤러가 교체된다(`controllerchange`). 그 시점에 "새 버전 있음" 배너를 띄워
 * 사용자가 원할 때 새로고침하도록 한다(입력 중 강제 리로드 방지).
 */
type Listener = (available: boolean) => void;

const listeners = new Set<Listener>();
let available = false;
let initialized = false;

function emit(): void {
  for (const listener of listeners) listener(available);
}

export function isServiceWorkerUpdateAvailable(): boolean {
  return available;
}

/** 배너 컴포넌트가 구독한다. 구독 즉시 현재 상태를 한 번 받는다. */
export function subscribeServiceWorkerUpdate(listener: Listener): () => void {
  listeners.add(listener);
  listener(available);
  return () => {
    listeners.delete(listener);
  };
}

export function initServiceWorkerUpdates(): void {
  if (initialized) return;
  initialized = true;
  // 설치형 PWA/오프라인 앱 셸: HTTPS(localhost 포함)에서만 등록된다.
  if (!("serviceWorker" in navigator) || !import.meta.env.PROD) return;

  // 첫 설치(컨트롤러 없음)는 "업데이트"가 아니다.
  const hadController = Boolean(navigator.serviceWorker.controller);

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || available) return;
    available = true;
    emit();
  });

  window.addEventListener("load", () => {
    void navigator.serviceWorker
      .register("/sw.js")
      .then((registration) => {
        // skipWaiting 이전 버전이 남아 있는 경우(waiting)도 업데이트로 본다.
        if (registration.waiting && navigator.serviceWorker.controller && !available) {
          available = true;
          emit();
        }
      })
      .catch(() => undefined);
  });
}

/** 새 버전으로 새로고침한다. */
export function applyServiceWorkerUpdate(): void {
  window.location.reload();
}
