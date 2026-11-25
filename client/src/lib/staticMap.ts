/**
 * 지도 이미지(정적 타일 합성) 헬퍼.
 *
 * **발신자 브라우저에서만** 타일을 받아 캔버스로 합성하고 PNG 로 만든다.
 * - 서버는 좌표를 모른다(이미지는 첨부 암호문으로만 업로드).
 * - 수신자는 타일 서버에 요청하지 않는다(복호화된 이미지를 볼 뿐).
 * - 타일 서버에는 발신자의 IP·대략적 위치가 노출되므로 사용자가 명시적으로 선택할 때만 실행한다.
 */

export interface TilePoint {
  x: number;
  y: number;
}

/** 위경도 → 타일 좌표(소수 포함). 줌 레벨에 따른 Web Mercator 변환. */
export function latLngToTile(lat: number, lng: number, zoom: number): TilePoint {
  const scale = 2 ** zoom;
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const x = ((lng + 180) / 360) * scale;
  const sin = Math.sin((clampedLat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale;
  return { x, y };
}

export interface TileRange {
  zoom: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  /** 캔버스에 그릴 때의 타일 오프셋(px). */
  offsetX: number;
  offsetY: number;
}

/** 화면 크기에 필요한 타일 범위를 계산한다(타일 크기 256px 고정). */
export function tilesFor(input: {
  lat: number;
  lng: number;
  zoom: number;
  width: number;
  height: number;
  tileSize?: number;
}): TileRange {
  const tileSize = input.tileSize ?? 256;
  const center = latLngToTile(input.lat, input.lng, input.zoom);
  const centerPxX = center.x * tileSize;
  const centerPxY = center.y * tileSize;
  const left = centerPxX - input.width / 2;
  const top = centerPxY - input.height / 2;
  const maxTile = 2 ** input.zoom - 1;
  return {
    zoom: input.zoom,
    minX: Math.max(0, Math.floor(left / tileSize)),
    maxX: Math.min(maxTile, Math.floor((left + input.width) / tileSize)),
    minY: Math.max(0, Math.floor(top / tileSize)),
    maxY: Math.min(maxTile, Math.floor((top + input.height) / tileSize)),
    offsetX: -left,
    offsetY: -top,
  };
}

/** 타일 템플릿의 {z}/{x}/{y} 를 치환한다(서브도메인 {s} 는 순환). */
export function tileUrlFor(template: string, zoom: number, x: number, y: number): string {
  const subdomains = ["a", "b", "c"];
  return template
    .replace(/\{z\}/g, String(zoom))
    .replace(/\{x\}/g, String(x))
    .replace(/\{y\}/g, String(y))
    .replace(/\{s\}/g, subdomains[(x + y) % subdomains.length] as string);
}

/** 지도 저작자 표시(타일 제공자에 맞춰 문구를 고른다). */
export function attributionFor(template: string): string {
  return /openstreetmap/i.test(template) ? "© OpenStreetMap contributors" : "© map tiles";
}

const DEFAULT_ZOOM = 15;
const DEFAULT_WIDTH = 480;
const DEFAULT_HEIGHT = 360;

function loadTile(url: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.referrerPolicy = "no-referrer";
    const onAbort = () => {
      cleanup();
      reject(new DOMException("aborted", "AbortError"));
    };
    const cleanup = () => {
      image.onload = null;
      image.onerror = null;
      signal?.removeEventListener("abort", onAbort);
    };
    image.onload = () => {
      cleanup();
      resolve(image);
    };
    image.onerror = () => {
      cleanup();
      reject(new Error("tile_unavailable"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    image.src = url;
  });
}

/**
 * 현재 위치 주변 타일을 합성해 지도 PNG 를 만든다.
 *
 * CORS/네트워크 문제로 타일을 받지 못하면 예외를 던진다(호출측은 좌표 카드로 폴백).
 */
export async function renderStaticMap(input: {
  lat: number;
  lng: number;
  tileUrl: string;
  zoom?: number;
  width?: number;
  height?: number;
  signal?: AbortSignal;
}): Promise<Blob> {
  const zoom = input.zoom ?? DEFAULT_ZOOM;
  const width = input.width ?? DEFAULT_WIDTH;
  const height = input.height ?? DEFAULT_HEIGHT;
  const range = tilesFor({ lat: input.lat, lng: input.lng, zoom, width, height });

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas_unavailable");

  const jobs: Array<{ x: number; y: number; promise: Promise<HTMLImageElement> }> = [];
  for (let x = range.minX; x <= range.maxX; x += 1) {
    for (let y = range.minY; y <= range.maxY; y += 1) {
      jobs.push({ x, y, promise: loadTile(tileUrlFor(input.tileUrl, zoom, x, y), input.signal) });
    }
  }
  const tiles = await Promise.all(jobs.map((job) => job.promise));

  jobs.forEach((job, index) => {
    const tile = tiles[index];
    if (!tile) return;
    context.drawImage(
      tile,
      (job.x - range.minX) * 256 + range.offsetX,
      (job.y - range.minY) * 256 + range.offsetY,
    );
  });

  // 중앙 마커(정확도 원 + 점).
  const centerX = width / 2;
  const centerY = height / 2;
  context.beginPath();
  context.arc(centerX, centerY, 18, 0, Math.PI * 2);
  context.fillStyle = "rgba(124, 58, 237, 0.25)";
  context.fill();
  context.beginPath();
  context.arc(centerX, centerY, 7, 0, Math.PI * 2);
  context.fillStyle = "#7c3aed";
  context.strokeStyle = "#ffffff";
  context.lineWidth = 2;
  context.fill();
  context.stroke();

  // 저작자 표시(필수).
  const attribution = attributionFor(input.tileUrl);
  context.font = "11px sans-serif";
  const textWidth = context.measureText(attribution).width;
  context.fillStyle = "rgba(255, 255, 255, 0.85)";
  context.fillRect(width - textWidth - 10, height - 18, textWidth + 8, 16);
  context.fillStyle = "#374151";
  context.fillText(attribution, width - textWidth - 6, height - 6);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("map_render_failed"));
    }, "image/png");
  });
}

