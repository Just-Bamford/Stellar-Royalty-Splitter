/**
 * TransactionFinality service — closes #finality.
 *
 * Tracks whether a Stellar transaction has been confirmed on-chain after the
 * frontend submits the signed XDR to Horizon.  Because the backend never
 * submits the XDR itself (Freighter does), finality tracking is best-effort:
 * we poll Horizon with exponential backoff until we get a definitive result
 * or the 10-minute window expires.
 *
 * Key design decisions:
 *   • Polling does NOT block the original submission response — it runs
 *     asynchronously in the background via startTracking().
 *   • Backoff: 100 ms → 200 → 400 → 800 → 1600 → 3200 → 5000 ms max,
 *     each interval jittered by ±25% to spread load across many tracked txns.
 *   • Hard stop after MAX_POLL_DURATION_MS (10 minutes); the record is then
 *     marked 'timeout' so the UI can surface a "stuck transaction" warning.
 *   • On every status change the service broadcasts a WebSocket message so
 *     connected contributors see updates in real time.
 *   • Horizon errors are treated as transient: we log a warning and retry
 *     unless the error indicates the transaction was genuinely rejected.
 */

import logger from "./logger.js";
import { pollHorizonTransaction } from "./stellar.js";
import {
  createFinalityRecord,
  setFinalityTxHash,
  incrementPollAttempt,
  markFinalityConfirmed,
  markFinalityFailed,
  markFinalityTimeout,
  getFinalityByTransactionId,
} from "./database/transaction-finality.js";
import { broadcastFinalityUpdate } from "./websocket.js";

// ─── Configuration ────────────────────────────────────────────────────────────

/** Base interval for the first poll after submission (ms). */
const BASE_POLL_MS = Number(process.env.FINALITY_BASE_POLL_MS) || 100;

/** Maximum interval between polls (ms). */
const MAX_POLL_MS = Number(process.env.FINALITY_MAX_POLL_MS) || 5_000;

/** How long we continue polling before giving up (ms). */
export const MAX_POLL_DURATION_MS = Number(process.env.FINALITY_MAX_DURATION_MS) || 10 * 60_000; // 10 minutes

/** Jitter fraction applied to each backoff interval (±JITTER_FACTOR). */
export const JITTER_FACTOR = 0.25;

// ─── Backoff helpers ──────────────────────────────────────────────────────────

/**
 * Compute the next backoff interval with full ± jitter.
 *
 * The sequence doubles from BASE_POLL_MS up to MAX_POLL_MS, then each step
 * is jittered by a random value in [-JITTER_FACTOR, +JITTER_FACTOR] of the
 * capped interval.  This ensures the result is always positive (can never go
 * below BASE_POLL_MS * (1 - JITTER_FACTOR)) and never exceeds
 * MAX_POLL_MS * (1 + JITTER_FACTOR).
 *
 * @param   {number} attempt  Zero-based attempt counter (0 = first poll)
 * @returns {number}          Milliseconds to wait before the next poll
 */
export function computeBackoffMs(attempt) {
  const base = Math.min(BASE_POLL_MS * Math.pow(2, attempt), MAX_POLL_MS);
  const jitter = base * JITTER_FACTOR * (Math.random() * 2 - 1); // ± JITTER_FACTOR * base
  return Math.round(base + jitter);
}

/**
 * Return a Promise that resolves after `ms` milliseconds.
 * @param {number} ms
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Active tracker registry ──────────────────────────────────────────────────

/** transactionId → AbortController — allows external cancellation. */
const _activeTrackers = new Map();

/**
 * Cancel an in-progress finality tracker for a given transaction.
 * The polling loop will detect the signal and stop gracefully.
 *
 * @param {number} transactionId
 * @returns {boolean} true if a tracker was found and cancelled
 */
export function cancelTracking(transactionId) {
  const controller = _activeTrackers.get(transactionId);
  if (!controller) return false;
  controller.abort();
  _activeTrackers.delete(transactionId);
  return true;
}

/**
 * Return true if a tracker is currently active for the given transactionId.
 * @param {number} transactionId
 */
export function isTracking(transactionId) {
  return _activeTrackers.has(transactionId);
}

// ─── Core polling loop ────────────────────────────────────────────────────────

/**
 * Internal polling loop.  Runs until the transaction settles, times out, or
 * the caller cancels via AbortSignal.
 *
 * @param {object}      opts
 * @param {number}      opts.transactionId
 * @param {string}      opts.txHash
 * @param {AbortSignal} opts.signal
 */
async function _pollLoop({ transactionId, txHash, signal }) {
  const deadline = Date.now() + MAX_POLL_DURATION_MS;
  let attempt = 0;

  logger.info("Finality polling started", { transactionId, txHash: txHash?.substring(0, 8) });

  while (Date.now() < deadline) {
    if (signal.aborted) {
      logger.info("Finality polling cancelled", { transactionId });
      return;
    }

    const waitMs = computeBackoffMs(attempt);
    const nextPollAt = new Date(Date.now() + waitMs);
    incrementPollAttempt(transactionId, nextPollAt);

    await delay(waitMs);

    if (signal.aborted) {
      logger.info("Finality polling cancelled during wait", { transactionId });
      return;
    }

    if (!txHash) {
      // Hash not yet known — try to read from DB in case it was set meanwhile
      const record = getFinalityByTransactionId(transactionId);
      if (record?.tx_hash) {
        txHash = record.tx_hash;
      } else {
        attempt++;
        continue;
      }
    }

    try {
      const result = await pollHorizonTransaction(txHash);

      if (result.status === "confirmed") {
        markFinalityConfirmed(transactionId, {
          firstConfirmationAt: result.createdAt ?? null,
          feePaid: result.feePaid ?? null,
        });

        broadcastFinalityUpdate(transactionId, {
          transactionId,
          txHash,
          status: "confirmed",
          confirmations: 1,
          feePaid: result.feePaid ?? null,
          firstConfirmationAt: result.createdAt ?? null,
        });

        logger.info("Finality confirmed", {
          transactionId,
          txHash: txHash.substring(0, 8),
          ledger: result.ledger,
          attempts: attempt + 1,
        });
        return;
      }

      if (result.status === "failed") {
        markFinalityFailed(transactionId, result.errorMessage ?? "Transaction failed on-chain");

        broadcastFinalityUpdate(transactionId, {
          transactionId,
          txHash,
          status: "failed",
          errorMessage: result.errorMessage ?? "Transaction failed on-chain",
        });

        logger.warn("Finality: transaction failed on-chain", {
          transactionId,
          txHash: txHash.substring(0, 8),
          attempts: attempt + 1,
        });
        return;
      }

      // Status "not_found" or other transient — keep polling
    } catch (err) {
      // 504-style timeout from pollHorizonTransaction is a single-poll
      // timeout, not a total timeout — we treat it as transient and keep going
      // unless we've hit our own deadline.
      if (err?.status === 504 && Date.now() < deadline) {
        logger.warn("Finality: Horizon poll timed out (transient), will retry", {
          transactionId,
          txHash: txHash?.substring(0, 8),
          attempt,
        });
      } else if (err?.status === 504) {
        // deadline exceeded on a horizon timeout — fall through to timeout below
        break;
      } else {
        // Unexpected error — log and keep retrying up to deadline
        logger.warn("Finality: Horizon poll error (will retry)", {
          transactionId,
          txHash: txHash?.substring(0, 8),
          attempt,
          error: err?.message ?? String(err),
        });
      }
    }

    attempt++;
  }

  // Deadline reached without settlement
  markFinalityTimeout(transactionId);

  broadcastFinalityUpdate(transactionId, {
    transactionId,
    txHash,
    status: "timeout",
    errorMessage: "Finality polling window (10 min) expired without confirmation",
  });

  logger.warn("Finality: polling timed out", {
    transactionId,
    txHash: txHash?.substring(0, 8),
    totalAttempts: attempt,
  });

  _activeTrackers.delete(transactionId);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Begin tracking finality for a transaction.
 *
 * Creates a finality record in the database and launches the background
 * polling loop. Returns immediately — does NOT await confirmation.
 *
 * @param {object}      opts
 * @param {number}      opts.transactionId  - FK to transactions(id)
 * @param {string|null} [opts.txHash]       - Horizon hash (may be provided later via updateTxHash)
 * @returns {number} finality record ID
 */
export function startTracking({ transactionId, txHash = null }) {
  if (_activeTrackers.has(transactionId)) {
    logger.warn("Finality tracking already active, ignoring duplicate start", { transactionId });
    return;
  }

  const recordId = createFinalityRecord(transactionId, txHash);

  const controller = new AbortController();
  _activeTrackers.set(transactionId, controller);

  // Fire-and-forget — errors are caught inside the loop
  _pollLoop({ transactionId, txHash, signal: controller.signal }).catch((err) => {
    logger.error("Finality poll loop crashed unexpectedly", {
      transactionId,
      error: err?.message ?? String(err),
    });
    _activeTrackers.delete(transactionId);
  });

  logger.info("Finality tracking started", { transactionId, txHash: txHash?.substring(0, 8), recordId });
  return recordId;
}

/**
 * Attach a Horizon tx hash to a tracked transaction.
 * Call this after the frontend submits the signed XDR and provides the hash
 * back to the backend (e.g. via the finality REST endpoint).
 *
 * @param {number} transactionId
 * @param {string} txHash
 */
export function updateTxHash(transactionId, txHash) {
  setFinalityTxHash(transactionId, txHash);
  logger.info("Finality: tx hash updated", { transactionId, txHash: txHash?.substring(0, 8) });
}
