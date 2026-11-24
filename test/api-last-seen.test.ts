import { randomUUID } from "node:crypto";

import type { WebSocket } from "ws";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestContext, resetDatabase, type TestContext } from "./support/context.js";
import { createIdentity, type Identity } from "./support/crypto.js";
import { TestClient } from "./support/http.js";
import { closeSocket, connectAndCollect } from "./support/ws.js";

interface Account {
  client: TestClient;
  identity: Identity;
  userId: string;
}

interface PeerRow {
  peer: { id: string; lastSeenAt: string | null } | null;
}

let ctx: TestContext;

async function registerAccount(prefix: string): Promise<Account> {
  const client = new TestClient(ctx.baseUrl);
  const identity = createIdentity();
  const username = `${prefix}${randomUUID().slice(0, 8)}`;
  const response = await client.register(username, identity);
  expect(response.status).toBe(201);
  return { client, identity, userId: response.body.user.id };
}

async function openSocket(account: Account): Promise<WebSocket> {
  const { socket, frames } = await connectAndCollect(
    ctx.wsUrl,
    account.client.cookieHeader(),
  );
  await frames.next((frame) => frame.type === "ready");
  return socket;
}

/** 대화 목록 응답에서 상대의 lastSeenAt 을 읽는다(WS 갱신은 비동기라 잠시 재시도). */
async function peerLastSeen(viewer: TestClient, peer: Account): Promise<string | null> {
  let latest: string | null = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await viewer.request("GET", "/api/conversations");
    const rows = response.body.conversations as PeerRow[];
    latest = rows.find((row) => row.peer?.id === peer.userId)?.peer?.lastSeenAt ?? null;
    if (latest) return latest;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return latest;
}

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.db);
});

describe("last seen visibility", () => {
  it("keeps last seen private until the user opts in", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const conversation = await alice.client.request("POST", "/api/conversations", {
      body: { peerUserId: bob.userId },
    });
    expect(conversation.status).toBe(201);
    expect(conversation.body.conversation.peer.lastSeenAt).toBeNull();

    const me = await bob.client.request("GET", "/api/auth/me");
    expect(me.body.user.lastSeenVisible).toBe(false);

    // WS 접속으로 시각은 기록되지만, 옵트인 전에는 상대에게 보이지 않는다.
    const socket = await openSocket(bob);
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await peerLastSeen(alice.client, bob)).toBeNull();

      const enabled = await bob.client.request("PUT", "/api/auth/profile/last-seen", {
        body: { visible: true },
      });
      expect(enabled.status).toBe(200);
      expect(enabled.body.user.lastSeenVisible).toBe(true);
      expect(typeof (await peerLastSeen(alice.client, bob))).toBe("string");

      const disabled = await bob.client.request("PUT", "/api/auth/profile/last-seen", {
        body: { visible: false },
      });
      expect(disabled.body.user.lastSeenVisible).toBe(false);
      expect(await peerLastSeen(alice.client, bob)).toBeNull();
    } finally {
      await closeSocket(socket);
    }
  });

  it("validates the request body and requires a session", async () => {
    const bob = await registerAccount("bob");
    const invalid = await bob.client.request("PUT", "/api/auth/profile/last-seen", {
      body: { visible: "yes" },
    });
    expect(invalid.status).toBe(400);

    const anonymous = new TestClient(ctx.baseUrl);
    const unauthorized = await anonymous.request("PUT", "/api/auth/profile/last-seen", {
      body: { visible: true },
      csrf: false,
    });
    expect(unauthorized.status).toBe(401);
  });
});

