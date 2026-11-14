import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) {
  console.error("[db] DATABASE_URL is required");
  process.exit(1);
}
if (!/^postgres(ql)?:\/\//i.test(connectionString)) {
  console.error("[db] DATABASE_URL must start with postgres:// or postgresql://");
  process.exit(1);
}

const sslMode = (process.env.DATABASE_SSL ?? "disable").toLowerCase();
const ssl =
  sslMode === "disable" ? undefined : { rejectUnauthorized: sslMode === "verify-full" };
const redacted = connectionString.replace(/\/\/[^@/]*@/, "//***@");
console.log(`[db] applying migrations to ${redacted} (ssl=${sslMode})`);

const pool = new pg.Pool({ connectionString, ssl, max: 1 });
try {
  const db = drizzle(pool);
  await migrate(db, {
    migrationsFolder: "drizzle/postgres-migrations",
    migrationsTable: "__onemoments_migrations",
  });
  console.log("[db] migrations applied successfully");
} finally {
  await pool.end();
}
