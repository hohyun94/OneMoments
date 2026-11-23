import { randomUUID } from "node:crypto";

import type { WebSocket } from "ws";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestContext, resetDatabase, type TestContext } from "./support/context.js";
import { createIdentity, type Identity } from "./support/crypto.js";
import { TestClient } from "./support/http.js";
import {
  closeSocket,
  connectAndCollect,
  sendFrame,
  type FrameCollector,
} from "./support/ws.js";

interface Account {
  client: TestClient;
  identity: Identity;
  userId: string;
  username: string;
}

interface CallLogEntry {
  callId: string;
  status: string;
  direction: "outgoing" | "incoming";
  durationSeconds: number | null;
}

let ctx: TestContext;

async function registerAccount(prefix: string): Promise<Account> {
  const client = new TestClient(ctx.baseUrl);
  const identity = createIdentity();
  const username = `${prefix}${randomUUID().slice(0, 8)}`;
  const response = await client.register(username, identity);
  expect(response.status).toBe(201);
  return { client, identity, userId: response.body.user.id, username };
}

async function createConversation(initiator: Account, peer: Account): Promise<string> {
  const response = await initiator.client.request("POST", "/api/conversations", {
    body: { peerUserId: peer.userId },
  });
  expect(response.status).toBe(201);
  return response.body.conversation.id;
}

async function openSocket(
  account: Account,
): Promise<{ socket: WebSocket; frames: FrameCollector }> {
  const { socket, frames } = await connectAndCollect(
    ctx.wsUrl,
    account.client.cookieHeader(),
  );
  await frames.next((frame) => frame.type === "ready");
  return { socket, frames };
}

async function listCalls(client: TestClient, conversationId: string): Promise<CallLogEntry[]> {
  const response = await client.request("GET", `/api/conversations/${conversationId}/calls`);
  expect(response.status).toBe(200);
  return response.body.calls;
}

/** 기록은 시그널링과 별도로 비동기 저장되므로 잠시 기다린다. */
async function waitForCall(
  client: TestClient,
  conversationId: string,
  predicate: (call: CallLogEntry) => boolean,
): Promise<CallLogEntry> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const calls = await listCalls(client, conversationId);
    const found = calls.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("call log was not recorded in time");
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


describe("voice call logs", () => {
  it("records missed, declined, and completed calls with metadata only", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const carol = await registerAccount("carol");
    const conversationId = await createConversation(alice, bob);

    const aliceSocket = await openSocket(alice);
    const bobSocket = await openSocket(bob);
    try {
      // 1) 응답 없이 취소 → 부재중
      const missedId = randomUUID();
      sendFrame(aliceSocket.socket, {
        type: "call.invite",
        conversationId,
        callId: missedId,
        media: "audio",
      });
      await bobSocket.frames.next((frame) => frame.type === "call.invite");
      sendFrame(aliceSocket.socket, { type: "call.cancel", conversationId, callId: missedId });
      await bobSocket.frames.next((frame) => frame.type === "call.cancelled");

      const missed = await waitForCall(
        bob.client,
        conversationId,
        (call) => call.callId === missedId,
      );
      expect(missed.status).toBe("missed");
      expect(missed.direction).toBe("incoming");
      expect(missed.durationSeconds).toBeNull();

      // 수신자 대화 목록에는 확인 전까지 부재중 배지 수가 잡힌다.
      const missedBadge = async (client: TestClient): Promise<number> => {
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const response = await client.request("GET", "/api/conversations");
          const entry = (response.body.conversations as Array<{ id: string; missedCallCount: number }>)
            .find((item) => item.id === conversationId);
          if (entry && entry.missedCallCount > 0) return entry.missedCallCount;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return 0;
      };
      expect(await missedBadge(bob.client)).toBe(1);
      const conversationsForCaller = await alice.client.request("GET", "/api/conversations");
      expect(
        (conversationsForCaller.body.conversations as Array<{ id: string; missedCallCount: number }>)
          .find((item) => item.id === conversationId)?.missedCallCount,
      ).toBe(0);

      // 대화를 열면(확인 처리) 배지가 사라진다.
      const seen = await bob.client.request(
        "POST",
        `/api/conversations/${conversationId}/calls/seen`,
      );
      expect(seen.status).toBe(200);
      expect(seen.body.cleared).toBe(1);
      const afterSeen = await bob.client.request("GET", "/api/conversations");
      expect(
        (afterSeen.body.conversations as Array<{ id: string; missedCallCount: number }>)
          .find((item) => item.id === conversationId)?.missedCallCount,
      ).toBe(0);

      // 2) 거절
      const declinedId = randomUUID();
      sendFrame(aliceSocket.socket, {
        type: "call.invite",
        conversationId,
        callId: declinedId,
        media: "audio",
      });
      await bobSocket.frames.next(
        (frame) => frame.type === "call.invite" && frame.callId === declinedId,
      );
      sendFrame(bobSocket.socket, {
        type: "call.decline",
        conversationId,
        callId: declinedId,
        reason: "declined",
      });
      await aliceSocket.frames.next((frame) => frame.type === "call.declined");

      const declined = await waitForCall(
        alice.client,
        conversationId,
        (call) => call.callId === declinedId,
      );
      expect(declined.status).toBe("declined");
      expect(declined.direction).toBe("outgoing");

      // 3) 수락 후 종료 → 완료 + 길이 기록
      const completedId = randomUUID();
      sendFrame(aliceSocket.socket, {
        type: "call.invite",
        conversationId,
        callId: completedId,
        media: "audio",
      });
      await bobSocket.frames.next(
        (frame) => frame.type === "call.invite" && frame.callId === completedId,
      );
      sendFrame(bobSocket.socket, {
        type: "call.accept",
        conversationId,
        callId: completedId,
        media: "audio",
      });
      await aliceSocket.frames.next((frame) => frame.type === "call.accepted");
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      sendFrame(bobSocket.socket, { type: "call.end", conversationId, callId: completedId });
      await aliceSocket.frames.next((frame) => frame.type === "call.ended");

      const completed = await waitForCall(
        alice.client,
        conversationId,
        (call) => call.callId === completedId && call.status === "completed",
      );
      expect(completed.durationSeconds).toBeGreaterThanOrEqual(1);
      expect(completed.direction).toBe("outgoing");

      // 최신순 + 참여자만 조회 가능.
      const calls = await listCalls(alice.client, conversationId);
      expect(calls[0]?.callId).toBe(completedId);
      expect(calls).toHaveLength(3);

      const stranger = await carol.client.request(
        "GET",
        `/api/conversations/${conversationId}/calls`,
      );
      expect(stranger.status).toBe(404);
    } finally {
      await closeSocket(aliceSocket.socket);
      await closeSocket(bobSocket.socket);
    }
  });
});
