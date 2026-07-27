import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
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
import onboardingRouter from "./routes/onboarding.js";
import { closeDatabase, initializeDatabase } from "./database/index.js";
import { createGracefulShutdownHandler } from "./shutdown.js";
import { adminRouter } from "./routes/admin.js";
import { metricsRouter } from "./routes/metrics.js";
import { initializeSigningKey } from "./signing-key.js";
import { sendError, normalizeErrorCode } from "./error-response.js";
import { preferencesRouter } from "./routes/preferences.js";
import emailDigestRouter from "./routes/email-digest.js";
import { sendWeeklyDigests } from "./jobs/weekly-digest-job.js";
import { isEmailConfigured } from "./email/email-service.js";
import { startRetryScheduler } from "./jobs/retry-failed-distributions.js";
import { rankingRouter } from "./routes/ranking.js";
import { docsRouter } from "./routes/docs.js";
import { attachRole } from "./middleware/rbac.js";
import { csvImportRouter } from "./routes/csv-import.js";
import { contributorTaxRouter } from "./routes/contributor-tax.js";
import { notificationsRouter } from "./routes/notifications.js";
import { paymentHoldsRouter } from "./routes/payment-holds.js";
import { kycWebhooksRouter } from "./routes/kyc-webhooks.js";
import { initializeWebSocket } from "./websocket.js";

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
    methods: ["GET", "POST", "PATCH"],
    maxAge: Number.isNaN(corsPreflightMaxAge) ? 86400 : corsPreflightMaxAge,
  })
);

// Public rate limiter: 100 req / 1 min per IP (skips /api/health)
// Authenticated rate limiter: 1000 req / 1 min per API key
const generalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? "60000"),
  max: (req) => {
    if (req.headers["x-api-key"]) {
      return parseInt(process.env.RATE_LIMIT_AUTH_MAX ?? "1000");
    }
    return parseInt(process.env.RATE_LIMIT_MAX ?? "100");
  },
  keyGenerator: (req) => req.headers["x-api-key"] || ipKeyGenerator(req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn("Rate limit exceeded", {
      ip: req.ip,
      path: req.originalUrl,
      method: req.method,
      apiKey: req.headers["x-api-key"] ? "present" : "none",
    });
    res.set("Retry-After", "60");
    sendError(res, 429, "too_many_requests", "Too many requests, please try again later.");
  },
  skip: (req) => req.path === "/api/v1/health" || req.path === "/api/health",
});

// Write limiter: 10 req / 1 min per IP
const writeLimiter = rateLimit({
  windowMs: 60_000,
  max: parseInt(process.env.RATE_LIMIT_WRITE_MAX ?? "10"),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn("Write rate limit exceeded", {
      ip: req.ip,
      path: req.originalUrl,
      method: req.method,
    });
    res.set("Retry-After", "60");
    sendError(res, 429, "too_many_requests", "Too many write requests, please slow down.");
  },
});

app.use(generalLimiter);
app.use(express.json({ limit: "10kb" }));

// Attach RBAC role to every request (#572)
app.use(attachRole);

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
app.use("/api/v1/onboarding", writeLimiter);

app.use("/api/v1/initialize", initializeRouter);
app.use("/api/v1/distribute", distributeRouter);
app.use("/api/v1/collaborators", collaboratorsRouter);
app.use("/api/v1/secondary-royalty", secondaryRoyaltyRouter);
app.use("/api/v1/simulate", simulateRouter);
app.use("/api/v1/onboarding", onboardingRouter);
app.use("/api/v1", historyRouter);
app.use("/api/v1", webhooksRouter);
app.use("/api/v1", analyticsRouter);
app.use("/api/v1/contract", contractRouter);
app.use("/api/v1/health", healthRouter);
app.use("/api/v1/preferences", preferencesRouter);
app.use("/api/v1", emailDigestRouter);
app.use("/metrics", metricsRouter);
app.use("/api/v1/metrics", metricsRouter);

// Contributor performance rankings (#586)
app.use("/api/v1/ranking", rankingRouter);

// API documentation (#587)
app.use("/api/docs", docsRouter);

// CSV bulk import (#597)
app.use("/api/v1/csv-import", csvImportRouter);

// Contributor tax information (#595)
app.use("/api/v1/contributor-tax", contributorTaxRouter);

// Real-time notifications (#594)
app.use("/api/v1/notifications", notificationsRouter);

// Payment hold/release system (#596)
app.use("/api/v1/payment-holds", writeLimiter);
app.use("/api/v1/payment-holds", paymentHoldsRouter);

// KYC Integration Hooks (#598)
app.use("/api/v1/kyc", writeLimiter);
app.use("/api/v1/kyc", kycWebhooksRouter);

// Admin operations (separate from /api/v1; protected by ADMIN_ROTATE_TOKEN)
const adminLimiter = rateLimit({
  windowMs: 60_000,
  max: parseInt(process.env.RATE_LIMIT_ADMIN_MAX ?? "5"),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn("Admin rate limit exceeded", {
      ip: req.ip,
      path: req.originalUrl,
      method: req.method,
    });
    res.set("Retry-After", "60");
    sendError(res, 429, "too_many_requests", "Too many admin requests, please slow down.");
  },
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
    return sendError(res, 413, "payload_too_large", "Payload too large");
  }
  logger.error(err);

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

// Initialize WebSocket for real-time notifications (#594)
const wss = initializeWebSocket(server);

// Start the failed-distribution retry scheduler
const retryScheduler = startRetryScheduler();

// Start weekly email digest scheduler if email is configured
let digestInterval = null;
if (isEmailConfigured()) {
  const DIGEST_CHECK_INTERVAL_MS = parseInt(process.env.DIGEST_CHECK_INTERVAL_MS ?? "60000", 10);
  digestInterval = setInterval(async () => {
    try {
      const result = await sendWeeklyDigests();
      if (result.sent > 0 || result.failed > 0) {
        logger.info("Weekly digest run completed", result);
      }
    } catch (error) {
      logger.error("Weekly digest scheduler error", { error: error.message });
    }
  }, DIGEST_CHECK_INTERVAL_MS);
  digestInterval.unref();
  logger.info("Weekly email digest scheduler started", { intervalMs: DIGEST_CHECK_INTERVAL_MS });
} else {
  logger.info("Email not configured; weekly digest scheduler disabled");
}

// Prevent hung connections from exhausting the connection pool
server.keepAliveTimeout = parseInt(process.env.KEEP_ALIVE_TIMEOUT_MS ?? "35000");
server.headersTimeout = parseInt(process.env.HEADERS_TIMEOUT_MS ?? "40000");

const handleShutdown = createGracefulShutdownHandler({
  server,
  closeDatabase,
  logger,
  onShutdown: () => {
    if (wss) {
      wss.close();
      logger.info("WebSocket server closed");
    }
    if (digestInterval) {
      clearInterval(digestInterval);
      digestInterval = null;
    }
    if (retryScheduler) {
      retryScheduler.stop();
    }
  },
});

process.once("SIGTERM", () => handleShutdown("SIGTERM"));
process.once("SIGINT", () => handleShutdown("SIGINT"));
