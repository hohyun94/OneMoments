import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("[backup] DATABASE_URL is required");
  process.exit(1);
}

const target = new URL(connectionString);
const database = decodeURIComponent(target.pathname.replace(/^\//, ""));
const user = decodeURIComponent(target.username);
const password = decodeURIComponent(target.password);
const host = target.hostname;
const port = target.port || "5432";
if (!database || !user) {
  console.error("[backup] DATABASE_URL must include user and database");
  process.exit(1);
}

const container = process.env.BACKUP_DOCKER_CONTAINER;
const outputDir = process.env.BACKUP_DIR ?? "backups";
mkdirSync(outputDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const file = path.join(outputDir, `onemoments-${stamp}.dump`);

const args = ["-Fc", "--no-owner", "--no-privileges", "-U", user, "-d", database];
const command = container
  ? "docker"
  : (process.env.PG_DUMP_BIN ?? "pg_dump");
const commandArgs = container
  ? ["exec", "-e", `PGPASSWORD=${password}`, container, "pg_dump", ...args]
  : ["-h", host, "-p", port, ...args];

console.log(
  `[backup] ${container ? `docker exec ${container}` : command} → ${file}`,
);

const child = spawn(command, commandArgs, {
  env: { ...process.env, PGPASSWORD: password },
  stdio: ["ignore", "pipe", "inherit"],
});
const output = createWriteStream(file);
child.stdout.pipe(output);

child.on("error", (error) => {
  console.error(
    `[backup] failed to start ${command}: ${error.message}\n` +
      "pg_dump 가 없으면 BACKUP_DOCKER_CONTAINER=<postgres 컨테이너> 로 실행하세요.",
  );
  process.exit(1);
});

child.on("close", (code) => {
  output.end();
  if (code !== 0) {
    console.error(`[backup] pg_dump exited with ${code}`);
    process.exit(code ?? 1);
  }
  console.log(`[backup] done: ${file}`);
  console.log(
    `[restore] DATABASE_URL=... RESTORE_CONFIRM=yes node scripts/restore.mjs ${file}`,
  );
});
