import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: RESTORE_CONFIRM=yes node scripts/restore.mjs <dump-file>");
  process.exit(1);
}
if (process.env.RESTORE_CONFIRM !== "yes") {
  console.error(
    "[restore] destructive operation. Re-run with RESTORE_CONFIRM=yes and a non-production DATABASE_URL.",
  );
  process.exit(1);
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("[restore] DATABASE_URL is required");
  process.exit(1);
}

const target = new URL(connectionString);
const database = decodeURIComponent(target.pathname.replace(/^\//, ""));
const user = decodeURIComponent(target.username);
const password = decodeURIComponent(target.password);
const host = target.hostname;
const port = target.port || "5432";
if (!database || !user) {
  console.error("[restore] DATABASE_URL must include user and database");
  process.exit(1);
}

const container = process.env.BACKUP_DOCKER_CONTAINER;
const restoreArgs = [
  "--clean",
  "--if-exists",
  "--no-owner",
  "--no-privileges",
  "-U",
  user,
  "-d",
  database,
];

const command = container ? "docker" : (process.env.PG_RESTORE_BIN ?? "pg_restore");
const args = container
  ? ["exec", "-i", "-e", `PGPASSWORD=${password}`, container, "pg_restore", ...restoreArgs]
  : ["-h", host, "-p", port, ...restoreArgs, file];

console.log(
  `[restore] ${container ? `docker exec ${container}` : command} → ${database}`,
);

const child = spawn(command, args, {
  env: { ...process.env, PGPASSWORD: password },
  stdio: [container ? "pipe" : "ignore", "inherit", "inherit"],
});

if (container) {
  createReadStream(file).pipe(child.stdin);
}

child.on("error", (error) => {
  console.error(
    `[restore] failed to start ${command}: ${error.message}\n` +
      "pg_restore 가 없으면 BACKUP_DOCKER_CONTAINER=<postgres 컨테이너> 로 실행하세요.",
  );
  process.exit(1);
});

child.on("close", (code) => {
  if (code !== 0) {
    console.error(`[restore] pg_restore exited with ${code}`);
    process.exit(code ?? 1);
  }
  console.log("[restore] done");
});
