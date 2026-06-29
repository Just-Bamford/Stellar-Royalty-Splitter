// dotenv is optional - load .env file if needed
// import "dotenv/config";

import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import logger from "./logger.js";
import { correlationMiddleware } from "./correlation.js";
import { auditExportRouter } from "./routes/audit-export.js";
import { recordHttpRequest } from "./metrics.js";
import { resolveCorsOrigin } from "./cors-config.js";
import { initializeRouter } from "./routes/initialize.js";
import { distributeRouter } from "./routes/distribute.js";
import { collaboratorsRouter } from "./routes/collaborators.js";
import { secondaryRoyaltyRouter } from "./routes/secondary-royalty.js";
import { simulateRouter } from "./routes/simulate.js";
import historyRouter from "./routes/history.js";
import webhooksRouter from "./routes/webhooks.js";
import { analyticsRouter } from "./routes/analytics.js";
import { contractRouter } from "./routes/contract.js";
import { healthRouter } from "./routes/health.js";
import { closeDatabase, initializeDatabase, verifyAuditLogOnStartup } from "./database/index.js";
import { createGracefulShutdownHandler } from "./shutdown.js";
import { adminRouter } from "./routes/admin.js";
import { metricsRouter } from "./routes/metrics.js";
import { initializeSigningKey } from "./signing-key.js";
import { sendError } from "./error-response.js";
import { verifyRequestSignatureMiddleware } from "./request-signing.js";
import { apiKeyRateLimiter } from "./api-key-rate-limit.js";
import { createLegacyApiRedirectMiddleware } from "./legacy-api-redirect.js";

// #399: Cache and event listener imports
import { getCacheManager } from "./cache.js";
import { AdminEventListener } from "./events/adminEventListener.js";
import { getConfiguredContractId } from "./stellar.js";

// Initialize database on startup
initializeDatabase();
initializeSigningKey();

// Issue #395: Verify audit log integrity on startup
verifyAuditLogOnStartup();

const app = express();

// #396: Correlation ID — must be first so every subsequent middleware has req.correlationId
app.use(correlationMiddleware);

// #396: Request / response logging with correlation ID and timing
app.use((req, res, next) => {
  const start = Date.now();
  const requestBytes = parseInt(req.headers["content-length"] ?? "0", 10) || 0;

  res.on("finish", () => {
    const durationMs = Date.now() - start;
    const responseBytes = parseInt(res.getHeader("content-length") ?? "0", 10) || 0;

    logger.info("HTTP request completed", {
      correlationId: req.correlationId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs,
      requestBytes,
      responseBytes,
    });

    recordHttpRequest(req.method, req.originalUrl, res.statusCode, durationMs, {
      requestBytes,
      responseBytes,
    });
  });
  next();
});

// Guard raw legacy /api request targets before any route can see them so
// traversal attempts like /api/%2e%2e/admin are rejected instead of
// normalizing into a different protected path.
app.use(createLegacyApiRedirectMiddleware({ logger }));

// Security headers. #499: set an explicit Content-Security-Policy so a reflected
// or stored payload cannot execute inline scripts even if it reaches the DOM.
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  })
);

const corsPreflightMaxAge = parseInt(process.env.CORS_PREFLIGHT_MAX_AGE ?? "86400", 10);

// #276: env-driven CORS origin. resolveCorsOrigin validates the value
// (rejects malformed URLs, rejects '*' in production), and refuses to
// start when FRONTEND_ORIGIN is unset in production so a misconfigured
// deployment can never silently open the policy to all origins.
const corsOrigin = resolveCorsOrigin();
logger.info("CORS origin configured", { origin: corsOrigin });
app.use(
  cors({
    origin: corsOrigin,
    methods: ["GET", "POST", "DELETE"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Idempotency-Key",
      "X-Wallet-Address",
      "X-Timestamp",
      "X-Nonce",
      "X-Signature",
      "X-API-Key",
    ],
    exposedHeaders: [
      "X-RateLimit-Limit",
      "X-RateLimit-Remaining",
      "X-RateLimit-Reset",
      "X-Export-Signature",
      "X-Export-Public-Key",
    ],
    maxAge: Number.isNaN(corsPreflightMaxAge) ? 86400 : corsPreflightMaxAge,
  })
);

// General rate limiter: 100 req / 15 min per IP (skips /api/health)
const generalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? "900000"),
  max: parseInt(process.env.RATE_LIMIT_MAX ?? "100"),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) =>
    sendError(res, 429, "too_many_requests", "Too many requests, please try again later."),
  skip: (req) => req.path === "/api/v1/health" || req.path === "/api/health",
});

// Write limiter: 10 req / 1 min per IP
const writeLimiter = rateLimit({
  windowMs: 60_000,
  max: parseInt(process.env.RATE_LIMIT_WRITE_MAX ?? "10"),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) =>
    sendError(res, 429, "too_many_requests", "Too many write requests, please slow down."),
});

// Read limiter for history/analytics: 30 req / 1 min per IP (issue #394)
const readAnalyticsLimiter = rateLimit({
  windowMs: 60_000,
  max: parseInt(process.env.RATE_LIMIT_ANALYTICS_MAX ?? "30"),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) =>
    sendError(
      res,
      429,
      "too_many_requests",
      "Too many analytics/history requests, please slow down."
    ),
});

app.use(generalLimiter);

// Per-API-key sliding window rate limiting (#420) — independent of the
// per-IP limiters above. No-op when X-API-Key is absent.
app.use(apiKeyRateLimiter);

app.use(express.json({ limit: "10kb" }));

// Ed25519 request signature verification for write operations (#392)
app.use((req, res, next) => {
  if (req.path.startsWith("/admin")) return next();
  if (["POST", "PUT", "DELETE"].includes(req.method)) {
    return verifyRequestSignatureMiddleware(req, res, next);
  }
  next();
});

// Enforce Content-Type: application/json on POST requests
app.use((req, res, next) => {
  if (req.method === "POST" && !req.is("application/json")) {
    return sendError(res, 415, "unsupported_media_type", "Content-Type must be application/json");
  }
  next();
});

// Per-request timeout middleware
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS ?? "30000");
app.use((req, res, next) => {
  const timer = setTimeout(() => {
    if (!res.headersSent) {
      sendError(res, 503, "request_timeout", "Request timed out. Please try again later.");
    }
  }, REQUEST_TIMEOUT_MS);
  res.on("finish", () => clearTimeout(timer));
  res.on("close", () => clearTimeout(timer));
  next();
});

// Apply write limiter to mutating endpoints
app.use("/api/v1/initialize", writeLimiter);
app.use("/api/v1/distribute", writeLimiter);
app.use("/api/v1/secondary-royalty", writeLimiter);
app.use("/api/v1/webhooks", writeLimiter);

// Per-endpoint rate limits for read-heavy analytics/history routes (#394)
app.use("/api/v1/history", readAnalyticsLimiter);
app.use("/api/v1/audit", readAnalyticsLimiter);
app.use("/api/v1/analytics", readAnalyticsLimiter);

app.use("/api/v1/initialize", initializeRouter);
app.use("/api/v1/distribute", distributeRouter);
app.use("/api/v1/collaborators", collaboratorsRouter);
app.use("/api/v1/secondary-royalty", secondaryRoyaltyRouter);
app.use("/api/v1/simulate", simulateRouter);
app.use("/api/v1", historyRouter);
app.use("/api/v1", webhooksRouter);
app.use("/api/v1", analyticsRouter);
app.use("/api/v1/contract", contractRouter);
app.use("/api/v1/health", healthRouter);
app.use("/api/v1/admin", auditExportRouter);
app.use("/metrics", metricsRouter);
app.use("/api/v1/metrics", metricsRouter);

// Admin operations (separate from /api/v1; protected by ADMIN_ROTATE_TOKEN)
const adminLimiter = rateLimit({
  windowMs: 60_000,
  max: parseInt(process.env.RATE_LIMIT_ADMIN_MAX ?? "5"),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) =>
    sendError(res, 429, "too_many_requests", "Too many admin requests, please slow down."),
});
app.use("/admin", adminLimiter);
app.use("/admin", adminRouter);

// Central error handler
app.use((err, req, res, _next) => {
  if (err.type === "entity.too.large") {
    return sendError(res, 413, "payload_too_large", "Payload too large");
  }
  logger.error("Unhandled error", {
    correlationId: req.correlationId,
    error: err.message ?? String(err),
    stack: err.stack,
  });

  // Structured errors thrown by stellar.js (Soroban / RPC errors)
  if (err.status && err.code) {
    return sendError(res, err.status, err.code, err.message ?? "Error", {
      detail: err.detail,
    });
  }

  if (err.status) {
    return sendError(res, err.status, undefined, err.message ?? "Error");
  }

  return sendError(res, 500, "internal_server_error", err.message ?? "Internal server error");
});

const PORT = process.env.PORT ?? 3001;
const server = app.listen(PORT, () => logger.info(`API listening on http://localhost:${PORT}`));

// Prevent hung connections from exhausting the connection pool
server.keepAliveTimeout = parseInt(process.env.KEEP_ALIVE_TIMEOUT_MS ?? "35000");
server.headersTimeout = parseInt(process.env.HEADERS_TIMEOUT_MS ?? "40000");

// #399: Initialize cache manager and admin event listener
const contractId = getConfiguredContractId();
let adminEventListener = null;

if (contractId) {
  try {
    const cache = getCacheManager();
    logger.info("[Startup] Cache manager initialized");

    // Start event listener for admin transfer events
    const { getSorobanRpcClient } = await import("./stellar.js");
    const sorobanRpc = getSorobanRpcClient();
    adminEventListener = new AdminEventListener(sorobanRpc, contractId);
    adminEventListener.start();
    logger.info("[Startup] Admin event listener started", { contractId });
  } catch (err) {
    logger.error("[Startup] Failed to initialize cache/event listener", {
      error: err.message,
      contractId,
    });
  }
}

// Graceful shutdown — include event listener and cache cleanup
const originalShutdown = createGracefulShutdownHandler({
  server,
  closeDatabase,
  logger,
});

const handleShutdown = (signal) => {
  logger.info(`[Shutdown] ${signal} received, cleaning up...`);
  if (adminEventListener) {
    adminEventListener.stop();
  }
  const cache = getCacheManager();
  cache.disconnect().catch(() => {});
  originalShutdown(signal);
};

process.once("SIGTERM", () => handleShutdown("SIGTERM"));
process.once("SIGINT", () => handleShutdown("SIGINT"));
