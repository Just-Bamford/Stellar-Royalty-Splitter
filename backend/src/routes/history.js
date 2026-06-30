import express from "express";
import {
  getTransactionHistory,
  getTransactionCount,
  getTransactionDetails,
  getTransactionById,
  getAuditLog,
  addAuditLog,
  updateTransactionStatus,
  updateTransactionHash,
  archiveContractEvents,
  getArchivePolicy,
  getArchivedEventCount,
  getArchivedEvents,
  updateArchivePolicy,
} from "../database/index.js";
import {
  validateContractId,
  validateContractIdMiddleware,
  parsePagination,
} from "../validation.js";
import { sendError } from "../error-response.js";
import { pollHorizonTransaction } from "../stellar.js";
import { deliverDistributeWebhooks } from "../webhook-delivery.js";
import logger from "../logger.js";

const router = express.Router();

/**
 * GET /api/history/:contractId
 * Get transaction history for a contract
 * Query params: limit (default 50), offset (default 0)
 */
router.get("/history/:contractId", validateContractIdMiddleware, (req, res) => {
  try {
    const { contractId } = req.params;
    if (!validateContractId(contractId, res)) return;

    const pagination = parsePagination(req.query, res, 50, 100);
    if (!pagination) return;
    const { limit, offset } = pagination;

    const history = getTransactionHistory(contractId, limit, offset);
    const total = getTransactionCount(contractId);

    res.json({
      success: true,
      data: history,
      pagination: { limit, offset, total },
    });
  } catch (error) {
    logger.error("Error fetching transaction history:", error);
    sendError(res, 500, "internal_server_error", error.message ?? "Failed to fetch transaction history");
  }
});

/**
 * GET /api/archive/policy
 * Get contract event archive retention policy.
 */
router.get("/archive/policy", (_req, res) => {
  try {
    res.json({
      success: true,
      data: getArchivePolicy(),
    });
  } catch (error) {
    logger.error("Error fetching archive policy:", error);
    sendError(res, 500, "internal_server_error", error.message ?? "Failed to fetch archive policy");
  }
});

/**
 * POST /api/archive/policy
 * Update contract event archive retention policy.
 */
router.post("/archive/policy", (req, res) => {
  try {
    const { enabled, retentionDays } = req.body ?? {};

    if (enabled != null && typeof enabled !== "boolean") {
      return sendError(res, 400, "bad_request", "enabled must be a boolean");
    }

    if (retentionDays != null) {
      const parsedRetentionDays = Number.parseInt(retentionDays, 10);
      if (!Number.isInteger(parsedRetentionDays) || parsedRetentionDays <= 0) {
        return sendError(res, 400, "bad_request", "retentionDays must be a positive integer");
      }
    }

    res.json({
      success: true,
      data: updateArchivePolicy({ enabled, retentionDays }),
    });
  } catch (error) {
    logger.error("Error updating archive policy:", error);
    sendError(res, 500, "internal_server_error", error.message ?? "Failed to update archive policy");
  }
});

/**
 * POST /api/archive/run
 * Archive old contract events according to the configured policy.
 */
router.post("/archive/run", (req, res) => {
  try {
    const { batchSize } = req.body ?? {};
    const parsedBatchSize = batchSize == null ? undefined : Number.parseInt(batchSize, 10);

    if (batchSize != null && (!Number.isInteger(parsedBatchSize) || parsedBatchSize <= 0)) {
      return sendError(res, 400, "bad_request", "batchSize must be a positive integer");
    }

    res.json({
      success: true,
      data: archiveContractEvents({ batchSize: parsedBatchSize }),
    });
  } catch (error) {
    logger.error("Error archiving contract events:", error);
    sendError(res, 500, "internal_server_error", error.message ?? "Failed to archive contract events");
  }
});

/**
 * GET /api/archive/:contractId
 * Query archived contract events.
 * Query params: limit (default 50), offset (default 0)
 */
router.get("/archive/:contractId", validateContractIdMiddleware, (req, res) => {
  try {
    const { contractId } = req.params;
    if (!validateContractId(contractId, res)) return;

    const pagination = parsePagination(req.query, res, 50, 200);
    if (!pagination) return;
    const { limit, offset } = pagination;

    const archive = getArchivedEvents(contractId, limit, offset);
    const total = getArchivedEventCount(contractId);

    res.json({
      success: true,
      data: archive,
      pagination: { limit, offset, total },
    });
  } catch (error) {
    logger.error("Error fetching archived contract events:", error);
    sendError(res, 500, "internal_server_error", error.message ?? "Failed to fetch archived events");
  }
});

/**
 * GET /api/transaction/:txHash
 * Get details of a specific transaction including all payouts
 */
router.get("/transaction/:txHash", (req, res) => {
  try {
    const { txHash } = req.params;

    const transaction = getTransactionDetails(txHash);

    if (!transaction) {
      return sendError(res, 404, "not_found", "Transaction not found");
    }

    res.json({
      success: true,
      data: transaction,
    });
  } catch (error) {
    logger.error("Error fetching transaction details:", error);
    sendError(res, 500, "internal_server_error", error.message ?? "Failed to fetch transaction details");
  }
});

/**
 * POST /api/transaction/confirm/:txHash
 * Poll Horizon for ledger confirmation (#297), update the DB, and fire
 * distribute-completion webhooks (#295).
 */
router.post("/transaction/confirm/:txHash", async (req, res) => {
  try {
    const { txHash } = req.params;
    const { blockTime, errorMessage, transactionId } = req.body;

    // Validate transaction hash format (64 hex characters)
    if (!/^[0-9a-fA-F]{64}$/.test(txHash)) {
      return sendError(
        res,
        400,
        "invalid_transaction_hash",
        "Invalid transaction hash format. Expected 64 hexadecimal characters."
      );
    }

    let existing = getTransactionDetails(txHash);

    if (!existing && transactionId != null) {
      const parsedId = parseInt(transactionId, 10);
      if (Number.isNaN(parsedId) || parsedId <= 0) {
        return sendError(res, 400, "invalid_transaction_id", "Invalid transactionId");
      }

      const pending = getTransactionById(parsedId);
      if (!pending) {
        return sendError(res, 404, "not_found", "Transaction not found");
      }

      if (pending.status !== "pending") {
        return sendError(res, 409, "conflict", `Transaction already ${pending.status}`);
      }

      if (pending.txHash && pending.txHash !== txHash) {
        return sendError(res, 409, "conflict", "Transaction is already linked to a different hash");
      }

      updateTransactionHash(parsedId, txHash);
      existing = getTransactionDetails(txHash);
    }

    if (!existing) {
      return sendError(res, 404, "not_found", "Transaction not found");
    }

    // Prevent overwriting already-settled transactions
    if (existing.status !== "pending") {
      return sendError(res, 409, "conflict", `Transaction already ${existing.status}`);
    }

    let pollResult;
    try {
      pollResult = await pollHorizonTransaction(txHash);
    } catch (error) {
      const status = error?.status ?? 504;
      return sendError(res, status, undefined, error?.message ?? "Failed to confirm transaction on Horizon");
    }

    updateTransactionStatus(
      txHash,
      pollResult.status,
      blockTime ?? pollResult.createdAt ?? null,
      errorMessage ?? null,
    );

    const confirmed = getTransactionDetails(txHash);

    if (pollResult.status === "confirmed" && confirmed?.type === "distribute") {
      deliverDistributeWebhooks(confirmed);
    }

    res.json({
      success: true,
      status: pollResult.status,
      ledger: pollResult.ledger ?? null,
      message: `Transaction ${txHash.substring(0, 8)}... marked as ${pollResult.status}`,
    });
  } catch (error) {
    logger.error("Error updating transaction status:", error);
    sendError(res, 500, "internal_server_error", error.message ?? "Failed to update transaction status");
  }
});

/**
 * GET /api/audit/:contractId
 * Get audit log for a contract
 * Query params: limit (default 100), offset (default 0)
 */
router.get("/audit/:contractId", validateContractIdMiddleware, (req, res) => {
  try {
    const { contractId } = req.params;
    if (!validateContractId(contractId, res)) return;

    const pagination = parsePagination(req.query, res, 100, 200);
    if (!pagination) return;
    const { limit, offset } = pagination;

    const auditLog = getAuditLog(contractId, limit, offset);

    res.json({
      success: true,
      data: auditLog,
      pagination: { limit, offset },
    });
  } catch (error) {
    logger.error("Error fetching audit log:", error);
    sendError(res, 500, "internal_server_error", error.message ?? "Failed to fetch audit log");
  }
});

/**
 * POST /api/audit/:contractId
 * Add audit log entry
 */
router.post("/audit/:contractId", validateContractIdMiddleware, (req, res) => {
  try {
    const { contractId } = req.params;
    const { action, user, details } = req.body;

    if (!action) {
      return sendError(res, 400, "bad_request", "Action is required");
    }

    addAuditLog(contractId, action, user || "unknown", details || {});

    res.json({
      success: true,
      message: "Audit log entry created",
    });
  } catch (error) {
    logger.error("Error creating audit log entry:", error);
    sendError(res, 500, "internal_server_error", error.message ?? "Failed to create audit log entry");
  }
});

export default router;
