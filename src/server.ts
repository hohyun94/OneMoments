import { createServer } from "node:http";

import { lt } from "drizzle-orm";

import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { sessions } from "./db/schema.js";
import { createMessageBus } from "./realtime/bus.js";
import { createRealtime } from "./realtime/ws.js";
import { deleteExpiredRecoveryChallenges } from "./services/keyBackup.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const { db, pool } = createDb(config);
  const bus = await createMessageBus(config);

  const app = createApp({ db, config, bus });
  const server = createServer(app);
  const realtime = createRealtime({ server, db, config, bus });

  // 만료 세션 정리(1시간마다). 실패해도 서버 동작에는 영향이 없다.
  const sessionCleanup = setInterval(() => {
    void db
      .delete(sessions)
      .where(lt(sessions.expiresAt, new Date()))
      .catch(() => undefined);
    void deleteExpiredRecoveryChallenges(db).catch(() => undefined);
  }, 60 * 60 * 1000);
  sessionCleanup.unref();

  server.listen(config.port, () => {
    console.log(
      JSON.stringify({
        level: "info",
        event: "server_started",
        service: "onemoments",
        port: config.port,
        nodeEnv: config.nodeEnv,
        redis: Boolean(config.redisUrl),
      }),
    );
  });

  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ level: "info", event: "shutdown_started", signal }));

    const forceExit = setTimeout(() => {
      console.error(JSON.stringify({ level: "error", event: "shutdown_timeout" }));
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    try {
      clearInterval(sessionCleanup);
      await realtime.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await bus.close();
      await pool.end();
      process.exit(0);
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "shutdown_failed",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      process.exit(1);
    }
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      level: "error",
      event: "startup_failed",
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exit(1);
});
