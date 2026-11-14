import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import cookieParser from "cookie-parser";
import { sql } from "drizzle-orm";
import express, { type Express, type RequestHandler } from "express";

import type { Config } from "./config.js";
import type { Database } from "./db/client.js";
import { AppError, asyncHandler, errorHandler, notFoundHandler } from "./http/errors.js";
import { renderMetrics } from "./metrics.js";
import { originGuard } from "./http/middleware.js";
import type { MessageBus } from "./realtime/bus.js";
import { createAuthRouter } from "./routes/auth.js";
import { createAttachmentsRouter } from "./routes/attachments.js";
import { createConversationsRouter } from "./routes/conversations.js";
import { createDevicesRouter, createUsersRouter } from "./routes/devices.js";
import { createPushRouter } from "./routes/push.js";
import { createInvitesRouter } from "./routes/invites.js";

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
        "Content-Type, X-CSRF-Token, X-Attachment-Client-Message-Id",
      );
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
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
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self' data:",
        "connect-src 'self' ws: wss:",
        "base-uri 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
      ].join("; "),
    );
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

  app.get(
    "/metrics",
    asyncHandler(async (req, res) => {
      if (config.metricsToken) {
        const header = req.headers.authorization;
        if (header !== `Bearer ${config.metricsToken}`) {
          throw AppError.unauthorized();
        }
      }
      let dbReady = true;
      try {
        await db.execute(sql`select 1`);
      } catch {
        dbReady = false;
      }
      res.type("text/plain; version=0.0.4").send(renderMetrics(dbReady));
    }),
  );

  app.use("/api/auth", createAuthRouter(db, config));
  app.use("/api/devices", createDevicesRouter(db, config));
  app.use("/api/users", createUsersRouter(db, config));
  app.use("/api/push", createPushRouter(db, config));
  app.use("/api/invites", createInvitesRouter({ db, config }));
  app.use("/api/attachments", createAttachmentsRouter(db, config));
  app.use("/api/conversations", createConversationsRouter({ db, config, bus }));

  // 프로덕션: 클라이언트 빌드(dist)를 같은 서버에서 서빙한다.
  const clientDist =
    process.env.CLIENT_DIST_PATH ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../client/dist");
  if (existsSync(path.join(clientDist, "index.html"))) {
    app.use(express.static(clientDist, { index: false, maxAge: "1h" }));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api/") || req.path === "/ws") {
        next();
        return;
      }
      res.sendFile(path.join(clientDist, "index.html"));
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
