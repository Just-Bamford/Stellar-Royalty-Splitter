import logger from "./logger.js";
import { sendError } from "./error-response.js";
import { recordRejectedRequest } from "./metrics.js";

// In-memory store for tracking IP validation failures
const validationFailures = new Map();

// Configuration
const FAILURE_LIMIT = parseInt(process.env.DOS_VALIDATION_FAILURE_LIMIT ?? "5", 10);
const BLOCK_DURATION_MS = parseInt(process.env.DOS_BLOCK_DURATION_MS ?? "60000", 10); // 1 minute default

/**
 * Record a validation failure for an IP.
 * If the IP exceeds the FAILURE_LIMIT, it gets temporarily blocked.
 * 
 * @param {string} ip - The requester's IP address
 */
export function recordValidationFailure(ip) {
  if (!ip) return;
  const now = Date.now();
  const current = validationFailures.get(ip) ?? { count: 0, blockedUntil: 0 };
  
  // Clean up block if expired
  if (current.blockedUntil > 0 && now > current.blockedUntil) {
    current.count = 0;
    current.blockedUntil = 0;
  }
  
  current.count += 1;
  if (current.count >= FAILURE_LIMIT) {
    current.blockedUntil = now + BLOCK_DURATION_MS;
    logger.warn("Suspected DoS: IP blocked due to excessive validation failures", {
      ip,
      count: current.count,
      blockedUntil: new Date(current.blockedUntil).toISOString(),
    });
  } else {
    logger.info("Validation failure recorded", { ip, count: current.count });
  }
  
  validationFailures.set(ip, current);
}

/**
 * Check if an IP address is currently blocked due to validation failures.
 * 
 * @param {string} ip - The requester's IP address
 * @returns {boolean} True if the IP is blocked
 */
export function isIpBlocked(ip) {
  if (!ip) return false;
  const current = validationFailures.get(ip);
  if (!current) return false;
  
  const now = Date.now();
  if (current.blockedUntil > 0) {
    if (now > current.blockedUntil) {
      // Block expired
      validationFailures.delete(ip);
      return false;
    }
    return true;
  }
  return false;
}

/**
 * Clear the validation failures map (primarily for testing purposes).
 */
export function resetValidationFailures() {
  validationFailures.clear();
}

/**
 * Middleware that enforces payload size limits and checks IP block status.
 * Enforces:
 *  - 10kb limit on application/json payloads
 *  - 50kb limit on multipart/form-data payloads
 */
export function dosProtectionMiddleware(req, res, next) {
  const ip = req.ip;
  
  // 1. Check if IP is blocked
  if (isIpBlocked(ip)) {
    logger.warn("Rejected request: IP is blocked due to DoS rate-limiting", { ip, path: req.originalUrl });
    recordRejectedRequest();
    return sendError(
      res,
      429,
      "too_many_validation_failures",
      "IP temporarily blocked due to excessive validation failures."
    );
  }
  
  // Only validate payload size for mutating requests with bodies (POST, PUT, PATCH, DELETE)
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    return next();
  }
  
  // Determine payload size limit based on Content-Type
  const isMultipart = req.is("multipart/*");
  const limit = isMultipart ? 50 * 1024 : 10 * 1024; // 50kb for multipart, 10kb otherwise
  
  // 2. Validate Content-Length header if present
  const contentLengthHeader = req.headers["content-length"];
  if (contentLengthHeader) {
    const contentLength = parseInt(contentLengthHeader, 10);
    if (!Number.isNaN(contentLength) && contentLength > limit) {
      logger.warn("Suspected DoS attack: Content-Length header exceeded limit", {
        ip,
        limit,
        contentLength,
        path: req.originalUrl,
      });
      recordRejectedRequest();
      return sendError(res, 413, "payload_too_large", "Payload too large");
    }
  }
  
  // 3. Monitor data stream size dynamically to handle chunked/unannounced large payloads
  let receivedBytes = 0;
  
  // Helper function to handle overflow
  const handleOverflow = () => {
    logger.warn("Suspected DoS attack: Stream payload size exceeded limit", {
      ip,
      limit,
      receivedBytes,
      path: req.originalUrl,
    });
    recordRejectedRequest();
    
    // Destroy request socket to terminate data ingestion
    req.destroy();
    
    if (!res.headersSent) {
      sendError(res, 413, "payload_too_large", "Payload too large");
    }
  };

  req.on("data", (chunk) => {
    receivedBytes += chunk.length;
    if (receivedBytes > limit) {
      handleOverflow();
    }
  });

  next();
}
