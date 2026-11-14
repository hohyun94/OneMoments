import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import { createTestContext, resetDatabase, type TestContext } from "./support/context.js";
import { createIdentity } from "./support/crypto.js";
import { TestClient } from "./support/http.js";

interface Account {
  client: TestClient;
  userId: string;
}

let ctx: TestContext;

async function registerAccount(prefix: string): Promise<Account> {
  const client = new TestClient(ctx.baseUrl);
  const identity = createIdentity();
  const response = await client.register(`${prefix}${randomUUID().slice(0, 8)}`, identity);
  expect(response.status).toBe(201);
  return { client, userId: response.body.user.id };
}

describe("group invites", () => {
  beforeEach(async () => {
    ctx = await createTestContext();
    await resetDatabase(ctx.db);
  });

  it("creates a token, accepts it, and enforces max uses", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const carol = await registerAccount("carol");
    const created = await alice.client.request("POST", "/api/conversations", {
      body: {
        kind: "group",
        name: "invite group",
        memberUserIds: [bob.userId],
      },
    });
    expect(created.status).toBe(201);
    const conversationId = created.body.conversation.id as string;

    const forbidden = await bob.client.request(
      "POST",
      `/api/conversations/${conversationId}/invites`,
      { body: {} },
    );
    expect(forbidden.status).toBe(403);

    const invite = await alice.client.request(
      "POST",
      `/api/conversations/${conversationId}/invites`,
      { body: { maxUses: 1 } },
    );
    expect(invite.status).toBe(201);
    const token = invite.body.invite.token as string;

    const accepted = await carol.client.request(
      "POST",
      `/api/invites/${token}/accept`,
    );
    expect(accepted.status).toBe(200);
    expect(accepted.body.conversation.id).toBe(conversationId);

    const conversations = await carol.client.request("GET", "/api/conversations");
    expect(
      conversations.body.conversations.some(
        (conversation: { id: string }) => conversation.id === conversationId,
      ),
    ).toBe(true);

    const exhausted = await registerAccount("dave");
    const rejected = await exhausted.client.request(
      "POST",
      `/api/invites/${token}/accept`,
    );
    expect(rejected.status).toBe(410);

    const invalid = await exhausted.client.request(
      "POST",
      "/api/invites/not-a-real-invite-token-value/accept",
    );
    expect(invalid.status).toBe(404);
  });
});
