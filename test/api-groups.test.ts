import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestContext, resetDatabase, type TestContext } from "./support/context.js";
import {
  createIdentity,
  decryptMessage,
  encryptMessage,
  type Identity,
} from "./support/crypto.js";
import { TestClient } from "./support/http.js";

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

interface MessageView {
  id: string;
  conversationId: string;
  senderUserId: string;
  senderDeviceId: string;
  senderSigningPublicKey: string;
  ciphertext: string;
  nonce: string;
  signature: string;
  clientMessageId: string;
  createdAt: string;
  key: {
    deviceId: string;
    ephemeralPublicKey: string;
    wrappedKey: string;
    wrapNonce: string;
    version: 1;
  };
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

async function createGroup(
  creator: Account,
  name: string,
  members: Account[],
): Promise<string> {
  const response = await creator.client.request("POST", "/api/conversations", {
    body: {
      kind: "group",
      name,
      memberUserIds: members.map((member) => member.userId),
    },
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

async function sendMessage(
  sender: Account,
  conversationId: string,
  devices: ActiveDevice[],
  clientMessageId: string,
  plaintext: string,
) {
  const payload = encryptMessage({
    conversationId,
    clientMessageId,
    plaintext,
    sender: sender.identity,
    recipients: recipients(devices),
  });
  return sender.client.request(
    "POST",
    `/api/conversations/${conversationId}/messages`,
    { body: payload },
  );
}

async function history(client: TestClient, conversationId: string): Promise<MessageView[]> {
  const response = await client.request(
    "GET",
    `/api/conversations/${conversationId}/messages`,
  );
  expect(response.status).toBe(200);
  return response.body.messages;
}

function decrypt(viewer: Account, message: MessageView): string {
  return decryptMessage({
    identity: viewer.identity,
    senderSigningPublicKey: message.senderSigningPublicKey,
    message,
  });
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

describe("group conversations", () => {
  it("creates a group and relays each message to all participant devices", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const carol = await registerAccount("carol");

    const response = await alice.client.request("POST", "/api/conversations", {
      body: {
        kind: "group",
        name: "주말 등산",
        memberUserIds: [bob.userId, carol.userId],
      },
    });
    expect(response.status).toBe(201);
    const conversationId = response.body.conversation.id as string;
    expect(response.body.created).toBe(true);
    expect(response.body.conversation).toMatchObject({
      id: conversationId,
      kind: "group",
      name: "주말 등산",
      peer: null,
      memberCount: 3,
    });
    expect(
      response.body.conversation.members.map((member: { username: string }) => member.username),
    ).toEqual(expect.arrayContaining([bob.username, carol.username]));

    const devices = await activeDevices(alice.client, conversationId);
    expect(devices).toHaveLength(3);
    expect(devices.map((device) => device.userId).sort()).toEqual(
      [alice.userId, bob.userId, carol.userId].sort(),
    );

    const sent = await sendMessage(
      alice,
      conversationId,
      devices,
      "group-msg-1",
      "모두 안녕하세요!",
    );
    expect(sent.status).toBe(201);
    expect(sent.body.message.key.deviceId).toBe(alice.deviceId);

    for (const viewer of [alice, bob, carol]) {
      const messages = await history(viewer.client, conversationId);
      expect(messages).toHaveLength(1);
      const message = messages[0];
      if (!message) throw new Error("missing message");
      expect(message.senderUserId).toBe(alice.userId);
      expect(decrypt(viewer, message)).toBe("모두 안녕하세요!");
    }

    const reply = await sendMessage(
      carol,
      conversationId,
      devices,
      "group-msg-2",
      "반가워요!",
    );
    expect(reply.status).toBe(201);
    const aliceHistory = await history(alice.client, conversationId);
    expect(aliceHistory).toHaveLength(2);
    const replyMessage = aliceHistory[0];
    if (!replyMessage) throw new Error("missing reply");
    expect(decrypt(alice, replyMessage)).toBe("반가워요!");

    for (const viewer of [alice, bob, carol]) {
      const list = await viewer.client.request("GET", "/api/conversations");
      expect(list.status).toBe(200);
      const summary = list.body.conversations.find(
        (item: { id: string }) => item.id === conversationId,
      );
      expect(summary).toMatchObject({
        kind: "group",
        name: "주말 등산",
        peer: null,
        memberCount: 3,
      });
    }
  });


  it("adds a member, re-encrypts for the new device set, and hides old messages", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const dave = await registerAccount("dave");
    const conversationId = await createGroup(alice, "프로젝트", [bob]);

    const before = await activeDevices(alice.client, conversationId);
    expect(before).toHaveLength(2);
    const old = await sendMessage(alice, conversationId, before, "before-add", "추가 전 메시지");
    expect(old.status).toBe(201);

    const added = await alice.client.request(
      "POST",
      `/api/conversations/${conversationId}/members`,
      { body: { userIds: [dave.userId] } },
    );
    expect(added.status).toBe(200);
    expect(added.body.added).toBe(1);
    expect(added.body.conversation.memberCount).toBe(3);

    // 새 참여자 추가 후 기존 기기 집합으로 보내면 409 로 재암호화를 요구한다.
    const stale = await sendMessage(alice, conversationId, before, "stale", "기기 집합 변경 전");
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("DEVICE_SET_CHANGED");

    const after = await activeDevices(alice.client, conversationId);
    expect(after).toHaveLength(3);
    const fresh = await sendMessage(alice, conversationId, after, "after-add", "추가 후 메시지");
    expect(fresh.status).toBe(201);

    // 새 참여자는 이후 메시지만 복호화할 수 있다.
    const daveMessages = await history(dave.client, conversationId);
    expect(daveMessages).toHaveLength(1);
    const daveMessage = daveMessages[0];
    if (!daveMessage) throw new Error("missing message");
    expect(decrypt(dave, daveMessage)).toBe("추가 후 메시지");

    // 멱등 추가.
    const again = await alice.client.request(
      "POST",
      `/api/conversations/${conversationId}/members`,
      { body: { userIds: [dave.userId] } },
    );
    expect(again.status).toBe(200);
    expect(again.body.added).toBe(0);
    expect(again.body.conversation.memberCount).toBe(3);

    const list = await dave.client.request("GET", "/api/conversations");
    expect(
      list.body.conversations.find((item: { id: string }) => item.id === conversationId),
    ).toMatchObject({ kind: "group", name: "프로젝트", memberCount: 3 });
  });


  it("renames a group and lets members leave", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const carol = await registerAccount("carol");
    const conversationId = await createGroup(alice, "변경 전", [bob, carol]);

    const renamed = await alice.client.request(
      "PUT",
      `/api/conversations/${conversationId}/group`,
      { body: { name: "변경 후" } },
    );
    expect(renamed.status).toBe(200);
    expect(renamed.body.conversation.name).toBe("변경 후");

    const forbiddenRename = await bob.client.request(
      "PUT",
      `/api/conversations/${conversationId}/group`,
      { body: { name: "권한 없음" } },
    );
    expect(forbiddenRename.status).toBe(403);

    const forbiddenAdd = await bob.client.request(
      "POST",
      `/api/conversations/${conversationId}/members`,
      { body: { userIds: [bob.userId] } },
    );
    expect(forbiddenAdd.status).toBe(403);

    const left = await carol.client.request(
      "DELETE",
      `/api/conversations/${conversationId}/members/me`,
    );
    expect(left.status).toBe(204);
    const carolList = await carol.client.request("GET", "/api/conversations");
    expect(
      carolList.body.conversations.find((item: { id: string }) => item.id === conversationId),
    ).toBeUndefined();

    const renamedAfterLeave = await carol.client.request(
      "PUT",
      `/api/conversations/${conversationId}/group`,
      { body: { name: "권한 없음" } },
    );
    expect(renamedAfterLeave.status).toBe(404);

    await bob.client.request("DELETE", `/api/conversations/${conversationId}/members/me`);
    const aliceList = await alice.client.request("GET", "/api/conversations");
    const solo = aliceList.body.conversations.find(
      (item: { id: string }) => item.id === conversationId,
    );
    expect(solo).toMatchObject({ kind: "group", name: "변경 후", memberCount: 1 });

    const last = await alice.client.request(
      "DELETE",
      `/api/conversations/${conversationId}/members/me`,
    );
    expect(last.status).toBe(204);
    const empty = await alice.client.request("GET", "/api/conversations");
    expect(
      empty.body.conversations.find((item: { id: string }) => item.id === conversationId),
    ).toBeUndefined();
  });

  it("rejects invalid groups, non-participants, and direct-conversation member changes", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const eve = await registerAccount("eve");

    const post = (body: unknown) =>
      alice.client.request("POST", "/api/conversations", { body });

    const noMembers = await post({ kind: "group", name: "빈 그룹", memberUserIds: [] });
    expect(noMembers.status).toBe(400);

    const blankName = await post({
      kind: "group",
      name: "   ",
      memberUserIds: [bob.userId],
    });
    expect(blankName.status).toBe(400);

    const self = await post({
      kind: "group",
      name: "자기 자신",
      memberUserIds: [alice.userId],
    });
    expect(self.status).toBe(400);
    expect(self.body.error.code).toBe("INVALID_GROUP_MEMBERS");

    const unknown = await post({
      kind: "group",
      name: "없는 사용자",
      memberUserIds: [randomUUID()],
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe("USER_NOT_FOUND");

    const conversationId = await createGroup(alice, "권한 테스트", [bob]);
    const outsider = await eve.client.request(
      "POST",
      `/api/conversations/${conversationId}/members`,
      { body: { userIds: [eve.userId] } },
    );
    expect(outsider.status).toBe(404);
    expect(outsider.body.error.code).toBe("CONVERSATION_NOT_FOUND");

    const direct = await alice.client.request("POST", "/api/conversations", {
      body: { peerUserId: bob.userId },
    });
    expect(direct.status).toBe(201);
    const directMembers = await alice.client.request(
      "POST",
      `/api/conversations/${direct.body.conversation.id}/members`,
      { body: { userIds: [eve.userId] } },
    );
    expect(directMembers.status).toBe(400);
    expect(directMembers.body.error.code).toBe("NOT_GROUP_CONVERSATION");

    const single = await alice.client.request(
      "GET",
      `/api/conversations/${conversationId}`,
    );
    expect(single.status).toBe(200);
    expect(single.body.conversation).toMatchObject({
      kind: "group",
      name: "권한 테스트",
      memberCount: 2,
    });
  });
});

