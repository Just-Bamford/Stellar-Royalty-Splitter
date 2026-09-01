// Body size validation and DoS protection middleware (#426).
//
// Responsibilities:
//   1. Cap JSON bodies at MAX_JSON_BODY_BYTES (default 10 KB) — replaces the
//      bare express.json() call in index.js. The express.json `limit` option
//      triggers an `entity.too.large` error, which this module intercepts to
//      add logging, metrics, and DoS rate-limiting before the 413 fires.
//   2. Cap multipart/form-data (and other non-JSON) bodies at
//      MAX_MULTIPART_BODY_BYTES (default 50 KB) via a streaming byte counter.
//      These bodies bypass the JSON parser entirely, so we need our own guard.
//   3. Rate-limit IPs that repeatedly send oversized payloads (DoS signal).
//   4. Log every rejected request with enough detail for incident investigation.
//   5. Increment in-memory DoS metrics counters exposed by /metrics.

import express from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import logger from "./logger.js";
import { sendError } from "./error-response.js";
import { recordOversizedRequest, recordDoSRejection } from "./metrics.js";

// ---------------------------------------------------------------------------
// Size constants — overridable via env for staging/test environments
// ---------------------------------------------------------------------------
export const MAX_JSON_BYTES = parseInt(
  process.env.MAX_JSON_BODY_BYTES ?? String(10 * 1024), // 10 KB
  10,
);
export const MAX_MULTIPART_BYTES = parseInt(
  process.env.MAX_MULTIPART_BODY_BYTES ?? String(50 * 1024), // 50 KB
  10,
);

// ---------------------------------------------------------------------------
// DoS rate limiter — applied to IPs that repeatedly send oversized payloads.
// Legitimate clients won't normally hit this; repeated oversized requests are
// a strong signal of an intentional flood.
// ---------------------------------------------------------------------------
export function buildDoSLimiter({
  windowMs = parseInt(process.env.DOS_RATE_WINDOW_MS ?? "60000", 10),
  max = parseInt(process.env.DOS_RATE_MAX ?? "5", 10),
} = {}) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.headers["x-api-key"] || ipKeyGenerator(req.ip),
    skip: () => false,
    handler: (req, res) => {
      recordDoSRejection();
      logger.warn("Suspected DoS attack: repeated oversized payloads", {
        ip: req.ip,
        path: req.originalUrl,
        method: req.method,
        userAgent: req.headers["user-agent"],
        contentType: req.headers["content-type"],
        contentLength: req.headers["content-length"],
      });
      res.set("Retry-After", String(Math.ceil(windowMs / 1000)));
      sendError(
        res,
        429,
        "too_many_requests",
        "Too many oversized requests. Suspected DoS attack — your IP has been rate limited.",
      );
    },
  });
}

// ---------------------------------------------------------------------------
// Shared rejection helper — logs, records metrics, runs DoS limiter
// ---------------------------------------------------------------------------
function rejectOversized(req, res, dosLimiter, meta) {
  recordOversizedRequest();

  logger.warn("Request body exceeds size limit — rejected", {
    ip: req.ip,
    path: req.originalUrl,
    method: req.method,
    userAgent: req.headers["user-agent"],
    contentType: req.headers["content-type"],
    contentLength: req.headers["content-length"],
    ...meta,
  });

  if (res.headersSent) return;

  // Pass through the DoS limiter so repeated offenders get a 429 once they
  // exhaust their per-IP allowance, otherwise respond with 413.
  dosLimiter(req, res, () => {
    if (!res.headersSent) {
      sendError(res, 413, "payload_too_large", "Payload too large");
    }
  });
}

// ---------------------------------------------------------------------------
// Raw body size guard for multipart/form-data and other non-JSON content.
//
// Strategy:
//   a) Fast path: Content-Length present and over limit → reject immediately
//      without reading the body (saves bandwidth on large attacks).
//   b) Slow path: no Content-Length → count bytes as they stream in and abort
//      once the limit is breached.
// ---------------------------------------------------------------------------
export function buildRawBodySizeGuard(maxBytes, dosLimiter) {
  return (req, res, next) => {
    const contentType = req.headers["content-type"] ?? "";

    // JSON is already capped by express.json({ limit }); skip here.
    if (contentType.startsWith("application/json")) {
      return next();
    }

    // Fast path — Content-Length header present
    const declaredLength = parseInt(req.headers["content-length"] ?? "", 10);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      return rejectOversized(req, res, dosLimiter, {
        declared: declaredLength,
        actual: null,
        limit: maxBytes,
        detectionMethod: "content-length-header",
      });
    }

    // Slow path — stream byte counting
    let received = 0;
    let rejected = false;

    req.on("data", (chunk) => {
      if (rejected) return;
      received += chunk.length;
      if (received > maxBytes) {
        rejected = true;
        req.destroy();
        rejectOversized(req, res, dosLimiter, {
          declared: declaredLength || null,
          actual: received,
          limit: maxBytes,
          detectionMethod: "streaming-byte-count",
        });
      }
    });

    // Swallow the "socket hang up" error that fires after req.destroy()
    req.on("error", () => {});

    next();
  };
}

// ---------------------------------------------------------------------------
// JSON parser error interceptor — intercepts entity.too.large thrown by
// express.json() and adds logging, metrics, and DoS rate-limiting.
// ---------------------------------------------------------------------------
export function buildJsonErrorInterceptor(jsonLimit, dosLimiter) {
  return (err, req, res, next) => {
    if (err.type !== "entity.too.large") {
      return next(err);
    }

    recordOversizedRequest();
    logger.warn("JSON body exceeds size limit — rejected", {
      ip: req.ip,
      path: req.originalUrl,
      method: req.method,
      userAgent: req.headers["user-agent"],
      contentType: req.headers["content-type"],
      contentLength: req.headers["content-length"],
      limit: jsonLimit,
      detectionMethod: "express-json-parser",
    });

    if (res.headersSent) return;

    // Run DoS limiter; on first few violations respond 413, on repeated
    // violations the DoS limiter responds 429 instead.
    dosLimiter(req, res, () => {
      if (!res.headersSent) {
        sendError(res, 413, "payload_too_large", "Payload too large");
      }
    });
  };
}

// ---------------------------------------------------------------------------
// createBodySizeLimiters — factory that wires everything together.
//
// Returns an array of middleware to spread into app.use():
//   app.use(...createBodySizeLimiters());
//
// The returned array replaces the bare `app.use(express.json({ limit: '10kb' }))`
// line in index.js and adds multipart protection alongside it.
// ---------------------------------------------------------------------------
export function createBodySizeLimiters({
  jsonLimit = MAX_JSON_BYTES,
  multipartLimit = MAX_MULTIPART_BYTES,
  captureRawBody = false,
} = {}) {
  const dosLimiter = buildDoSLimiter();

  // When captureRawBody is true (e.g. in tests or when signature verification
  // is enabled) we stash the raw bytes on req.rawBody so the signature
  // middleware can verify them against the canonical wire representation.
  const jsonParser = express.json({
    limit: `${jsonLimit}b`,
    ...(captureRawBody && {
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  });
  const jsonErrorInterceptor = buildJsonErrorInterceptor(jsonLimit, dosLimiter);
  const multipartSizeGuard = buildRawBodySizeGuard(multipartLimit, dosLimiter);

  // Order matters:
  //   1. multipartSizeGuard  — rejects oversized non-JSON before any parser runs
  //   2. jsonParser          — parses JSON body (throws entity.too.large if over limit)
  //   3. jsonErrorInterceptor — catches entity.too.large, adds logging/metrics/DoS
  return [multipartSizeGuard, jsonParser, jsonErrorInterceptor];
}
