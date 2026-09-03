/**
 * Tiered rate limiting middleware (#765).
 *
 * Three independent layers are enforced in order, most-permissive first:
 *   1. Per-IP   — 100 req / 15 min  (general baseline, already in index.js)
 *   2. Per-wallet — 50 req / 1 min  (walletAddress from request body)
 *   3. Per-contract — 10 distribute calls / 1 min (contractId from request body)
 *
 * Limits are configuration-driven via env vars. A Retry-After header is always
 * returned on 429 so clients can back off gracefully.
 *
 * Warn-at-80% uses X-RateLimit-Warning response header so clients can surface
 * the impending limit without yet being blocked.
 */

import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import logger from "../logger.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONTRACT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_CONTRACT_WINDOW_MS ?? "60000", 10);
const CONTRACT_MAX = parseInt(process.env.RATE_LIMIT_CONTRACT_MAX ?? "10", 10);

const WALLET_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WALLET_WINDOW_MS ?? "60000", 10);
const WALLET_MAX = parseInt(process.env.RATE_LIMIT_WALLET_MAX ?? "50", 10);

/** Warn clients once they've consumed this fraction of their quota. */
const WARN_THRESHOLD = parseFloat(process.env.RATE_LIMIT_WARN_THRESHOLD ?? "0.8");

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export const rateLimitMetrics = {
  contractHits: 0,
  walletHits: 0,
  ipHits: 0,
};

// ---------------------------------------------------------------------------
// Key generators
// ---------------------------------------------------------------------------

function contractKeyGenerator(req) {
  const contractId = req.body?.contractId;
  if (contractId) return `contract:${contractId}`;
  // Use ipKeyGenerator helper for IPv6 compliance
  return `ip:${ipKeyGenerator(req.ip)}`;
}

function walletKeyGenerator(req) {
  const walletAddress = req.body?.walletAddress;
  if (walletAddress) return `wallet:${walletAddress}`;
  // Use ipKeyGenerator helper for IPv6 compliance
  return `ip:${ipKeyGenerator(req.ip)}`;
}

// ---------------------------------------------------------------------------
// Warning injector (80% threshold)
// ---------------------------------------------------------------------------

function warnOnApproach(req, res, next, max, current) {
  if (current >= Math.floor(max * WARN_THRESHOLD)) {
    res.setHeader("X-RateLimit-Warning", `Approaching rate limit (${current}/${max})`);
  }
  next();
}

// ---------------------------------------------------------------------------
// Per-contract limiter
// ---------------------------------------------------------------------------

export const contractLimiter = rateLimit({
  windowMs: CONTRACT_WINDOW_MS,
  max: CONTRACT_MAX,
  keyGenerator: contractKeyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  handler(req, res) {
    rateLimitMetrics.contractHits++;
    logger.warn(
      { contractId: req.body?.contractId, ip: req.ip },
      "Per-contract rate limit exceeded"
    );
    const retryAfterSec = Math.ceil(CONTRACT_WINDOW_MS / 1000);
    res.status(429).set("Retry-After", String(retryAfterSec)).json({
      error: "Per-contract rate limit exceeded. Please retry later.",
      retryAfterSeconds: retryAfterSec,
    });
  },
  skip: (req) => !req.body?.contractId,
});

// ---------------------------------------------------------------------------
// Per-wallet limiter
// ---------------------------------------------------------------------------

export const walletLimiter = rateLimit({
  windowMs: WALLET_WINDOW_MS,
  max: WALLET_MAX,
  keyGenerator: walletKeyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  handler(req, res) {
    rateLimitMetrics.walletHits++;
    logger.warn(
      { walletAddress: req.body?.walletAddress, ip: req.ip },
      "Per-wallet rate limit exceeded"
    );
    const retryAfterSec = Math.ceil(WALLET_WINDOW_MS / 1000);
    res.status(429).set("Retry-After", String(retryAfterSec)).json({
      error: "Per-wallet rate limit exceeded. Please retry later.",
      retryAfterSeconds: retryAfterSec,
    });
  },
  skip: (req) => !req.body?.walletAddress,
});

// ---------------------------------------------------------------------------
// Warn middleware (inserted between limiters and route handler)
// ---------------------------------------------------------------------------

export function rateLimitWarnMiddleware(req, res, next) {
  const contractCurrent = res.getHeader("X-RateLimit-Remaining-contract");
  const walletCurrent = res.getHeader("X-RateLimit-Remaining-wallet");

  if (contractCurrent !== undefined) {
    warnOnApproach(
      req,
      res,
      next,
      CONTRACT_MAX,
      CONTRACT_MAX - parseInt(String(contractCurrent), 10)
    );
  } else if (walletCurrent !== undefined) {
    warnOnApproach(req, res, next, WALLET_MAX, WALLET_MAX - parseInt(String(walletCurrent), 10));
  } else {
    next();
  }
}

/**
 * Convenience: compose both tiered limiters as a middleware array.
 * Apply to routes that accept contractId and walletAddress.
 *
 * Usage:
 *   router.post("/", ...tieredLimiters, handler);
 */
export const tieredLimiters = [walletLimiter, contractLimiter];
