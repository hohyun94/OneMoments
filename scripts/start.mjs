import { execFileSync } from "node:child_process";

const migrateOnStart = (process.env.MIGRATE_ON_START ?? "true").toLowerCase() !== "false";

if (migrateOnStart) {
  console.log("[start] applying database migrations");
  execFileSync(process.execPath, ["scripts/migrate.mjs"], {
    stdio: "inherit",
    env: process.env,
  });
} else {
  console.log("[start] MIGRATE_ON_START=false — skipping migrations");
}

await import("../dist/server.js");
