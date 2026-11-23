import { randomUUID } from "node:crypto";

import type { WebSocket } from "ws";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestContext, resetDatabase, type TestContext } from "./support/context.js";
import {
  createIdentity,
  decryptMessage,
  encryptMessage,
  type Identity,
} from "./support/crypto.js";
import { TestClient } from "./support/http.js";
import {
  closeSocket,
  connect,
  connectAndCollect,
  sendFrame,
  type FrameCollector,
} from "./support/ws.js";

interface Account {
  client: TestClient;
  identity: Identity;
  userId: string;
  deviceId: string;
  username: string;
}

interface ActiveDevice {
  id: string;
  userId: string;
  identityPublicKey: string;
  signingPublicKey: string;
}

let ctx: TestContext;

async function registerAccount(prefix: string): Promise<Account> {
  const client = new TestClient(ctx.baseUrl);
  const identity = createIdentity();
  const username = `${prefix}${randomUUID().slice(0, 8)}`;
  const response = await client.register(username, identity);
  expect(response.status).toBe(201);
  return {
    client,
    identity,
    userId: response.body.user.id,
    deviceId: response.body.device.id,
    username,
  };
}

async function createConversation(initiator: Account, peer: Account): Promise<string> {
  const response = await initiator.client.request("POST", "/api/conversations", {
    body: { peerUserId: peer.userId },
  });
  expect(response.status).toBe(201);
  return response.body.conversation.id;
}

async function activeDevices(
  client: TestClient,
  conversationId: string,
): Promise<ActiveDevice[]> {
  const response = await client.request(
    "GET",
    `/api/conversations/${conversationId}/devices`,
  );
  expect(response.status).toBe(200);
  return response.body.devices;
}

function recipients(devices: ActiveDevice[]) {
  return devices.map((device) => ({
    deviceId: device.id,
    identityPublicKey: device.identityPublicKey,
  }));
}

async function openSocket(
  account: Account,
): Promise<{ socket: WebSocket; frames: FrameCollector }> {
  const { socket, frames } = await connectAndCollect(
    ctx.wsUrl,
    account.client.cookieHeader(),
  );
  const ready = await frames.next((frame) => frame.type === "ready");
  expect(ready.userId).toBe(account.userId);
  expect(ready.deviceId).toBe(account.deviceId);
  return { socket, frames };
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

describe("websocket realtime", () => {
  it("pushes REST messages with the recipient device key", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const conversationId = await createConversation(alice, bob);
    const devices = await activeDevices(alice.client, conversationId);

    const bobSocket = await openSocket(bob);
    try {
      sendFrame(bobSocket.socket, {
        type: "subscribe",
        conversationIds: [conversationId],
      });
      const subscribed = await bobSocket.frames.next((frame) => frame.type === "subscribed");
      expect(subscribed.conversationIds).toEqual([conversationId]);

      const envelope = encryptMessage({
        conversationId,
        clientMessageId: "rt-1",
        plaintext: "실시간으로 도착한 암호문",
        sender: alice.identity,
        recipients: recipients(devices),
      });
      const sent = await alice.client.request(
        "POST",
        `/api/conversations/${conversationId}/messages`,
        { body: envelope },
      );
      expect(sent.status).toBe(201);

      const event = await bobSocket.frames.next((frame) => frame.type === "message.created");
      expect(event.message.id).toBe(sent.body.message.id);
      expect(event.message.key.deviceId).toBe(bob.deviceId);
      expect(
        decryptMessage({
          identity: bob.identity,
          senderSigningPublicKey: alice.identity.signing.publicKeyBase64,
          message: event.message,
        }),
      ).toBe("실시간으로 도착한 암호문");
    } finally {
      await closeSocket(bobSocket.socket);
    }
  });

  it("pushes new conversations to peers even before they subscribe", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const conversationId = await createConversation(alice, bob);
    const devices = await activeDevices(alice.client, conversationId);

    const bobSocket = await openSocket(bob);
    try {
      // 구독하지 않은 상태에서도 참여자에게는 메시지 이벤트가 간다.
      const envelope = encryptMessage({
        conversationId,
        clientMessageId: "unsubscribed-1",
        plaintext: "첫 메시지",
        sender: alice.identity,
        recipients: recipients(devices),
      });
      const sent = await alice.client.request(
        "POST",
        `/api/conversations/${conversationId}/messages`,
        { body: envelope },
      );
      expect(sent.status).toBe(201);

      const event = await bobSocket.frames.next((frame) => frame.type === "message.created");
      expect(event.message.conversationId).toBe(conversationId);
      expect(event.message.key.deviceId).toBe(bob.deviceId);
      expect(
        decryptMessage({
          identity: bob.identity,
          senderSigningPublicKey: alice.identity.signing.publicKeyBase64,
          message: event.message,
        }),
      ).toBe("첫 메시지");
    } finally {
      await closeSocket(bobSocket.socket);
    }
  });

  it("accepts encrypted frames and acknowledges them", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const conversationId = await createConversation(alice, bob);
    const devices = await activeDevices(alice.client, conversationId);

    const aliceSocket = await openSocket(alice);
    const bobSocket = await openSocket(bob);
    try {
      sendFrame(aliceSocket.socket, {
        type: "subscribe",
        conversationIds: [conversationId],
      });
      await aliceSocket.frames.next((frame) => frame.type === "subscribed");
      sendFrame(bobSocket.socket, {
        type: "subscribe",
        conversationIds: [conversationId],
      });
      await bobSocket.frames.next((frame) => frame.type === "subscribed");

      const envelope = encryptMessage({
        conversationId,
        clientMessageId: "ws-1",
        plaintext: "소켓으로 보낸 메시지",
        sender: bob.identity,
        recipients: recipients(devices),
      });
      sendFrame(bobSocket.socket, {
        type: "message.send",
        conversationId,
        ...envelope,
      });

      const ack = await bobSocket.frames.next((frame) => frame.type === "message.ack");
      expect(ack.clientMessageId).toBe("ws-1");
      expect(ack.message.key.deviceId).toBe(bob.deviceId);

      const delivered = await aliceSocket.frames.next(
        (frame) => frame.type === "message.created",
      );
      expect(delivered.message.id).toBe(ack.message.id);
      expect(delivered.message.key.deviceId).toBe(alice.deviceId);
      expect(
        decryptMessage({
          identity: alice.identity,
          senderSigningPublicKey: bob.identity.signing.publicKeyBase64,
          message: delivered.message,
        }),
      ).toBe("소켓으로 보낸 메시지");

      const history = await alice.client.request(
        "GET",
        `/api/conversations/${conversationId}/messages`,
      );
      expect(history.body.messages).toHaveLength(1);
    } finally {
      await closeSocket(aliceSocket.socket);
      await closeSocket(bobSocket.socket);
    }
  });

  it("sends each connected device only its own envelope", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const conversationId = await createConversation(alice, bob);

    const laptopIdentity = createIdentity();
    const added = await bob.client.addDevice("laptop", laptopIdentity);
    expect(added.status).toBe(201);
    const laptopDeviceId = added.body.device.id as string;

    const laptopClient = new TestClient(ctx.baseUrl);
    const laptopLogin = await laptopClient.request("POST", "/api/auth/login", {
      body: {
        username: bob.username,
        password: "password-12345",
        deviceId: laptopDeviceId,
      },
    });
    expect(laptopLogin.status).toBe(200);

    const devices = await activeDevices(alice.client, conversationId);
    expect(devices).toHaveLength(3);

    const bobSocket = await openSocket(bob);
    const laptopSocket = await openSocket({
      client: laptopClient,
      identity: laptopIdentity,
      userId: bob.userId,
      deviceId: laptopDeviceId,
      username: bob.username,
    });

    try {
      for (const socket of [bobSocket, laptopSocket]) {
        sendFrame(socket.socket, { type: "subscribe", conversationIds: [conversationId] });
        await socket.frames.next((frame) => frame.type === "subscribed");
      }

      const envelope = encryptMessage({
        conversationId,
        clientMessageId: "multi-device",
        plaintext: "기기별 봉투",
        sender: alice.identity,
        recipients: recipients(devices),
      });
      const sent = await alice.client.request(
        "POST",
        `/api/conversations/${conversationId}/messages`,
        { body: envelope },
      );
      expect(sent.status).toBe(201);

      const desktopEvent = await bobSocket.frames.next(
        (frame) => frame.type === "message.created",
      );
      const laptopEvent = await laptopSocket.frames.next(
        (frame) => frame.type === "message.created",
      );

      expect(desktopEvent.message.id).toBe(sent.body.message.id);
      expect(laptopEvent.message.id).toBe(sent.body.message.id);
      expect(desktopEvent.message.key.deviceId).toBe(bob.deviceId);
      expect(laptopEvent.message.key.deviceId).toBe(laptopDeviceId);
      expect(
        decryptMessage({
          identity: bob.identity,
          senderSigningPublicKey: alice.identity.signing.publicKeyBase64,
          message: desktopEvent.message,
        }),
      ).toBe("기기별 봉투");
      expect(
        decryptMessage({
          identity: laptopIdentity,
          senderSigningPublicKey: alice.identity.signing.publicKeyBase64,
          message: laptopEvent.message,
        }),
      ).toBe("기기별 봉투");
    } finally {
      await closeSocket(bobSocket.socket);
      await closeSocket(laptopSocket.socket);
    }
  });

  it("relays typing and presence", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const conversationId = await createConversation(alice, bob);

    const bobSocket = await openSocket(bob);
    try {
      sendFrame(bobSocket.socket, { type: "subscribe", conversationIds: [conversationId] });
      await bobSocket.frames.next((frame) => frame.type === "subscribed");

      const aliceSocket = await openSocket(alice);
      try {
        sendFrame(aliceSocket.socket, {
          type: "subscribe",
          conversationIds: [conversationId],
        });
        await aliceSocket.frames.next((frame) => frame.type === "subscribed");

        const online = await bobSocket.frames.next(
          (frame) => frame.type === "presence" && frame.state === "online",
        );
        expect(online.userId).toBe(alice.userId);

        sendFrame(aliceSocket.socket, {
          type: "typing",
          conversationId,
          state: "start",
        });
        const typing = await bobSocket.frames.next((frame) => frame.type === "typing");
        expect(typing.userId).toBe(alice.userId);
        expect(typing.state).toBe("start");

        sendFrame(aliceSocket.socket, { type: "ping" });
        const pong = await aliceSocket.frames.next((frame) => frame.type === "pong");
        expect(pong.at).toBeTypeOf("string");
      } finally {
        await closeSocket(aliceSocket.socket);
      }

      const offline = await bobSocket.frames.next(
        (frame) => frame.type === "presence" && frame.state === "offline",
      );
      expect(offline.userId).toBe(alice.userId);
    } finally {
      await closeSocket(bobSocket.socket);
    }
  });

  it("rejects unauthorized sockets and reports protocol errors", async () => {
    await expect(connect(ctx.wsUrl, "om_session=not-a-real-token")).rejects.toThrow(/401/);

    const alice = await registerAccount("alice");
    const { socket, frames } = await openSocket(alice);
    try {
      socket.send("this is not json");
      const invalidJson = await frames.next((frame) => frame.type === "error");
      expect(invalidJson.code).toBe("INVALID_JSON");

      sendFrame(socket, { type: "subscribe", conversationIds: ["not-a-uuid"] });
      const invalidFrame = await frames.next((frame) => frame.type === "error");
      expect(invalidFrame.code).toBe("INVALID_FRAME");

      // 존재하지 않는 대화 구독은 조용히 무시된다.
      sendFrame(socket, { type: "subscribe", conversationIds: [randomUUID()] });
      const subscribed = await frames.next((frame) => frame.type === "subscribed");
      expect(subscribed.conversationIds).toEqual([]);
    } finally {
      await closeSocket(socket);
    }
  });

  it("refuses sockets bound to revoked devices", async () => {
    const alice = await registerAccount("alice");
    const revoked = await alice.client.request("DELETE", `/api/devices/${alice.deviceId}`);
    expect(revoked.status).toBe(200);

    await expect(
      connect(ctx.wsUrl, alice.client.cookieHeader()),
    ).rejects.toThrow(/401/);
  });

  it("relays 1:1 call signaling to the peer but not back to the caller", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const conversationId = await createConversation(alice, bob);

    const aliceSocket = await openSocket(alice);
    const bobSocket = await openSocket(bob);
    try {
      const callId = randomUUID();
      sendFrame(aliceSocket.socket, {
        type: "call.invite",
        conversationId,
        callId,
        media: "audio",
      });
      const invite = await bobSocket.frames.next((frame) => frame.type === "call.invite");
      expect(invite.callId).toBe(callId);
      expect(invite.conversationId).toBe(conversationId);
      expect(invite.fromUserId).toBe(alice.userId);
      expect(invite.media).toBe("audio");

      // 발신 기기로는 같은 프레임이 되돌아오지 않는다.
      await expect(
        aliceSocket.frames.next((frame) => frame.type === "call.invite", 300),
      ).rejects.toThrow(/Timed out/);

      sendFrame(aliceSocket.socket, {
        type: "call.signal",
        conversationId,
        callId,
        signal: { description: { type: "offer", sdp: "v=0\r\n" } },
      });
      const signal = await bobSocket.frames.next((frame) => frame.type === "call.signal");
      expect(signal.signal.description.type).toBe("offer");
      expect(signal.fromDeviceId).toBe(alice.deviceId);

      sendFrame(bobSocket.socket, {
        type: "call.accept",
        conversationId,
        callId,
        media: "audio",
      });
      const accepted = await aliceSocket.frames.next(
        (frame) => frame.type === "call.accepted",
      );
      expect(accepted.fromUserId).toBe(bob.userId);

      sendFrame(aliceSocket.socket, { type: "call.end", conversationId, callId });
      const ended = await bobSocket.frames.next((frame) => frame.type === "call.ended");
      expect(ended.callId).toBe(callId);
      expect(ended.reason).toBe("hangup");
    } finally {
      await closeSocket(aliceSocket.socket);
      await closeSocket(bobSocket.socket);
    }
  });

  it("rejects calls in group conversations and from non-participants", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const carol = await registerAccount("carol");

    const directId = await createConversation(alice, bob);
    const group = await alice.client.request("POST", "/api/conversations", {
      body: { kind: "group", name: "통화 불가", memberUserIds: [bob.userId] },
    });
    expect(group.status).toBe(201);
    const groupId = group.body.conversation.id as string;

    const aliceSocket = await openSocket(alice);
    const carolSocket = await openSocket(carol);
    try {
      sendFrame(aliceSocket.socket, {
        type: "call.invite",
        conversationId: groupId,
        callId: randomUUID(),
        media: "audio",
      });
      const groupError = await aliceSocket.frames.next((frame) => frame.type === "error");
      expect(groupError.code).toBe("CALL_REQUIRES_DIRECT");

      // 참여자가 아닌 사용자는 대화 존재 여부도 알 수 없다.
      sendFrame(carolSocket.socket, {
        type: "call.invite",
        conversationId: directId,
        callId: randomUUID(),
        media: "audio",
      });
      const strangerError = await carolSocket.frames.next((frame) => frame.type === "error");
      expect(strangerError.code).toBe("CONVERSATION_NOT_FOUND");
    } finally {
      await closeSocket(aliceSocket.socket);
      await closeSocket(carolSocket.socket);
    }
  });
});
