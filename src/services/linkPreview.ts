import { lookup } from "node:dns/promises";

/**
 * 링크 미리보기(Open Graph) 수집.
 *
 * **서버가 외부 URL 을 대신 가져온다**는 점 때문에 다음을 강제한다.
 * - http/https 만, 자격증명 포함 URL 금지
 * - 사설/루프백/링크로컬 IP 차단(DNS 해석 후 검사)
 * - 리다이렉트 최대 2회, 매 홉마다 같은 검사
 * - text/html 만, 최대 256KB, 4초 타임아웃, 쿠키/인증 미포함
 *
 * 수집 결과는 **클라이언트가 메시지 암호문 안에 넣어** 전송하므로 서버에는 저장하지 않는다.
 */

export interface LinkPreview {
  url: string;
  title: string | null;
  description: string | null;
  siteName: string | null;
}

const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 4_000;
const MAX_REDIRECTS = 2;
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 400;

/** 사설/예약 대역인지 검사한다(IPv4/IPv6). */
export function isPrivateAddress(address: string): boolean {
  const value = address.trim().toLowerCase();
  if (value.length === 0) return true;

  if (value.includes(":")) {
    if (value === "::" || value === "::1") return true;
    if (value.startsWith("fe80:") || value.startsWith("fc") || value.startsWith("fd")) return true;
    const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    return false;
  }

  const octets = value.split(".").map((part) => Number(part));
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const [a, b] = octets as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

async function resolvesToPublicAddress(hostname: string): Promise<boolean> {
  if (/^[\d.]+$/.test(hostname) || hostname.includes(":")) {
    return !isPrivateAddress(hostname);
  }
  try {
    const records = await lookup(hostname, { all: true });
    if (records.length === 0) return false;
    return records.every((record) => !isPrivateAddress(record.address));
  } catch {
    return false;
  }
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function clean(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  const text = decodeEntities(value).replace(/\s+/g, " ").trim();
  if (text.length === 0) return null;
  return text.slice(0, max);
}

/** HTML 에서 og:* / title / description 만 뽑는다(이미지·스크립트는 사용하지 않는다). */
export function extractLinkMetadata(html: string): {
  title: string | null;
  description: string | null;
  siteName: string | null;
} {
  const meta = new Map<string, string>();
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = new Map<string, string>();
    for (const match of tag.matchAll(/([a-zA-Z:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
      const key = match[1]?.toLowerCase();
      const value = match[3] ?? match[4] ?? "";
      if (key) attrs.set(key, value);
    }
    const name = (attrs.get("property") ?? attrs.get("name") ?? "").toLowerCase();
    const content = attrs.get("content");
    if (name && content && !meta.has(name)) meta.set(name, content);
  }

  const titleTag = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? null;

  return {
    title: clean(meta.get("og:title") ?? titleTag, MAX_TITLE),
    description: clean(
      meta.get("og:description") ?? meta.get("description") ?? meta.get("twitter:description"),
      MAX_DESCRIPTION,
    ),
    siteName: clean(meta.get("og:site_name"), 100),
  };
}

/** 응답 본문을 최대 limit 바이트까지만 읽는다(무한 스트림 방지). */
async function readLimited(response: Response, limit: number): Promise<Buffer | null> {
  if (!response.body) return Buffer.from("");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        chunks.push(value.subarray(0, Math.max(0, value.byteLength - (total - limit))));
        break;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

/**
 * 링크 메타데이터를 가져온다. 안전하지 않은 URL·형식이면 null.
 * `allowPrivate` 는 로컬 테스트 전용이며 라우터는 사용하지 않는다.
 */
export async function fetchLinkPreview(input: {
  url: string;
  allowPrivate?: boolean;
}): Promise<LinkPreview | null> {
  let target: URL;
  try {
    target = new URL(input.url);
  } catch {
    return null;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return null;
  if (target.username || target.password) return null;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!input.allowPrivate && !(await resolvesToPublicAddress(target.hostname))) return null;

    const response = await fetch(target, {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "OneMomentsLinkPreview/1.0",
      },
    }).catch(() => null);
    if (!response) return null;

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return null;
      const next = new URL(location, target);
      if (next.protocol !== "http:" && next.protocol !== "https:") return null;
      target = next;
      continue;
    }
    if (!response.ok) return null;

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("text/html")) return null;

    const buffer = await readLimited(response, MAX_BYTES);
    if (!buffer) return null;
    const metadata = extractLinkMetadata(buffer.toString("utf8"));
    if (!metadata.title && !metadata.description) return null;
    return {
      url: target.toString(),
      title: metadata.title,
      description: metadata.description,
      siteName: metadata.siteName,
    };
  }
  return null;
}

