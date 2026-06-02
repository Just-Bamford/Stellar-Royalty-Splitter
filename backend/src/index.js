// dotenv is optional - load .env file if needed
// import "dotenv/config";

import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import logger from "./logger.js";
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
import { closeDatabase, initializeDatabase } from "./database/index.js";
import { createGracefulShutdownHandler } from "./shutdown.js";
import { adminRouter } from "./routes/admin.js";
import { metricsRouter } from "./routes/metrics.js";
import { initializeDatabase } from "./database/index.js";
import db from "./database/index.js";
import { initializeSigningKey } from "./signing-key.js";

// Initialize database on startup
initializeDatabase();
initializeSigningKey();

const app = express();

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    logger.info(`${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`, {
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      duration,
    });
  });
  next();
});

// Security headers
app.use(helmet());

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
    methods: ["GET", "POST"],
    maxAge: Number.isNaN(corsPreflightMaxAge) ? 86400 : corsPreflightMaxAge,
  })
);

// General rate limiter: 100 req / 15 min per IP (skips /api/health)
const generalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? "900000"),
  max: parseInt(process.env.RATE_LIMIT_MAX ?? "100"),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
  skip: (req) => req.path === "/api/v1/health" || req.path === "/api/health",
});

// Write limiter: 10 req / 1 min per IP
const writeLimiter = rateLimit({
  windowMs: 60_000,
  max: parseInt(process.env.RATE_LIMIT_WRITE_MAX ?? "10"),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many write requests, please slow down." },
});

app.use(generalLimiter);
app.use(express.json({ limit: "10kb" }));

// Enforce Content-Type: application/json on POST requests
app.use((req, res, next) => {
  if (req.method === "POST" && !req.is("application/json")) {
    return res.status(415).json({ error: "Content-Type must be application/json" });
  }
  next();
});

// Per-request timeout middleware
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS ?? "30000");
app.use((req, res, next) => {
  const timer = setTimeout(() => {
    if (!res.headersSent) {
      res.status(503).json({ error: "Request timed out. Please try again later." });
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
app.use("/metrics", metricsRouter);
app.use("/api/v1/metrics", metricsRouter);

// Admin operations (separate from /api/v1; protected by ADMIN_ROTATE_TOKEN)
const adminLimiter = rateLimit({
  windowMs: 60_000,
  max: parseInt(process.env.RATE_LIMIT_ADMIN_MAX ?? "5"),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many admin requests, please slow down." },
});
app.use("/admin", adminLimiter);
app.use("/admin", adminRouter);

// Legacy /api/* redirect to /api/v1/*
app.use("/api", (req, res) => {
  res.redirect(308, `/api/v1${req.url}`);
});

// Central error handler
app.use((err, _req, res, _next) => {
  if (err.type === "entity.too.large") {
    return res.status(413).json({ error: "Payload too large" });
  }
  logger.error(err);

  // Structured errors thrown by stellar.js (Soroban / RPC errors)
  if (err.status && err.code) {
    return res.status(err.status).json({
      error: err.message,
      code: err.code,
      ...(err.detail !== undefined && { detail: err.detail }),
    });
  }

  // Structured errors with status but no code (e.g. validation helpers)
  if (err.status) {
    return res.status(err.status).json({ error: err.message });
  }

  res.status(500).json({ error: err.message ?? "Internal server error" });
});

const PORT = process.env.PORT ?? 3001;
const server = app.listen(PORT, () => logger.info(`API listening on http://localhost:${PORT}`));

// Prevent hung connections from exhausting the connection pool
server.keepAliveTimeout = parseInt(process.env.KEEP_ALIVE_TIMEOUT_MS ?? "35000");
server.headersTimeout = parseInt(process.env.HEADERS_TIMEOUT_MS ?? "40000");

const handleShutdown = createGracefulShutdownHandler({
  server,
  closeDatabase,
  logger,
});

process.once("SIGTERM", () => handleShutdown("SIGTERM"));
process.once("SIGINT", () => handleShutdown("SIGINT"));
