/**
 * 키 백업으로 복구한 기기를 표시한다.
 *
 * 복구는 백업 시점의 스냅샷만 담으므로, 그 이후 도착한 메시지는 이 기기에서
 * 복호화할 수 없다. 사용자가 "왜 안 읽히는지" 알 수 있게 기기별로 기록한다.
 * 새 백업을 만들면 현재 상태가 스냅샷에 포함되므로 표시를 지운다.
 */
const KEY_PREFIX = "onemoments:recoveredAt:";

function storage(): Storage | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage;
}

export function markDeviceRecovered(deviceId: string, at: Date = new Date()): string {
  const iso = at.toISOString();
  storage()?.setItem(`${KEY_PREFIX}${deviceId}`, iso);
  return iso;
}

export function recoveredAtFor(deviceId: string | undefined): string | null {
  if (!deviceId) return null;
  return storage()?.getItem(`${KEY_PREFIX}${deviceId}`) ?? null;
}

export function clearDeviceRecovered(deviceId: string): void {
  storage()?.removeItem(`${KEY_PREFIX}${deviceId}`);
}
