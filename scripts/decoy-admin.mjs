import { randomBytes } from "node:crypto";

import { eq } from "drizzle-orm";

import { hashPassword, verifyPassword } from "../dist/auth/password.js";
import { loadConfig } from "../dist/config.js";
import { createDb } from "../dist/db/client.js";
import { loginProfiles, users } from "../dist/db/schema.js";

function arg(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function normalizeAlias(value) {
  return value.trim().toLowerCase();
}

function validUsername(value) {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{2,31}$/.test(value);
}

const command = process.argv[2];
const alias = normalizeAlias(arg("alias", ""));
const password = process.env.DECOY_PASSWORD;

if (!alias || !["create", "rotate", "disable", "enable"].includes(command)) {
  console.error(
    "usage: DECOY_PASSWORD=... node scripts/decoy-admin.mjs <create|rotate|disable|enable> --alias <real-username> [--handle <decoy-username>]",
  );
  process.exit(1);
}
if ((command === "create" || command === "rotate") && (!password || password.length < 10)) {
  console.error("DECOY_PASSWORD must be at least 10 characters");
  process.exit(1);
}

const config = loadConfig();
const { db, pool } = createDb(config);

try {
  const [real] = await db
    .select()
    .from(users)
    .where(eq(users.username, alias))
    .limit(1);
  if (!real || real.deletedAt !== null) {
    throw new Error(`Real account not found: ${alias}`);
  }

  const [existing] = await db
    .select()
    .from(loginProfiles)
    .where(eq(loginProfiles.alias, alias))
    .limit(1);

  if (command === "create") {
    if (existing) throw new Error(`Decoy profile already exists for ${alias}`);
    if (await verifyPassword(password, real.passwordHash)) {
      throw new Error("Decoy password must differ from the real password");
    }

    let handle = arg("handle");
    if (!handle) handle = `decoy_${randomBytes(4).toString("hex")}`;
    handle = normalizeAlias(handle);
    if (!validUsername(handle)) throw new Error("Invalid --handle");

    const [handleOwner] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, handle))
      .limit(1);
    if (handleOwner) throw new Error(`Username already exists: ${handle}`);

    const passwordHash = await hashPassword(password);
    const randomPasswordHash = await hashPassword(randomBytes(32).toString("base64url"));
    const result = await db.transaction(async (tx) => {
      const [decoyUser] = await tx
        .insert(users)
        .values({ username: handle, passwordHash: randomPasswordHash })
        .returning();
      if (!decoyUser) throw new Error("Failed to create decoy user");
      const [profile] = await tx
        .insert(loginProfiles)
        .values({
          alias,
          userId: decoyUser.id,
          passwordHash,
          kind: "decoy",
        })
        .returning();
      if (!profile) throw new Error("Failed to create decoy profile");
      return { decoyUser, profile };
    });
    console.log(
      JSON.stringify({
        ok: true,
        command,
        alias,
        decoyUserId: result.decoyUser.id,
        decoyUsername: result.decoyUser.username,
      }),
    );
  } else if (command === "rotate") {
    if (!existing) throw new Error(`Decoy profile not found for ${alias}`);
    if (await verifyPassword(password, real.passwordHash)) {
      throw new Error("Decoy password must differ from the real password");
    }
    await db
      .update(loginProfiles)
      .set({ passwordHash: await hashPassword(password), disabledAt: null })
      .where(eq(loginProfiles.id, existing.id));
    console.log(JSON.stringify({ ok: true, command, alias }));
  } else if (command === "disable") {
    if (!existing) throw new Error(`Decoy profile not found for ${alias}`);
    await db
      .update(loginProfiles)
      .set({ disabledAt: new Date() })
      .where(eq(loginProfiles.id, existing.id));
    console.log(JSON.stringify({ ok: true, command, alias }));
  } else if (command === "enable") {
    if (!existing) throw new Error(`Decoy profile not found for ${alias}`);
    await db
      .update(loginProfiles)
      .set({ disabledAt: null })
      .where(eq(loginProfiles.id, existing.id));
    console.log(JSON.stringify({ ok: true, command, alias }));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await pool.end();
}
