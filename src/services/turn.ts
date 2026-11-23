import { createHmac } from "node:crypto";

import type { Config } from "../config.js";

/**
 * 1:1 음성 통화용 ICE 서버 목록.
 *
 * - STUN: 공인 IP/포트를 알아내 NAT 통과를 돕는다(비밀 없음).
 * - TURN: P2P 가 막힌 망에서 미디어를 중계한다. 서버는 암호문(DTLS-SRTP)만 전달한다.
 *   자격증명은 coturn REST API 규약(HMAC-SHA1)으로 **시간 제한** 발급한다.
 */
export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

/** coturn REST API 규약: username=만료시각:사용자, credential=base64(HMAC-SHA1(secret, username)). */
export function turnCredential(input: {
  secret: string;
  userId: string;
  ttlSeconds: number;
  now?: Date;
}): { username: string; credential: string } {
  const expiresAt = Math.floor((input.now ?? new Date()).getTime() / 1000) + input.ttlSeconds;
  const username = `${expiresAt}:${input.userId}`;
  const credential = createHmac("sha1", input.secret).update(username).digest("base64");
  return { username, credential };
}

/** 통화 설정을 클라이언트 `RTCPeerConnection` 에 넘길 형태로 만든다. */
export function buildIceServers(config: Config, userId: string, now?: Date): IceServer[] {
  const servers: IceServer[] = [];
  if (config.calls.stunUrls.length > 0) {
    servers.push({ urls: [...config.calls.stunUrls] });
  }
  if (config.calls.turnUrls.length > 0 && config.calls.turnSecret) {
    servers.push({
      urls: [...config.calls.turnUrls],
      ...turnCredential({
        secret: config.calls.turnSecret,
        userId,
        ttlSeconds: config.calls.turnTtlSeconds,
        now,
      }),
    });
  }
  return servers;
}
