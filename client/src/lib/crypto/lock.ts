/**
 * 암호 상태(ratchet/sender key)에 대한 동시 접근 직렬화.
 *
 * - 같은 탭의 동시 호출: 메모리 큐로 순서를 지킨다.
 * - 탭 사이: **Web Locks API** 로 같은 이름의 작업을 직렬화한다.
 *   Web Locks 는 보안 컨텍스트(https/localhost)에서만 제공되므로, 없으면 메모리 큐만 쓴다.
 *
 * 락 이름은 세션 저장 키와 같은 스코프(내 기기·대화·상대 기기)를 쓴다.
 * 두 탭이 같은 세션의 체인 카운터를 동시에 소모하면 상대가 복호화할 수 없기 때문이다.
 */
const LOCK_PREFIX = "onemoments:crypto:";

const memoryLocks = new Map<string, Promise<unknown>>();

function withMemoryLock<T>(name: string, task: () => Promise<T>): Promise<T> {
  const previous = memoryLocks.get(name) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  memoryLocks.set(name, next);
  return next.finally(() => {
    if (memoryLocks.get(name) === next) memoryLocks.delete(name);
  });
}

function webLocks(): LockManager | null {
  if (typeof navigator === "undefined") return null;
  const locks = navigator.locks;
  return locks && typeof locks.request === "function" ? locks : null;
}

function runWithWebLock<T>(
  locks: LockManager,
  name: string,
  task: () => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // 락은 콜백이 끝날 때까지 유지되므로 작업 전체가 직렬화된다.
    void locks
      .request(`${LOCK_PREFIX}${name}`, async () => {
        try {
          resolve(await task());
        } catch (error) {
          reject(error);
        }
      })
      .catch(reject);
  });
}

export function withCryptoLock<T>(name: string, task: () => Promise<T>): Promise<T> {
  const locks = webLocks();
  // Web Locks 는 같은 탭·다른 탭 모두를 이름 단위로 직렬화한다.
  if (locks) return runWithWebLock(locks, name, task);
  return withMemoryLock(name, task);
}
