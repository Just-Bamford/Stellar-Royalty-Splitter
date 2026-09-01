// dotenv is optional - load .env file if needed
// import "dotenv/config";

// OTel SDK must initialise before any other imports so auto-instrumentation
// can patch http/express before they are loaded.
import "./tracing.js";
import { tracingMiddleware } from "./tracing.js";

import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import logger, { asyncLocalStorage } from "./logger.js";
import crypto from "crypto";
import { resolveCorsOrigin } from "./cors-config.js";
import { initializeRouter } from "./routes/initialize.js";
import { distributeRouter } from "./routes/distribute.js";
import { batchDistributeRouter } from "./routes/batch-distribute.js";
import { collaboratorsRouter } from "./routes/collaborators.js";
import { secondaryRoyaltyRouter } from "./routes/secondary-royalty.js";
import { simulateRouter } from "./routes/simulate.js";
import historyRouter from "./routes/history.js";
import webhooksRouter from "./routes/webhooks.js";
import { analyticsRouter } from "./routes/analytics.js";
import { contractRouter } from "./routes/contract.js";
import { healthRouter } from "./routes/health.js";
import { livenessRouter } from "./routes/liveness.js";
import onboardingRouter from "./routes/onboarding.js";
import { closeDatabase, initializeDatabase } from "./database/index.js";
import { startHealthMonitor, stopHealthMonitor } from "./database/health-monitor.js";
import { createGracefulShutdownHandler, shutdownMiddleware } from "./shutdown.js";
import { adminRouter } from "./routes/admin.js";
import { snapshotRouter } from "./routes/snapshots.js";
import { communicationsRouter } from "./routes/communications.js";
import { metricsRouter } from "./routes/metrics.js";
import { applicationLogsRouter } from "./routes/application-logs.js";
import { evaluateLogAlerts, pruneApplicationLogs } from "./database/application-logs.js";
import { initializeSigningKey } from "./signing-key.js";
import { sendError, notFoundHandler, errorHandler } from "./error-response.js";
import { preferencesRouter } from "./routes/preferences.js";
import { templatesRouter } from "./routes/templates.js";
import emailDigestRouter from "./routes/email-digest.js";
import { disputesRouter } from "./routes/disputes.js";
import { referralsRouter } from "./routes/referrals.js";
import { sendWeeklyDigests } from "./jobs/weekly-digest-job.js";
import { isEmailConfigured } from "./email/email-service.js";
import { rankingRouter } from "./routes/ranking.js";
import { docsRouter } from "./routes/docs.js";
import { tiersRouter } from "./routes/tiers.js";
import { attachRole } from "./middleware/rbac.js";
import { csvImportRouter } from "./routes/csv-import.js";
import { contributorTaxRouter } from "./routes/contributor-tax.js";
import { notificationsRouter } from "./routes/notifications.js";
import { paymentHoldsRouter } from "./routes/payment-holds.js";
import { earningsHistoryRouter } from "./routes/earnings-history.js";
import { versionRouter } from "./routes/version.js";
import { initializeWebSocket } from "./websocket.js";
import { startSnapshotScheduler } from "./jobs/snapshot-job.js";
import { startWebhookRetryScheduler } from "./jobs/retry-failed-webhooks.js";
import { adminApiKeysRouter } from "./routes/admin-api-keys.js";
import { recordApiKeyRequest } from "./database/rate-limit.js";
import { recordHttpRequest } from "./metrics.js";
import { createMetricsPusher } from "./metrics-pushgateway.js";
import { transactionFinalityRouter } from "./routes/transaction-finality.js";
import { startFinalityCleanupScheduler } from "./jobs/finality-cleanup-job.js";
import { startPaymentScheduleJob } from "./jobs/payment-schedule-job.js";
import { setupGraphQL } from "./graphql.js";
import { requestComplexityMiddleware } from "./request-complexity.js";

// Initialize database on startup
initializeDatabase();
initializeSigningKey();

// Keep the searchable log store bounded without requiring a separate worker.
// `unref` means this maintenance timer cannot keep tests or graceful shutdowns alive.
const logRetentionInterval = setInterval(() => {
  pruneApplicationLogs(process.env.LOG_RETENTION_DAYS);
}, 6 * 60 * 60 * 1000);
logRetentionInterval.unref?.();
pruneApplicationLogs(process.env.LOG_RETENTION_DAYS);

// Start database connection health monitor (#496)
startHealthMonitor();

const app = express();

// Request correlation ID and logging middleware
app.use((req, res, next) => {
  const correlationId = req.headers["x-correlation-id"] || crypto.randomUUID();
  res.setHeader("X-Correlation-ID", correlationId);
  req.correlationId = correlationId;

  asyncLocalStorage.run({ correlationId }, () => {
    const start = Date.now();
    res.on("finish", () => {
      const duration = Date.now() - start;
      const metadata = {
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        duration,
      };
      const log = res.statusCode >= 500 ? logger.error : res.statusCode >= 400 ? logger.warn : logger.info;
      log.call(logger, "request completed", metadata);
      if (res.statusCode >= 500) {
        const alert = evaluateLogAlerts({
          windowMinutes: process.env.LOG_ALERT_WINDOW_MINUTES,
          errorThreshold: process.env.LOG_ALERT_ERROR_THRESHOLD,
        });
        if (alert.triggered) logger.error("Centralized log error-rate alert triggered", alert);
      }
    });
    next();
  });
});

// Reject new incoming requests during graceful shutdown (#701)
app.use(shutdownMiddleware);

// Security headers
app.use(helmet());

// Distributed tracing — creates per-request OTel spans, injects X-Trace-Id and X-Correlation-Id
app.use(tracingMiddleware);
// #766: gzip/deflate compress responses over 1KB (analytics payloads, CSV/JSON
// exports, etc). Clients can opt out with `x-no-compression` for debugging.
app.use(
  compression({
    threshold: 1024,
    filter: (req, res) => {
      if (req.headers["x-no-compression"]) return false;
      return compression.filter(req, res);
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
    methods: ["GET", "POST", "PATCH"],
    maxAge: Number.isNaN(corsPreflightMaxAge) ? 86400 : corsPreflightMaxAge,
  })
);

const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? "60000");
const RATE_LIMIT_WRITE_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WRITE_WINDOW_MS ?? "60000");
const RATE_LIMIT_SIMULATE_WINDOW_MS = parseInt(
  process.env.RATE_LIMIT_SIMULATE_WINDOW_MS ?? process.env.RATE_LIMIT_WINDOW_MS ?? "60000"
);

// Public rate limiter: 100 req / 1 min per IP (skips /api/health)
// Authenticated rate limiter: 1000 req / 1 min per API key
const generalLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
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
    // Record the blocked request before responding
    const apiKey = req.headers["x-api-key"];
    if (apiKey) recordApiKeyRequest(apiKey, true);

    logger.warn("Rate limit exceeded", {
      ip: req.ip,
      path: req.originalUrl,
      method: req.method,
      apiKey: apiKey ? "present" : "none",
    });
    res.set("Retry-After", String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)));
    sendError(res, 429, "too_many_requests", "Too many requests, please try again later.");
  },
  skip: (req) =>
    req.path === "/api/v1/health" ||
    req.path === "/api/health" ||
    req.path === "/health" ||
    req.path === "/ready",
});

// Write limiter: 10 req / configurable window per IP
const writeLimiter = rateLimit({
  windowMs: RATE_LIMIT_WRITE_WINDOW_MS,
  max: parseInt(process.env.RATE_LIMIT_WRITE_MAX ?? "10"),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn("Write rate limit exceeded", {
      ip: req.ip,
      path: req.originalUrl,
      method: req.method,
    });
    res.set("Retry-After", String(Math.ceil(RATE_LIMIT_WRITE_WINDOW_MS / 1000)));
    sendError(res, 429, "too_many_requests", "Too many write requests, please slow down.");
  },
});

// Read limiter for analytics/history endpoints (#394): tighter than the
// general limiter to prevent large DB scans at arbitrary scale.
// Default: 30 req / 1 min per IP (env: RATE_LIMIT_READ_MAX).
const readLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? "60000"),
  max: parseInt(process.env.RATE_LIMIT_READ_MAX ?? "30"),
  keyGenerator: (req) => req.headers["x-api-key"] || ipKeyGenerator(req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn("Read rate limit exceeded", {
      ip: req.ip,
      path: req.originalUrl,
      method: req.method,
      apiKey: req.headers["x-api-key"] ? "present" : "none",
    });
    res.set("Retry-After", "60");
    sendError(res, 429, "too_many_requests", "Too many requests, please try again later.");
  },
});

// Simulation calls hit Soroban RPC and can be expensive even though they do not
// submit a transaction, so tune them independently from ordinary reads/writes.
const simulateLimiter = rateLimit({
  windowMs: RATE_LIMIT_SIMULATE_WINDOW_MS,
  max: parseInt(process.env.RATE_LIMIT_SIMULATE_MAX ?? "20"),
  keyGenerator: (req) => req.headers["x-api-key"] || ipKeyGenerator(req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn("Simulation rate limit exceeded", {
      ip: req.ip,
      path: req.originalUrl,
      method: req.method,
      apiKey: req.headers["x-api-key"] ? "present" : "none",
    });
    res.set("Retry-After", String(Math.ceil(RATE_LIMIT_SIMULATE_WINDOW_MS / 1000)));
    sendError(res, 429, "too_many_requests", "Too many simulation requests, please slow down.");
  },
});

app.use(generalLimiter);

// #608: Track per-API-key request counts for the rate-limit dashboard.
// Only records authenticated (keyed) requests that were not blocked by the
// limiter above (blocked requests are recorded in the limiter's handler).
app.use((req, _res, next) => {
  const apiKey = req.headers["x-api-key"];
  if (apiKey) recordApiKeyRequest(apiKey, false);
  next();
});

// Global max request body size — configurable via env, defaults to prior hardcoded value.
const MAX_REQUEST_BODY_SIZE = process.env.MAX_REQUEST_BODY_SIZE ?? "10kb";
app.use(express.json({ limit: MAX_REQUEST_BODY_SIZE }));

// Attach X-API-Version header to all versioned responses
app.use("/api/v1", (_req, res, next) => {
  res.set("X-API-Version", "v1");
  next();
});

// Attach RBAC role to every request (#572)
app.use(attachRole);

// Enforce Content-Type: application/json on POST requests
app.use((req, res, next) => {
  if (req.method === "POST" && !req.is("application/json")) {
    return sendError(res, 415, "unsupported_media_type", "Content-Type must be application/json");
  }
  next();
});

// Enforce request complexity limits before expensive downstream processing (#892)
app.use(requestComplexityMiddleware());


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
app.use("/api/v1/batch-distribute", writeLimiter);
app.use("/api/v1/secondary-royalty", writeLimiter);
app.use("/api/v1/webhooks", writeLimiter);
app.use("/api/v1/onboarding", writeLimiter);
app.use("/api/v1/simulate", simulateLimiter);

// Apply read limiter to high-fan-out query endpoints (#394 — MEDIUM-16)
app.use("/api/v1/analytics", readLimiter);
app.use("/api/v1/history", readLimiter);
app.use("/api/v1/archive", readLimiter);
app.use("/api/v1/audit", readLimiter);

// Ed25519 signature verification on all write endpoints (#392).
// Set SIGNATURE_VERIFICATION_ENABLED=false to log-only during rollout.
app.use("/api/v1/initialize", verifySignatureMiddleware);
app.use("/api/v1/distribute", verifySignatureMiddleware);
app.use("/api/v1/batch-distribute", verifySignatureMiddleware);
app.use("/api/v1/secondary-royalty", verifySignatureMiddleware);

app.use("/api/v1/initialize", initializeRouter);
app.use("/api/v1/distribute", distributeRouter);
app.use("/api/v1/batch-distribute", batchDistributeRouter);
app.use("/api/v1/collaborators", collaboratorsRouter);
app.use("/api/v1/secondary-royalty", secondaryRoyaltyRouter);
app.use("/api/v1/simulate", simulateRouter);
app.use("/api/v1/onboarding", onboardingRouter);
app.use("/api/v1", historyRouter);
app.use("/api/v1", webhooksRouter);
app.use("/api/v1", analyticsRouter);
app.use("/api/v1/contract", contractRouter);
app.use("/api/v1/health", healthRouter);
app.use(livenessRouter);
app.use("/api/v1/preferences", preferencesRouter);
app.use("/api/v1/templates", templatesRouter);
app.use("/api/v1", emailDigestRouter);
app.use("/api/v1/disputes", writeLimiter);
app.use("/api/v1/disputes", disputesRouter);
app.use("/api/v1/referrals", writeLimiter);
app.use("/api/v1/referrals", referralsRouter);
app.use("/metrics", metricsRouter);
app.use("/api/v1/metrics", metricsRouter);
app.use("/api/v1/observability", applicationLogsRouter);

// Contributor performance rankings (#586)
app.use("/api/v1/ranking", rankingRouter);

// Contributor tiers (#589)
app.use("/api/v1/tiers", tiersRouter);

// API documentation (#587)
app.use("/api/docs", docsRouter);
app.use("/api/v1/docs", docsRouter);

// CSV bulk import (#597)
app.use("/api/v1/csv-import", csvImportRouter);

// Contributor tax information (#595)
app.use("/api/v1/contributor-tax", contributorTaxRouter);

// Real-time notifications (#594)
app.use("/api/v1/notifications", notificationsRouter);

// Payment hold/release system (#596)
app.use("/api/v1/payment-holds", writeLimiter);
app.use("/api/v1/payment-holds", paymentHoldsRouter);

// Contributor earnings history (#564)
app.use("/api/v1", earningsHistoryRouter);

// Contract state snapshots (#613)
app.use("/api/v1/snapshots", snapshotRouter);

// Contributor communication history (#612)
app.use("/api/v1/communications", communicationsRouter);

// API version discovery (#676)
app.use("/api/v1/version", versionRouter);

// Transaction finality tracking (#finality)
app.use("/api/v1/transactions", transactionFinalityRouter);

// Admin operations (separate from /api/v1; protected by ADMIN_ROTATE_TOKEN)
const RATE_LIMIT_ADMIN_WINDOW_MS = 60_000;
const adminLimiter = rateLimit({
  windowMs: RATE_LIMIT_ADMIN_WINDOW_MS,
  max: parseInt(process.env.RATE_LIMIT_ADMIN_MAX ?? "5"),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn("Admin rate limit exceeded", {
      ip: req.ip,
      path: req.originalUrl,
      method: req.method,
    });
    res.set("Retry-After", String(Math.ceil(RATE_LIMIT_ADMIN_WINDOW_MS / 1000)));
    sendError(res, 429, "too_many_requests", "Too many admin requests, please slow down.");
  },
});
app.use("/admin", adminLimiter);
app.use("/admin", adminRouter);
app.use("/admin/api-keys", adminLimiter);
app.use("/admin/api-keys", adminApiKeysRouter);

// Legacy /api/* redirect to /api/v1/* — routes under /api/v1/* are canonical
app.use("/api", (req, res) => {
  res.set("Deprecation", "true");
  res.set("Link", `</api/v1${req.url}>; rel="successor-version"`);
  res.redirect(308, `/api/v1${req.url}`);
});

// Any request that didn't match a route above gets the standard error shape
// instead of Express's default HTML 404 page (#662).
app.use(notFoundHandler);

// Central error handler — must be mounted last.
app.use(errorHandler);

async function startServer() {
  // GraphQL API (#809)
  await setupGraphQL(app, "/api/v1/graphql");

  const PORT = process.env.PORT ?? 3001;
  const server = app.listen(PORT, () => logger.info(`API listening on http://localhost:${PORT}`));

  // Initialize WebSocket for real-time notifications (#594)
  const wss = initializeWebSocket(server);

  // Start the snapshot scheduler (#613)
  const snapshotScheduler = startSnapshotScheduler();

  // Start the webhook retry scheduler (#743)
  const webhookRetryScheduler = startWebhookRetryScheduler();

  // Start the finality cleanup scheduler (#finality)
  const finalityCleanupScheduler = startFinalityCleanupScheduler();

  // Start the payment schedule job (#599)
  const paymentScheduleJob = startPaymentScheduleJob();

  const metricsPusher = createMetricsPusher();
  metricsPusher.start();

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
      if (snapshotScheduler) {
        snapshotScheduler.stop();
      }
      if (webhookRetryScheduler) {
        webhookRetryScheduler.stop();
      }
      if (finalityCleanupScheduler) {
        finalityCleanupScheduler.stop();
      }
      if (paymentScheduleJob) {
        paymentScheduleJob.stop();
      }
      metricsPusher.stop();
    },
  });

  process.once("SIGTERM", () => handleShutdown("SIGTERM"));
  process.once("SIGINT", () => handleShutdown("SIGINT"));
}

startServer().catch((error) => {
  logger.error("Failed to start server", { error: error.message });
  process.exit(1);
});
