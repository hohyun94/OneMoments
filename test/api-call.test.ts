import { createHmac, randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadConfig, type Config } from "../src/config.js";
import { buildIceServers, turnCredential } from "../src/services/turn.js";
import { createTestContext, resetDatabase, type TestContext } from "./support/context.js";
import { createIdentity } from "./support/crypto.js";
import { TestClient } from "./support/http.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.db);
});

describe("voice call bootstrap", () => {
  it("requires a session and returns the ICE configuration", async () => {
    const anonymous = await new TestClient(ctx.baseUrl).request("GET", "/api/call/config");
    expect(anonymous.status).toBe(401);

    const client = new TestClient(ctx.baseUrl);
    const registered = await client.register(`caller${randomUUID().slice(0, 8)}`, createIdentity());
    expect(registered.status).toBe(201);

    const response = await client.request("GET", "/api/call/config");
    expect(response.status).toBe(200);
    expect(response.body.enabled).toBe(true);
    expect(response.body.videoEnabled).toBe(true);
    expect(response.body.media).toEqual(["audio", "video"]);
    expect(response.body.ringTimeoutSeconds).toBe(30);
    expect(Array.isArray(response.body.iceServers)).toBe(true);
    // 기본 설정에는 TURN 이 없으므로 호스트 후보만 쓴다.
    expect(response.body.iceServers).toHaveLength(0);
  });

  it("issues time-limited TURN credentials with HMAC-SHA1", () => {
    const now = new Date("2026-11-23T00:00:00Z");
    const credentials = turnCredential({
      secret: "test-secret-value",
      userId: "user-1",
      ttlSeconds: 600,
      now,
    });
    const expiresAt = Math.floor(now.getTime() / 1000) + 600;
    expect(credentials.username).toBe(`${expiresAt}:user-1`);
    expect(credentials.credential).toBe(
      createHmac("sha1", "test-secret-value").update(credentials.username).digest("base64"),
    );
  });

  it("builds ICE servers from STUN/TURN settings", () => {
    const config: Config = {
      ...ctx.config,
      calls: {
        ...ctx.config.calls,
        stunUrls: ["stun:stun.example.com:3478"],
        turnUrls: ["turn:turn.example.com:3478?transport=udp", "turns:turn.example.com:5349"],
        turnSecret: "shared-secret-value",
        turnTtlSeconds: 300,
      },
    };
    const servers = buildIceServers(config, "user-1", new Date("2026-11-23T00:00:00Z"));
    expect(servers).toHaveLength(2);
    expect(servers[0]?.urls).toEqual(["stun:stun.example.com:3478"]);
    expect(servers[1]?.urls).toHaveLength(2);
    expect(servers[1]?.username).toContain(":user-1");
    expect(servers[1]?.credential).toBeTruthy();
  });

  it("validates ICE URL schemes and requires a TURN secret", () => {
    const base = {
      NODE_ENV: "test",
      DATABASE_URL: "postgres://user:pass@127.0.0.1:5432/db",
    };
    expect(() => loadConfig({ ...base, CALL_STUN_URLS: "turn:wrong.example.com:3478" })).toThrow(
      /CALL_STUN_URLS/,
    );
    expect(() =>
      loadConfig({ ...base, CALL_TURN_URLS: "turn:turn.example.com:3478" }),
    ).toThrow(/CALL_TURN_SECRET/);

    const parsed = loadConfig({
      ...base,
      CALL_STUN_URLS: "stun:stun.example.com:3478",
      CALL_TURN_URLS: "turn:turn.example.com:3478, turns:turn.example.com:5349",
      CALL_TURN_SECRET: "secret-value-12345",
      CALL_TURN_TTL_SECONDS: "300",
      CALL_RING_TIMEOUT_SECONDS: "45",
    });
    expect(parsed.calls.enabled).toBe(true);
    expect(parsed.calls.stunUrls).toEqual(["stun:stun.example.com:3478"]);
    expect(parsed.calls.turnUrls).toEqual([
      "turn:turn.example.com:3478",
      "turns:turn.example.com:5349",
    ]);
    expect(parsed.calls.turnTtlSeconds).toBe(300);
    expect(parsed.calls.ringTimeoutSeconds).toBe(45);

    const disabled = loadConfig({ ...base, CALL_ENABLED: "false" });
    expect(disabled.calls.enabled).toBe(false);
  });
});
