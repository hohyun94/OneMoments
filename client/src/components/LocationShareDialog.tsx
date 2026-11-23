import { MapPin, RotateCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  LocationRequestError,
  locationFailureMessage,
  requestCurrentLocation,
} from "../lib/geolocation.ts";
import {
  formatAccuracy,
  formatCoordinates,
  LOCATION_LABEL_MAX,
  type SharedLocation,
} from "../lib/location.ts";
import { Button, Dialog, Input, Label, Spinner } from "./ui.tsx";

export interface LocationShareRequest extends SharedLocation {
  at: string;
  label?: string;
}

/**
 * 현재 위치를 읽어 미리보기 후 전송한다.
 * 위치는 브라우저 권한을 허용한 경우에만 읽고, 전송 시 메시지 암호문 안에만 담긴다.
 */
export function LocationShareDialog({
  open,
  onClose,
  onSend,
  sending,
}: {
  open: boolean;
  onClose: () => void;
  onSend: (location: LocationShareRequest) => void;
  sending: boolean;
}) {
  const [status, setStatus] = useState<"locating" | "ready" | "error">("locating");
  const [location, setLocation] = useState<SharedLocation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("");

  const locate = useCallback(async () => {
    setStatus("locating");
    setError(null);
    try {
      setLocation(await requestCurrentLocation());
      setStatus("ready");
    } catch (caught) {
      setStatus("error");
      setError(
        caught instanceof LocationRequestError
          ? locationFailureMessage(caught.code)
          : "현재 위치를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.",
      );
    }
  }, []);

  useEffect(() => {
    if (!open) {
      setStatus("locating");
      setLocation(null);
      setError(null);
      setLabel("");
      return;
    }
    // 열리는 순간(사용자 클릭)에 권한 프롬프트를 띄운다.
    void locate();
  }, [open, locate]);

  function send(): void {
    if (!location || sending) return;
    const trimmed = label.trim();
    onSend({
      ...location,
      at: new Date().toISOString(),
      ...(trimmed ? { label: trimmed.slice(0, LOCATION_LABEL_MAX) } : {}),
    });
  }

  return (
    <Dialog open={open} onClose={onClose} title="현재 위치 보내기">
      <div data-testid="location-share-dialog" className="space-y-3">
        {status === "locating" ? (
          <p className="flex items-center gap-2 text-sm text-zinc-600">
            <Spinner /> 위치 확인 중…
          </p>
        ) : null}

        {status === "error" ? (
          <div className="space-y-2">
            <p className="text-sm text-red-600">{error}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => void locate()}>
              <RotateCw className="h-4 w-4" aria-hidden /> 다시 시도
            </Button>
          </div>
        ) : null}

        {status === "ready" && location ? (
          <>
            <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3">
              <div className="flex items-start gap-2">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-100 text-accent-700">
                  <MapPin className="h-4 w-4" aria-hidden />
                </span>
                <div className="min-w-0">
                  <p
                    data-testid="location-preview"
                    className="font-mono text-sm text-zinc-800"
                  >
                    {formatCoordinates(location)}
                  </p>
                  <p className="text-xs text-zinc-500">{formatAccuracy(location.accuracy)}</p>
                </div>
              </div>
            </div>
            <div>
              <Label htmlFor="location-label">장소 이름 (선택)</Label>
              <Input
                id="location-label"
                value={label}
                maxLength={LOCATION_LABEL_MAX}
                placeholder="예: 집, 회사"
                onChange={(event) => setLabel(event.target.value)}
              />
            </div>
            <p className="text-xs leading-relaxed text-zinc-500">
              이 좌표는 대화 상대에게만 보이며, 메시지와 함께 종단간 암호화되어 저장됩니다.
              서버는 위치를 해독할 수 없습니다.
            </p>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={onClose}>
                취소
              </Button>
              <Button
                type="button"
                data-testid="location-send"
                disabled={sending}
                onClick={send}
              >
                {sending ? <Spinner /> : <MapPin className="h-4 w-4" aria-hidden />}
                보내기
              </Button>
            </div>
          </>
        ) : null}
      </div>
    </Dialog>
  );
}
