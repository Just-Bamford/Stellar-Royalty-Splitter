/**
 * Request-level deduplication middleware (#762).
 *
 * Detects in-flight duplicate requests by hashing `contract + operation + args`
 * (extracted from the request body). When a duplicate arrives within the
 * DEDUP_WINDOW_MS window, it waits for the first request to complete and
 * shares its response — preventing re-execution of expensive Soroban RPC calls.
 *
 * Lifetime:
 *   short-lived (5 s by default) — complements the long-lived idempotency key cache.
 *
 * Metrics emitted per request: dedup-hits, dedup-misses.
 */

import crypto from "crypto";
import logger from "../logger.js";

const DEDUP_WINDOW_MS = parseInt(process.env.DEDUP_WINDOW_MS ?? "5000", 10);

/** Tracks in-flight requests: hash → Promise<{status, body}> */
const inFlight = new Map();

/** Simple counters for observability. */
export const dedupMetrics = { hits: 0, misses: 0 };

/**
 * Build a stable deduplication key from the request body fields that
 * uniquely identify a Soroban operation.
 */
function buildDedupKey(body) {
  const { contractId, walletAddress, operation, tokenId } = body ?? {};
  const raw = JSON.stringify({ contractId, walletAddress, operation, tokenId });
  return crypto.createHash("sha256").update(raw).digest("hex");
}

/**
 * Express middleware factory.
 *
 * Usage:
 *   import { dedupMiddleware } from "../middleware/dedup.js";
 *   router.post("/", dedupMiddleware(), validate(schema), handler);
 *
 * The middleware only activates when the request body contains `contractId`
 * (i.e. routes that proxy Soroban calls). Other routes pass through unchanged.
 */
export function dedupMiddleware() {
  return function dedup(req, res, next) {
    const body = req.body;

    // Skip dedup for routes that don't target a specific contract
    if (!body?.contractId) {
      dedupMetrics.misses++;
      return next();
    }

    const key = buildDedupKey(body);

    if (inFlight.has(key)) {
      dedupMetrics.hits++;
      logger.debug({ key }, "Dedup: in-flight duplicate detected — waiting for first response");

      inFlight
        .get(key)
        .then(({ status, body: cachedBody }) => {
          res.status(status).json(cachedBody);
        })
        .catch((err) => {
          res.status(500).json({ error: err.message ?? "Upstream request failed" });
        });

      return; // do NOT call next()
    }

    dedupMetrics.misses++;

    // Capture the response so waiters can share it
    let resolveShared, rejectShared;
    const shared = new Promise((resolve, reject) => {
      resolveShared = resolve;
      rejectShared = reject;
    });

    inFlight.set(key, shared);

    // Auto-clear stale entry in case the response never fires (safety net)
    const cleanup = setTimeout(() => {
      if (inFlight.get(key) === shared) {
        inFlight.delete(key);
        rejectShared(new Error("Dedup entry timed out"));
      }
    }, DEDUP_WINDOW_MS);

    // Allow this timeout to not block process exit during tests
    if (cleanup.unref) {
      cleanup.unref();
    }

    // Intercept res.json to capture the real response
    const originalJson = res.json.bind(res);
    res.json = function interceptedJson(payload) {
      clearTimeout(cleanup);
      inFlight.delete(key);
      const status = res.statusCode ?? 200;
      resolveShared({ status, body: payload });
      return originalJson(payload);
    };

    // If an error is passed to next(), reject so waiters see the error
    const originalNext = next;
    const wrappedNext = function (err) {
      if (err) {
        clearTimeout(cleanup);
        inFlight.delete(key);
        rejectShared(err);
      }
      originalNext(err);
    };

    next = wrappedNext;
    next();
  };
}
