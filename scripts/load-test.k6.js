import http from "k6/http";
import encoding from "k6/encoding";
import { check } from "k6";

/**
 * k6 HTTP 동시성 시나리오.
 * 실제 암호화는 하지 않고, 서버가 검증하는 봉투 형식만 맞춘다(서버 경로 부하 측정).
 * WebSocket 전달 지연은 `scripts/load-test.mjs`로 측정한다.
 *
 * 실행 예:
 *   BASE_URL=http://127.0.0.1:3911 VUS=20 k6 run scripts/load-test.k6.js
 */

const BASE_URL = __ENV.BASE_URL || "http://127.0.0.1:3911";
const VUS = Number(__ENV.VUS || 20);
const DURATION = __ENV.DURATION || "30s";

export const options = {
  scenarios: {
    send: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: "5s", target: VUS },
        { duration: DURATION, target: VUS },
        { duration: "5s", target: 0 },
      ],
      gracefulRampDown: "5s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<500"],
  },
};

const b64 = (bytes) => encoding.b64encode("x".repeat(bytes));
const NONCE = b64(12);
const CIPHERTEXT = b64(64);
const SIGNATURE = b64(64);
const EPHEMERAL = b64(32);
const WRAPPED = b64(48);

function register(prefix) {
  const username = `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const response = http.post(
    `${BASE_URL}/api/auth/register`,
    JSON.stringify({
      username,
      password: "password-12345",
      device: {
        name: "k6",
        identityPublicKey: b64(32),
        signingPublicKey: b64(32),
      },
    }),
    { headers: { "content-type": "application/json" } },
  );
  const body = response.json();
  const cookie = response.cookies.om_session?.[0]?.value;
  if (!cookie) throw new Error(`registration failed: ${response.status}`);
  return {
    username,
    userId: body.user.id,
    cookie,
    csrfToken: body.csrfToken,
  };
}

export function setup() {
  const alice = register("k6alice");
  const bob = register("k6bob");

  const conversation = http.post(
    `${BASE_URL}/api/conversations`,
    JSON.stringify({ peerUserId: bob.userId }),
    {
      headers: {
        cookie: `om_session=${alice.cookie}`,
        "x-csrf-token": alice.csrfToken,
        "content-type": "application/json",
      },
    },
  );
  const conversationId = conversation.json("conversation.id");
  if (!conversationId) throw new Error("conversation setup failed");

  const devices = http.get(`${BASE_URL}/api/conversations/${conversationId}/devices`, {
    headers: { cookie: `om_session=${alice.cookie}` },
  });
  const deviceList = devices.json("devices");
  if (!Array.isArray(deviceList) || deviceList.length === 0) {
    throw new Error("device setup failed");
  }

  return {
    conversationId,
    devices: deviceList.map((device) => ({ id: device.id })),
    alice,
    bob,
  };
}

export default function (data) {
  const account = __VU % 2 === 0 ? data.alice : data.bob;
  const clientMessageId = `k6-${__VU}-${__ITER}-${Date.now()}`;
  const payload = {
    clientMessageId,
    ciphertext: CIPHERTEXT,
    nonce: NONCE,
    signature: SIGNATURE,
    keys: data.devices.map((device) => ({
      deviceId: device.id,
      ephemeralPublicKey: EPHEMERAL,
      wrappedKey: WRAPPED,
      wrapNonce: NONCE,
      version: 1,
    })),
  };

  const response = http.post(
    `${BASE_URL}/api/conversations/${data.conversationId}/messages`,
    JSON.stringify(payload),
    {
      headers: {
        cookie: `om_session=${account.cookie}`,
        "x-csrf-token": account.csrfToken,
        "content-type": "application/json",
      },
      tags: { name: "send_message" },
    },
  );
  check(response, {
    "message created": (result) => result.status === 201,
  });
}
