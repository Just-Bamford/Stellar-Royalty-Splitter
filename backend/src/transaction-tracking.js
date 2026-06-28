import { generateCorrelationId } from "./correlation.js";
import { recordRequestStart, recordRequestEnd, cleanupRequestTracking } from "./database/index.js";
import { recordTrackedTransaction } from "./metrics.js";
import logger from "./logger.js";

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validate that a string looks like a UUID v4.
 * Returns true if valid, false otherwise.
 */
export function isValidTransactionId(id) {
  return typeof id === "string" && UUID_V4_RE.test(id);
}

/**
 * Express middleware that attaches a transaction tracking ID to every request.
 */
export function transactionTrackingMiddleware(req, res, next) {
  const incoming = req.headers["x-transaction-id"];
  const transactionId =
    incoming && isValidTransactionId(incoming) ? incoming : generateCorrelationId();

  req.transactionId = transactionId;
  res.setHeader("X-Transaction-ID", transactionId);

  const correlationId = req.correlationId || "unknown";

  // Log transaction ID throughout request lifecycle
  logger.info("Request transaction tracking started", {
    transactionId,
    correlationId,
    method: req.method,
    path: req.originalUrl,
  });

  // Intercept res.send to capture response body
  const originalSend = res.send;
  let responseBodyCaptured = null;

  res.send = function (body) {
    responseBodyCaptured = body;
    return originalSend.apply(this, arguments);
  };

  res.on("finish", () => {
    logger.info("Request transaction tracking finished", {
      transactionId,
      correlationId,
      status: res.statusCode,
    });

    try {
      let parsedResponse = responseBodyCaptured;
      if (typeof responseBodyCaptured === "string") {
        try {
          parsedResponse = JSON.parse(responseBodyCaptured);
        } catch {
          // not JSON
        }
      }

      // Record to database
      recordRequestStart(
        transactionId,
        correlationId,
        req.method,
        req.originalUrl,
        req.body || null
      );

      recordRequestEnd(transactionId, res.statusCode, parsedResponse || null);

      // Increment Prometheus transaction tracking metric
      recordTrackedTransaction();

      // Periodically clean up old records (1% chance to run cleanup on request finish)
      if (Math.random() < 0.01) {
        const deleted = cleanupRequestTracking();
        if (deleted > 0) {
          logger.info("Cleaned up old request tracking records", { count: deleted });
        }
      }
    } catch (err) {
      logger.error("Error storing request tracking details", {
        transactionId,
        error: err.message,
      });
    }
  });

  next();
}
