import { MapPin, RotateCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

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
import { renderStaticMap } from "../lib/staticMap.ts";
import { Button, Dialog, Input, Label, Spinner } from "./ui.tsx";

export interface LocationShareRequest extends SharedLocation {
  at: string;
  label?: string;
}

/**
 * 현재 위치를 읽어 미리보기 후 전송한다.
 * 위치는 브라우저 권한을 허용한 경우에만 읽고, 전송 시 메시지 암호문 안에만 담긴다.
 *
 * `mapTileUrl` 이 설정돼 있으면 **발신자 브라우저에서** 지도를 합성해 미리보기로 보여주고,
 * 전송 시 그 이미지를 암호화 첨부로 함께 보낸다(수신자는 타일 서버에 접속하지 않는다).
 */
export function LocationShareDialog({
  open,
  onClose,
  onSend,
  sending,
  mapTileUrl,
}: {
  open: boolean;
  onClose: () => void;
  onSend: (location: LocationShareRequest, map: Blob | null) => void;
  sending: boolean;
  mapTileUrl?: string | null;
}) {
  const [status, setStatus] = useState<"locating" | "ready" | "error">("locating");
  const [location, setLocation] = useState<SharedLocation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [includeMap, setIncludeMap] = useState(true);
  const [mapPreviewUrl, setMapPreviewUrl] = useState<string | null>(null);
  const [mapBusy, setMapBusy] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const mapBlobRef = useRef<Blob | null>(null);
  const mapEnabled = Boolean(mapTileUrl);

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
      setIncludeMap(true);
      setMapPreviewUrl(null);
      setMapError(null);
      mapBlobRef.current = null;
      return;
    }
    // 열리는 순간(사용자 클릭)에 권한 프롬프트를 띄운다.
    void locate();
  }, [open, locate]);

  // 위치·설정이 바뀌면 지도 미리보기를 다시 만든다.
  useEffect(() => {
    if (!open || !mapEnabled || !includeMap || !location || !mapTileUrl) {
      setMapPreviewUrl(null);
      mapBlobRef.current = null;
      return;
    }
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setMapBusy(true);
    setMapError(null);
    renderStaticMap({
      lat: location.lat,
      lng: location.lng,
      tileUrl: mapTileUrl,
      signal: controller.signal,
    })
      .then((blob) => {
        if (controller.signal.aborted) return;
        mapBlobRef.current = blob;
        objectUrl = URL.createObjectURL(blob);
        setMapPreviewUrl(objectUrl);
      })
      .catch((caught) => {
        if (controller.signal.aborted) return;
        mapBlobRef.current = null;
        setMapError(
          caught instanceof DOMException && caught.name === "AbortError"
            ? null
            : "지도 이미지를 만들 수 없습니다. 좌표로만 보냅니다.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setMapBusy(false);
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [open, mapEnabled, includeMap, location, mapTileUrl]);

  function send(): void {
    if (!location || sending) return;
    const trimmed = label.trim();
    const payload: LocationShareRequest = {
      ...location,
      at: new Date().toISOString(),
      ...(trimmed ? { label: trimmed.slice(0, LOCATION_LABEL_MAX) } : {}),
    };
    onSend(payload, includeMap ? mapBlobRef.current : null);
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
            {mapEnabled && includeMap && mapPreviewUrl ? (
              <div className="overflow-hidden rounded-xl border border-zinc-200">
                <img
                  src={mapPreviewUrl}
                  alt="현재 위치 지도 미리보기"
                  data-testid="location-map-preview"
                  className="h-48 w-full object-cover"
                />
              </div>
            ) : null}
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
                  <p className="text-xs text-zinc-500">
                    {formatAccuracy(location.accuracy)}
                    {mapEnabled && includeMap && mapBusy ? " · 지도 준비 중…" : ""}
                  </p>
                </div>
              </div>
            </div>
            {mapEnabled ? (
              <label className="flex items-start gap-2 text-xs text-zinc-600">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 accent-current"
                  checked={includeMap}
                  onChange={(event) => setIncludeMap(event.target.checked)}
                  data-testid="location-include-map"
                />
                <span>
                  <span className="font-medium text-zinc-800">지도 이미지 함께 보내기</span>
                  <br />
                  이 브라우저에서 지도를 그려 암호화해 보냅니다. 상대는 지도 서비스에 접속하지
                  않습니다.
                </span>
              </label>
            ) : null}
            {mapError ? <p className="text-[11px] text-amber-700">{mapError}</p> : null}
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
