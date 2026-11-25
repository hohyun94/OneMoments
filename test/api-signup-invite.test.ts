import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestContext, resetDatabase, type TestContext } from "./support/context.js";
import { createIdentity } from "./support/crypto.js";
import { TestClient } from "./support/http.js";
import { createSignupInvite } from "../src/services/signupInvites.js";

const ADMIN_USERNAME = `admininvite${randomUUID().slice(0, 8)}`;

let ctx: TestContext;

async function createInvite(
  admin: TestClient,
  body: { maxUses?: number; expiresInDays?: number | null },
): Promise<{ id: string; code: string }> {
  const response = await admin.request("POST", "/api/admin/signup-invites", { body });
  expect(response.status).toBe(201);
  return response.body.invite;
}

/**
 * 초대제에서는 관리자도 코드 없이 가입할 수 없다.
 * 배포에서는 기존 관리자 계정이 있으므로, 테스트에서는 코드를 직접 발급해 관리자를 만든다.
 */
async function bootstrapAdmin(client: TestClient): Promise<string> {
  const invite = await createSignupInvite(ctx.db, {
    createdByUserId: null,
    maxUses: 1,
    expiresAt: null,
  });
  const response = await client.register(ADMIN_USERNAME, createIdentity(), {
    inviteCode: invite.code,
  });
  expect(response.status).toBe(201);
  return response.body.user.id as string;
}

beforeAll(async () => {
  ctx = await createTestContext({
    signupMode: "invite",
    adminUsernames: [ADMIN_USERNAME],
  });
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.db);
});

describe("signup invites", () => {
  it("exposes the signup mode and requires a code in invite mode", async () => {
    const anonymous = new TestClient(ctx.baseUrl);
    const config = await anonymous.request("GET", "/api/auth/config");
    expect(config.body.signupMode).toBe("invite");

    const missing = await anonymous.register(
      `nobody${randomUUID().slice(0, 6)}`,
      createIdentity(),
    );
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("INVITE_REQUIRED");

    const wrong = await anonymous.register(
      `wrong${randomUUID().slice(0, 6)}`,
      createIdentity(),
      { inviteCode: "ZZZZZZZZZZZZ" },
    );
    expect(wrong.status).toBe(403);
  });

  it("lets an admin issue a code, then consumes it exactly once", async () => {
    const adminClient = new TestClient(ctx.baseUrl);
    const adminId = await bootstrapAdmin(adminClient);

    const invite = await createInvite(adminClient, { maxUses: 1 });
    expect(invite.code).toMatch(/^[A-Z2-9]{12}$/);

    // 코드는 대소문자/구분자를 정규화해 받아들인다.
    const invitee = new TestClient(ctx.baseUrl);
    const created = await invitee.register(
      `invitee${randomUUID().slice(0, 6)}`,
      createIdentity(),
      { inviteCode: invite.code.toLowerCase() },
    );
    expect(created.status).toBe(201);

    const second = await new TestClient(ctx.baseUrl).register(
      `second${randomUUID().slice(0, 6)}`,
      createIdentity(),
      { inviteCode: invite.code },
    );
    expect(second.status).toBe(403);

    const list = await adminClient.request("GET", "/api/admin/signup-invites");
    expect(list.status).toBe(200);
    const listed = (
      list.body.invites as Array<{ code: string; usedCount: number; active: boolean }>
    ).find((entry) => entry.code === invite.code);
    expect(listed?.usedCount).toBe(1);
    expect(listed?.active).toBe(false);

    // 발급은 감사 로그(인증 이벤트)로 남는다.
    const events = await adminClient.request(
      "GET",
      `/api/admin/users/${adminId}/auth-events?limit=10`,
    );
    expect(events.status).toBe(200);
    expect(
      (events.body.events as Array<{ event: string }>).some(
        (event) => event.event === "admin_signup_invite_created",
      ),
    ).toBe(true);
  });

  it("rejects revoked and expired codes", async () => {
    const adminClient = new TestClient(ctx.baseUrl);
    await bootstrapAdmin(adminClient);

    const revoked = await createInvite(adminClient, { maxUses: 5 });
    const revokeResponse = await adminClient.request(
      "DELETE",
      `/api/admin/signup-invites/${revoked.id}`,
    );
    expect(revokeResponse.status).toBe(200);
    expect(
      (
        await new TestClient(ctx.baseUrl).register(
          `rv${randomUUID().slice(0, 6)}`,
          createIdentity(),
          { inviteCode: revoked.code },
        )
      ).status,
    ).toBe(403);

    // 만료: 이미 지난 시각으로 직접 만료 처리한다.
    const expired = await createInvite(adminClient, { maxUses: 5 });
    await ctx.db.execute(
      `update signup_invites set expires_at = now() - interval '1 minute' where code = '${expired.code}'`,
    );
    expect(
      (
        await new TestClient(ctx.baseUrl).register(
          `ex${randomUUID().slice(0, 6)}`,
          createIdentity(),
          { inviteCode: expired.code },
        )
      ).status,
    ).toBe(403);
  });

  it("requires admin rights to issue or list invite codes", async () => {
    const adminClient = new TestClient(ctx.baseUrl);
    await bootstrapAdmin(adminClient);
    const invite = await createInvite(adminClient, { maxUses: 5 });

    const member = new TestClient(ctx.baseUrl);
    const memberRegistration = await member.register(
      `member${randomUUID().slice(0, 6)}`,
      createIdentity(),
      { inviteCode: invite.code },
    );
    expect(memberRegistration.status).toBe(201);

    expect((await member.request("GET", "/api/admin/signup-invites")).status).toBe(403);
    expect(
      (await member.request("POST", "/api/admin/signup-invites", { body: { maxUses: 1 } })).status,
    ).toBe(403);
  });
});

describe("signup closed mode", () => {
  it("blocks registration entirely", async () => {
    const closed = await createTestContext({ signupMode: "closed" });
    try {
      const anonymous = new TestClient(closed.baseUrl);
      const response = await anonymous.register(
        `closed${randomUUID().slice(0, 6)}`,
        createIdentity(),
      );
      expect(response.status).toBe(403);
      const config = await anonymous.request("GET", "/api/auth/config");
      expect(config.body.signupMode).toBe("closed");
    } finally {
      await closed.close();
    }
  });
});

