import cookieParser from "cookie-parser";
import { sql } from "drizzle-orm";
import express, { type Express, type RequestHandler } from "express";

import type { Config } from "./config.js";
import type { Database } from "./db/client.js";
import { asyncHandler, errorHandler, notFoundHandler } from "./http/errors.js";
import { originGuard } from "./http/middleware.js";
import type { MessageBus } from "./realtime/bus.js";
import { createAuthRouter } from "./routes/auth.js";
import { createConversationsRouter } from "./routes/conversations.js";
import { createDevicesRouter, createUsersRouter } from "./routes/devices.js";

export interface AppOptions {
  db: Database;
  config: Config;
  bus: MessageBus;
}

function corsMiddleware(origins: string[]): RequestHandler {
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && origins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, X-CSRF-Token",
      );
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Access-Control-Max-Age", "600");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
}

export function createApp(options: AppOptions): Express {
  const { db, config, bus } = options;
  const app = express();
  app.disable("x-powered-by");
  if (config.trustProxy > 0) app.set("trust proxy", config.trustProxy);

  const bodyLimitKb = Math.ceil((config.maxCiphertextBytes * 2) / 1024) + 128;
  app.use(express.json({ limit: `${bodyLimitKb}kb` }));
  app.use(cookieParser());
  app.use(corsMiddleware(config.corsOrigins));
  app.use(originGuard(config));
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Frame-Options", "DENY");
    next();
  });

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", service: "onemoments" });
  });

  app.get(
    "/readyz",
    asyncHandler(async (_req, res) => {
      await db.execute(sql`select 1`);
      res.json({ status: "ready" });
    }),
  );

  app.use("/api/auth", createAuthRouter(db, config));
  app.use("/api/devices", createDevicesRouter(db, config));
  app.use("/api/users", createUsersRouter(db, config));
  app.use("/api/conversations", createConversationsRouter({ db, config, bus }));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
