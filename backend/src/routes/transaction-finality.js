/**
 * Transaction finality REST endpoints — closes #finality.
 *
 * POST /api/v1/transactions/:id/finality
 *   Start tracking finality for a transaction. Optionally accepts the
 *   Horizon tx hash when the frontend has just submitted the signed XDR.
 *   Returns the current finality record immediately without blocking.
 *
 * GET /api/v1/transactions/:id/finality
 *   Return the current finality status for a transaction.
 *
 * DELETE /api/v1/transactions/:id/finality
 *   Cancel in-progress finality polling for a transaction.
 */

import { Router } from "express";
import { sendError } from "../error-response.js";
import { getTransactionById } from "../database/index.js";
import {
  getFinalityByTransactionId,
  setFinalityTxHash,
} from "../database/transaction-finality.js";
import {
  startTracking,
  updateTxHash,
  cancelTracking,
  isTracking,
} from "../transaction-finality.js";
import logger from "../logger.js";

export const transactionFinalityRouter = Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse and validate the :id path param as a positive integer.
 * Returns null and sends a 400 on failure.
 *
 * @param {object} req
 * @param {object} res
 * @returns {number|null}
 */
function parseTransactionId(req, res) {
  const raw = req.params.id;
  const id = parseInt(raw, 10);
  if (!Number.isFinite(id) || id <= 0 || String(id) !== raw) {
    sendError(res, 400, "invalid_param", "Transaction ID must be a positive integer");
    return null;
  }
  return id;
}

// ─── POST /api/v1/transactions/:id/finality ───────────────────────────────────

/**
 * Start (or re-join) finality tracking for a transaction.
 *
 * Body (optional):
 *   { txHash: string }   — Horizon hash, if the frontend just submitted
 *
 * Response 200:
 *   {
 *     transactionId, txHash, status, confirmations, feePaid,
 *     submissionAt, firstConfirmationAt, finalStatus, finalStatusAt,
 *     errorMessage, pollAttempts, tracking
 *   }
 */
transactionFinalityRouter.post("/:id/finality", async (req, res) => {
  const transactionId = parseTransactionId(req, res);
  if (transactionId === null) return;

  try {
    // Verify the parent transaction exists
    const tx = getTransactionById(transactionId);
    if (!tx) {
      return sendError(res, 404, "not_found", `Transaction ${transactionId} not found`);
    }

    const { txHash } = req.body ?? {};

    // Validate txHash format if provided
    if (txHash !== undefined && (typeof txHash !== "string" || !/^[0-9a-fA-F]{64}$/.test(txHash))) {
      return sendError(res, 400, "invalid_param", "txHash must be a 64-character hex string");
    }

    // Check whether we already have a finality record
    let record = getFinalityByTransactionId(transactionId);

    if (!record) {
      // New record — start tracking
      startTracking({ transactionId, txHash: txHash ?? null });
      record = getFinalityByTransactionId(transactionId);
    } else {
      // Record exists — update hash if newly provided
      if (txHash && !record.tx_hash) {
        updateTxHash(transactionId, txHash);
        record = getFinalityByTransactionId(transactionId);
      }

      // If it's still pending and not being tracked, restart the poller
      if (record.status === "pending" && !isTracking(transactionId)) {
        startTracking({ transactionId, txHash: record.tx_hash ?? txHash ?? null });
      }
    }

    logger.info("Finality tracking requested", {
      transactionId,
      txHash: txHash?.substring(0, 8),
      status: record?.status,
    });

    return res.json(formatFinalityRecord(record, transactionId));
  } catch (err) {
    logger.error("Error starting finality tracking", {
      transactionId,
      error: err?.message ?? String(err),
    });
    return sendError(res, 500, "internal_error", "Failed to start finality tracking");
  }
});

// ─── GET /api/v1/transactions/:id/finality ────────────────────────────────────

/**
 * Get the current finality status for a transaction.
 *
 * Response 200: same shape as POST
 * Response 404: transaction or finality record not found
 */
transactionFinalityRouter.get("/:id/finality", (req, res) => {
  const transactionId = parseTransactionId(req, res);
  if (transactionId === null) return;

  try {
    const tx = getTransactionById(transactionId);
    if (!tx) {
      return sendError(res, 404, "not_found", `Transaction ${transactionId} not found`);
    }

    const record = getFinalityByTransactionId(transactionId);
    if (!record) {
      return sendError(
        res,
        404,
        "not_found",
        `No finality record found for transaction ${transactionId}. Use POST to start tracking.`
      );
    }

    return res.json(formatFinalityRecord(record, transactionId));
  } catch (err) {
    logger.error("Error fetching finality record", {
      transactionId,
      error: err?.message ?? String(err),
    });
    return sendError(res, 500, "internal_error", "Failed to fetch finality status");
  }
});

// ─── DELETE /api/v1/transactions/:id/finality ─────────────────────────────────

/**
 * Cancel in-progress finality polling for a transaction.
 *
 * Response 200: { cancelled: true|false, transactionId }
 */
transactionFinalityRouter.delete("/:id/finality", (req, res) => {
  const transactionId = parseTransactionId(req, res);
  if (transactionId === null) return;

  try {
    const cancelled = cancelTracking(transactionId);
    return res.json({ cancelled, transactionId });
  } catch (err) {
    logger.error("Error cancelling finality tracking", {
      transactionId,
      error: err?.message ?? String(err),
    });
    return sendError(res, 500, "internal_error", "Failed to cancel finality tracking");
  }
});

// ─── Response formatter ───────────────────────────────────────────────────────

/**
 * Normalize a DB row into the public API shape.
 *
 * @param {object|null} record
 * @param {number}      transactionId
 * @returns {object}
 */
function formatFinalityRecord(record, transactionId) {
  if (!record) {
    return {
      transactionId,
      status: "unknown",
      tracking: false,
    };
  }

  return {
    transactionId: record.transaction_id,
    txHash: record.tx_hash ?? null,
    status: record.status,
    confirmations: record.confirmations,
    feePaid: record.fee_paid ?? null,
    submissionAt: record.submission_at,
    firstConfirmationAt: record.first_confirmation_at ?? null,
    finalStatus: record.final_status ?? null,
    finalStatusAt: record.final_status_at ?? null,
    errorMessage: record.error_message ?? null,
    pollAttempts: record.poll_attempts,
    tracking: isTracking(record.transaction_id),
  };
}
