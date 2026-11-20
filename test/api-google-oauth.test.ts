import { createHash } from "node:crypto";
import { createServer } from "node:http";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { users, oauthStates, oauthTickets } from "../src/db/schema.js";
import { createTestContext, resetDatabase, type TestContext } from "./support/context.js";
import { createIdentity, type Identity } from "./support/crypto.js";
import { TestClient } from "./support/http.js";

interface StubProfile {
  subject: string;
  email: string;
  emailVerified: boolean;
}

interface StubIdp {
  baseUrl: string;
  issueCode(input: { challenge: string; profile: StubProfile }): string;
  close(): Promise<void>;
}

/** 실제 Google 대신 토큰 교환·userinfo 만 흉내내는 스텁 IdP. */
async function startStubIdp(): Promise<StubIdp> {
  const codes = new Map<string, { challenge: string; profile: StubProfile }>();
  const tokens = new Map<string, StubProfile>();
  let counter = 0;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (req.method === "POST" && url.pathname === "/token") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        const code = form.get("code") ?? "";
        const entry = codes.get(code);
        const verifier = form.get("code_verifier") ?? "";
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        if (
          !entry ||
          form.get("grant_type") !== "authorization_code" ||
          form.get("client_secret") !== "test-google-secret" ||
          challenge !== entry.challenge
        ) {
          send(400, { error: "invalid_grant" });
          return;
        }
        codes.delete(code);
        const token = `token-${(counter += 1)}`;
        tokens.set(token, entry.profile);
        send(200, { access_token: token, token_type: "Bearer", expires_in: 3600 });
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/userinfo") {
      const profile = tokens.get((req.headers.authorization ?? "").replace(/^Bearer /, ""));
      if (!profile) {
        send(401, { error: "invalid_token" });
        return;
      }
      send(200, {
        sub: profile.subject,
        email: profile.email,
        email_verified: profile.emailVerified,
      });
      return;
    }

    send(404, { error: "not_found" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    issueCode({ challenge, profile }) {
      const code = `code-${(counter += 1)}`;
      codes.set(code, { challenge, profile });
      return code;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let ctx: TestContext;
let idp: StubIdp;

beforeAll(async () => {
  idp = await startStubIdp();
  ctx = await createTestContext({
    googleOAuth: {
      authorizeUrl: `${idp.baseUrl}/authorize`,
      tokenUrl: `${idp.baseUrl}/token`,
      userInfoUrl: `${idp.baseUrl}/userinfo`,
      clientId: "test-google-client",
      clientSecret: "test-google-secret",
    },
  });
});

afterAll(async () => {
  await ctx.close();
  await idp.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.db);
});

function newDevice(): { identity: Identity; device: Record<string, string> } {
  const identity = createIdentity();
  return {
    identity,
    device: {
      name: "google-device",
      identityPublicKey: identity.identity.publicKeyBase64,
      signingPublicKey: identity.signing.publicKeyBase64,
    },
  };
}

async function beginOAuth(
  client: TestClient,
  intent: "signup" | "login",
): Promise<{ state: string; challenge: string; url: URL }> {
  const response = await client.request("POST", "/api/auth/google/start", {
    body: { intent },
    csrf: false,
  });
  expect(response.status).toBe(200);
  const url = new URL(response.body.authorizationUrl as string);
  return {
    state: url.searchParams.get("state") ?? "",
    challenge: url.searchParams.get("code_challenge") ?? "",
    url,
  };
}

async function hitCallback(
  client: TestClient,
  input: { state: string; code: string },
): Promise<{ ticket: string | null; error: string | null; location: URL | null }> {
  const query = `code=${encodeURIComponent(input.code)}&state=${encodeURIComponent(input.state)}`;
  const response = await fetch(`${ctx.baseUrl}/api/auth/google/callback?${query}`, {
    headers: { cookie: client.cookieHeader() },
    redirect: "manual",
  });
  expect(response.status).toBe(302);
  const location = response.headers.get("location");
  const target = location ? new URL(location) : null;
  return {
    ticket: target?.searchParams.get("oauth_ticket") ?? null,
    error: target?.searchParams.get("oauth_error") ?? null,
    location: target,
  };
}

/** 가입 시작 → 콜백 → 완료까지 한 번에 수행한다. */
async function signupWithGoogle(
  client: TestClient,
  input: { subject: string; username: string; emailVerified?: boolean },
) {
  const started = await beginOAuth(client, "signup");
  const code = idp.issueCode({
    challenge: started.challenge,
    profile: {
      subject: input.subject,
      email: `${input.subject}@example.com`,
      emailVerified: input.emailVerified ?? true,
    },
  });
  const callback = await hitCallback(client, { state: started.state, code });
  expect(callback.error).toBeNull();
  expect(callback.ticket).toBeTruthy();
  const batch = newDevice();
  const completed = await client.request("POST", "/api/auth/google/complete", {
    body: { ticket: callback.ticket, username: input.username, device: batch.device },
    csrf: false,
  });
  return { completed, ticket: callback.ticket, ...batch };
}

describe("google oauth", () => {
  it("creates a password-less account and signs the browser in", async () => {
    const client = new TestClient(ctx.baseUrl);
    const { completed, identity } = await signupWithGoogle(client, {
      subject: "google-sub-1",
      username: "oauthuser",
    });

    expect(completed.status).toBe(201);
    expect(completed.body.user.username).toBe("oauthuser");
    expect(completed.body.hasPassword).toBe(false);
    expect(completed.body.googleLinked).toBe(true);
    expect(typeof completed.body.csrfToken).toBe("string");
    expect(client.cookies.get("om_session")).toBeTruthy();

    const me = await client.request("GET", "/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.googleLinked).toBe(true);
    expect(me.body.hasPassword).toBe(false);
    expect(me.body.oauthEnabled).toBe(true);
    expect(me.body.devices[0].identityPublicKey).toBe(identity.identity.publicKeyBase64);

    const [row] = await ctx.db
      .select()
      .from(users)
      .where(eq(users.username, "oauthuser"))
      .limit(1);
    expect(row?.oauthProvider).toBe("google");
    expect(row?.oauthSubject).toBe("google-sub-1");
    expect(row?.passwordHash).toBeNull();

    // 티켓은 1회용이므로 소비 후 행이 남지 않는다.
    const tickets = await ctx.db.select().from(oauthTickets);
    expect(tickets).toHaveLength(0);
  });
  it("signs in an already linked account with a new device", async () => {
    const first = new TestClient(ctx.baseUrl);
    await signupWithGoogle(first, { subject: "google-sub-2", username: "linkeduser" });

    const second = new TestClient(ctx.baseUrl);
    const started = await beginOAuth(second, "login");
    const code = idp.issueCode({
      challenge: started.challenge,
      profile: { subject: "google-sub-2", email: "linked@example.com", emailVerified: true },
    });
    const callback = await hitCallback(second, { state: started.state, code });
    expect(callback.error).toBeNull();

    const batch = newDevice();
    const completed = await second.request("POST", "/api/auth/google/complete", {
      body: { ticket: callback.ticket, device: batch.device },
      csrf: false,
    });
    expect(completed.status).toBe(200);
    expect(completed.body.user.username).toBe("linkeduser");
    expect(completed.body.device.id).not.toBe(undefined);

    const me = await second.request("GET", "/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.devices).toHaveLength(2);
  });

  it("refuses a login when the Google account is not linked", async () => {
    const client = new TestClient(ctx.baseUrl);
    const started = await beginOAuth(client, "login");
    const code = idp.issueCode({
      challenge: started.challenge,
      profile: { subject: "unknown-sub", email: "nobody@example.com", emailVerified: true },
    });
    const callback = await hitCallback(client, { state: started.state, code });
    expect(callback.ticket).toBeNull();
    expect(callback.error).toBe("not_linked");
  });

  it("refuses a signup when the Google account is already linked", async () => {
    const first = new TestClient(ctx.baseUrl);
    await signupWithGoogle(first, { subject: "google-sub-3", username: "takenlink" });

    const second = new TestClient(ctx.baseUrl);
    const started = await beginOAuth(second, "signup");
    const code = idp.issueCode({
      challenge: started.challenge,
      profile: { subject: "google-sub-3", email: "taken@example.com", emailVerified: true },
    });
    const callback = await hitCallback(second, { state: started.state, code });
    expect(callback.error).toBe("already_linked");
    expect(callback.ticket).toBeNull();
  });

  it("rejects a callback whose state does not match the browser cookie", async () => {
    const client = new TestClient(ctx.baseUrl);
    const started = await beginOAuth(client, "signup");
    const code = idp.issueCode({
      challenge: started.challenge,
      profile: { subject: "google-sub-4", email: "state@example.com", emailVerified: true },
    });

    const cookie = client.cookies.get("om_oauth_state");
    client.cookies.delete("om_oauth_state");
    const withoutCookie = await hitCallback(client, { state: started.state, code });
    expect(withoutCookie.error).toBe("state_mismatch");

    client.cookies.set("om_oauth_state", `${cookie}-tampered`);
    const tampered = await hitCallback(client, { state: started.state, code });
    expect(tampered.error).toBe("state_mismatch");
  });

  it("rejects an expired state", async () => {
    const client = new TestClient(ctx.baseUrl);
    const started = await beginOAuth(client, "signup");
    // 방금 만든 state 를 만료 상태로 바꾼다.
    await ctx.db
      .update(oauthStates)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(oauthStates.stateHash, createHash("sha256").update(started.state).digest("hex")));

    const code = idp.issueCode({
      challenge: started.challenge,
      profile: { subject: "google-sub-5", email: "expired@example.com", emailVerified: true },
    });
    const callback = await hitCallback(client, { state: started.state, code });
    expect(callback.error).toBe("state_expired");
  });

  it("rejects an unverified Google email", async () => {
    const client = new TestClient(ctx.baseUrl);
    const started = await beginOAuth(client, "signup");
    const code = idp.issueCode({
      challenge: started.challenge,
      profile: { subject: "google-sub-6", email: "unverified@example.com", emailVerified: false },
    });
    const callback = await hitCallback(client, { state: started.state, code });
    expect(callback.error).toBe("email_unverified");
  });

  it("rejects a code exchange with a mismatched PKCE verifier", async () => {
    const client = new TestClient(ctx.baseUrl);
    const started = await beginOAuth(client, "signup");
    // 일부러 다른 challenge 로 코드를 발급한다.
    const code = idp.issueCode({
      challenge: "wrong-challenge",
      profile: { subject: "google-sub-7", email: "pkce@example.com", emailVerified: true },
    });
    const callback = await hitCallback(client, { state: started.state, code });
    expect(callback.error).toBe("provider_error");
  });


  it("links Google to an existing password account and unlinks with the password", async () => {
    const client = new TestClient(ctx.baseUrl);
    expect((await client.register("linkuser", createIdentity())).status).toBe(201);

    // 세션 없는 연결 시작은 거부한다.
    const anonymous = await new TestClient(ctx.baseUrl).request(
      "POST",
      "/api/auth/google/start/link",
      { body: {}, csrf: false },
    );
    expect(anonymous.status).toBe(401);

    const started = await client.request("POST", "/api/auth/google/start/link", { body: {} });
    expect(started.status).toBe(200);
    const url = new URL(started.body.authorizationUrl as string);
    const code = idp.issueCode({
      challenge: url.searchParams.get("code_challenge") ?? "",
      profile: { subject: "google-sub-link", email: "link@example.com", emailVerified: true },
    });
    const callback = await hitCallback(client, {
      state: url.searchParams.get("state") ?? "",
      code,
    });
    expect(callback.error).toBeNull();

    const linked = await client.request("POST", "/api/auth/google/complete/link", {
      body: { ticket: callback.ticket },
    });
    expect(linked.status).toBe(200);
    expect(linked.body.googleLinked).toBe(true);
    expect(linked.body.hasPassword).toBe(true);

    const wrong = await client.request("POST", "/api/auth/google/unlink", {
      body: { password: "wrong-password-123" },
    });
    expect(wrong.status).toBe(401);

    const unlinked = await client.request("POST", "/api/auth/google/unlink", {
      body: { password: "password-12345" },
    });
    expect(unlinked.status).toBe(200);
    expect(unlinked.body.googleLinked).toBe(false);
  });

  it("keeps OAuth-only accounts out of password login", async () => {
    const client = new TestClient(ctx.baseUrl);
    await signupWithGoogle(client, { subject: "google-sub-8", username: "nopassword" });

    const attempt = await new TestClient(ctx.baseUrl).request("POST", "/api/auth/login", {
      body: { username: "nopassword", password: "password-12345", device: newDevice().device },
      csrf: false,
    });
    expect(attempt.status).toBe(401);
    expect(attempt.body.error.code).toBe("UNAUTHORIZED");
  });

  it("treats the completion ticket as single use", async () => {
    const client = new TestClient(ctx.baseUrl);
    const { ticket } = await signupWithGoogle(client, {
      subject: "google-sub-9",
      username: "ticketuser",
    });

    const replay = await new TestClient(ctx.baseUrl).request(
      "POST",
      "/api/auth/google/complete",
      { body: { ticket, username: "ticketuser2", device: newDevice().device }, csrf: false },
    );
    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe("OAUTH_TICKET_INVALID");
  });

  it("rejects a link ticket issued for another user", async () => {
    const owner = new TestClient(ctx.baseUrl);
    expect((await owner.register("owneruser", createIdentity())).status).toBe(201);
    const started = await owner.request("POST", "/api/auth/google/start/link", { body: {} });
    const url = new URL(started.body.authorizationUrl as string);
    const code = idp.issueCode({
      challenge: url.searchParams.get("code_challenge") ?? "",
      profile: { subject: "google-sub-owner", email: "owner@example.com", emailVerified: true },
    });
    const callback = await hitCallback(owner, {
      state: url.searchParams.get("state") ?? "",
      code,
    });
    expect(callback.error).toBeNull();

    const intruder = new TestClient(ctx.baseUrl);
    expect((await intruder.register("intruderuser", createIdentity())).status).toBe(201);
    const attempt = await intruder.request("POST", "/api/auth/google/complete/link", {
      body: { ticket: callback.ticket },
    });
    expect(attempt.status).toBe(400);
    expect(attempt.body.error.code).toBe("OAUTH_TICKET_INVALID");
  });

  it("deletes an OAuth-only account after confirming the username", async () => {
    const client = new TestClient(ctx.baseUrl);
    await signupWithGoogle(client, { subject: "google-sub-10", username: "deleteuser" });

    const missing = await client.request("DELETE", "/api/auth/account", {
      body: { confirmUsername: "someone-else" },
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("CONFIRM_REQUIRED");

    const deleted = await client.request("DELETE", "/api/auth/account", {
      body: { confirmUsername: "deleteuser" },
    });
    expect([200, 204]).toContain(deleted.status);
    expect((await client.request("GET", "/api/auth/me")).status).toBe(401);

    // 삭제 시 연결을 해제하므로 같은 Google 계정으로 다시 가입할 수 있다.
    const again = new TestClient(ctx.baseUrl);
    const retry = await signupWithGoogle(again, {
      subject: "google-sub-10",
      username: "deleteuser2",
    });
    expect(retry.completed.status).toBe(201);
  });
});

