import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";

import pg from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required for the E2E server");
}

const target = new URL(connectionString);
const databaseName = decodeURIComponent(target.pathname.replace(/^\//, ""));
if (!databaseName) throw new Error("DATABASE_URL must include a database name");
if (!/e2e/i.test(databaseName)) {
  throw new Error(`Refusing to reset non-E2E database: ${databaseName}`);
}

const adminUrl = new URL(connectionString);
adminUrl.pathname = "/postgres";
const admin = new pg.Client({ connectionString: adminUrl.toString() });
await admin.connect();
try {
  const existing = await admin.query("select 1 from pg_database where datname = $1", [
    databaseName,
  ]);
  if (existing.rowCount === 0) {
    const quoted = databaseName.replace(/"/g, '""');
    await admin.query(`create database "${quoted}"`);
  }
} finally {
  await admin.end();
}

console.log(`[e2e] applying migrations to ${databaseName}`);
execFileSync(process.execPath, ["scripts/migrate.mjs"], {
  stdio: "inherit",
  env: process.env,
});

const client = new pg.Client({ connectionString });
await client.connect();
try {
  await client.query(
    "truncate table message_keys, messages, conversation_participants, conversations, sessions, devices, users restart identity cascade",
  );
} finally {
  await client.end();
}

console.log("[e2e] starting server");
const appPort = Number(process.env.PORT ?? 3931);
const appOrigin = `http://127.0.0.1:${appPort}`;

/**
 * Google OAuth 스텁 IdP. 실제 Google 대신 /authorize → 콜백 리다이렉트,
 * /token(PKCE 검증), /userinfo 를 흉내낸다. 실행마다 고유한 Google 계정 하나를 쓴다.
 */
function startStubIdp() {
  const runId = Math.random().toString(36).slice(2, 8);
  const subject = `e2e-google-${runId}`;
  const codes = new Map();
  const tokens = new Map();
  let counter = 0;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const sendJson = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (req.method === "GET" && url.pathname === "/authorize") {
      const state = url.searchParams.get("state") ?? "";
      const challenge = url.searchParams.get("code_challenge") ?? "";
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      if (!state || !challenge || !redirectUri) {
        res.writeHead(400).end("invalid authorize request");
        return;
      }
      const code = `code-${(counter += 1)}`;
      codes.set(code, { challenge });
      const target = new URL(redirectUri);
      target.searchParams.set("code", code);
      target.searchParams.set("state", state);
      res.writeHead(302, { location: target.toString() }).end();
      return;
    }

    if (req.method === "POST" && url.pathname === "/token") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        const code = form.get("code") ?? "";
        const entry = codes.get(code);
        const challenge = createHash("sha256")
          .update(form.get("code_verifier") ?? "")
          .digest("base64url");
        if (
          !entry ||
          form.get("grant_type") !== "authorization_code" ||
          form.get("client_secret") !== "e2e-google-secret" ||
          challenge !== entry.challenge
        ) {
          sendJson(400, { error: "invalid_grant" });
          return;
        }
        codes.delete(code);
        const token = `token-${(counter += 1)}`;
        tokens.set(token, subject);
        sendJson(200, { access_token: token, token_type: "Bearer", expires_in: 3600 });
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/userinfo") {
      const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (!tokens.has(token)) {
        sendJson(401, { error: "invalid_token" });
        return;
      }
      sendJson(200, {
        sub: subject,
        email: `${subject}@example.com`,
        email_verified: true,
      });
      return;
    }

    sendJson(404, { error: "not_found" });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const base = `http://127.0.0.1:${port}`;
      resolve({
        env: {
          GOOGLE_CLIENT_ID: "e2e-google-client",
          GOOGLE_CLIENT_SECRET: "e2e-google-secret",
          GOOGLE_REDIRECT_URL: `${appOrigin}/api/auth/google/callback`,
          APP_ORIGIN: appOrigin,
          GOOGLE_AUTHORIZE_URL: `${base}/authorize`,
          GOOGLE_TOKEN_URL: `${base}/token`,
          GOOGLE_USERINFO_URL: `${base}/userinfo`,
        },
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

const stub = await startStubIdp();
const child = spawn(process.execPath, ["dist/server.js"], {
  stdio: "inherit",
  env: { ...process.env, ...stub.env },
});
child.on("exit", (code) => {
  void stub.close();
  process.exit(code ?? 0);
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
