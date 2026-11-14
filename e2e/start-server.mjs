import { execFileSync, spawn } from "node:child_process";

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
const child = spawn(process.execPath, ["dist/server.js"], {
  stdio: "inherit",
  env: process.env,
});
child.on("exit", (code) => process.exit(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
