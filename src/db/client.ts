import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import type { Config } from "../config.js";
import * as schema from "./schema.js";

export type DatabaseConfig = Pick<
  Config,
  "databaseUrl" | "databaseSsl" | "dbPoolMax"
>;

export function createDb(config: DatabaseConfig) {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: config.dbPoolMax,
    ssl:
      config.databaseSsl === "disable"
        ? undefined
        : { rejectUnauthorized: config.databaseSsl === "verify-full" },
  });

  const db = drizzle(pool, { schema });
  return { db, pool };
}

export type Database = ReturnType<typeof createDb>["db"];
export type DatabasePool = ReturnType<typeof createDb>["pool"];
