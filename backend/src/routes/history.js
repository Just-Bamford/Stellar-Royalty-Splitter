import express from "express";
import {
  getTransactionHistory,
  getTransactionCount,
  getTransactionHistoryCursor,
  getTransactionDetails,
  getTransactionById,
  getAuditLog,
  countAuditLog,
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
  parseCursorPagination,
  encodeCursor,
} from "../validation.js";
import { sendError } from "../error-response.js";
import { pollHorizonTransaction } from "../stellar.js";
import { deliverDistributeWebhooks } from "../webhook-delivery.js";
import logger from "../logger.js";
import { cacheSet, cacheKey, TTL } from "../cache.js";

const router = express.Router();

const VALID_HISTORY_TYPES = ["distribute", "initialize"];

/**
 * GET /api/history/:contractId
 * Get transaction history for a contract.
 * Query params: limit (default 50, max 100), offset (default 0), type (distribute|initialize)
 */
router.get("/history/:contractId", validateContractIdMiddleware, (req, res) => {
  try {
    const { contractId } = req.params;
    if (!validateContractId(contractId, res)) return;

    const { type, recipient, startDate, endDate } = req.query;

    if (type !== undefined && !VALID_HISTORY_TYPES.includes(type)) {
      return sendError(
        res,
        400,
        "invalid_query_parameter",
        `type must be one of: ${VALID_HISTORY_TYPES.join(", ")}`
      );
    }

    if (startDate !== undefined && isNaN(new Date(startDate).getTime())) {
      return sendError(
        res,
        400,
        "invalid_query_parameter",
        "Invalid startDate. Use ISO 8601 or YYYY-MM-DD format."
      );
    }

    if (endDate !== undefined && isNaN(new Date(endDate).getTime())) {
      return sendError(
        res,
        400,
        "invalid_query_parameter",
        "Invalid endDate. Use ISO 8601 or YYYY-MM-DD format."
      );
    }

    const filters = {};
    if (type) filters.type = type;
    if (recipient) filters.recipient = recipient;
    if (startDate) filters.startDate = startDate;
    if (endDate) filters.endDate = endDate;

    // Support cursor-based pagination via `cursor` param; fall back to offset/limit
    if (req.query.cursor) {
      const cursorPag = parseCursorPagination(req.query, res, 50, 100);
      if (!cursorPag) return;

      const { data, nextCursor } = getTransactionHistoryCursor(
        contractId, cursorPag.limit, cursorPag.cursor, filters
      );

      const body = {
        success: true,
        data,
        pagination: {
          limit: cursorPag.limit,
          nextCursor: nextCursor ? encodeCursor(nextCursor.timestamp, nextCursor.id) : null,
          hasMore: nextCursor !== null,
        },
      };

      const key = cacheKey("history", contractId, cursorPag.limit, req.query.cursor, JSON.stringify(filters));
      cacheSet(key, body, TTL.history);
      return res.json(body);
    }

    // Legacy offset/limit pagination (deprecated)
    const pagination = parsePagination(req.query, res, 50, 100);
    if (!pagination) return;
    const { limit, offset } = pagination;

    const history = getTransactionHistory(contractId, limit, offset, filters);
    const total = getTransactionCount(contractId, filters);

    const body = {
      success: true,
      data: history,
      pagination: {
        limit,
        offset,
        total,
        hasNextPage: offset + limit < total,
        hasPrevPage: offset > 0,
      },
      _deprecated: "Use cursor-based pagination: pass `cursor` from previous response's nextCursor",
    };

    const key = cacheKey("history", contractId, limit, offset, JSON.stringify(filters));
    cacheSet(key, body, TTL.history);
    res.json(body);
  } catch (error) {
    logger.error("Error fetching transaction history:", error);
    sendError(
      res,
      500,
      "internal_server_error",
      error.message ?? "Failed to fetch transaction history"
    );
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
    sendError(
      res,
      500,
      "internal_server_error",
      error.message ?? "Failed to update archive policy"
    );
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
    sendError(
      res,
      500,
      "internal_server_error",
      error.message ?? "Failed to archive contract events"
    );
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
    sendError(
      res,
      500,
      "internal_server_error",
      error.message ?? "Failed to fetch archived events"
    );
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
    sendError(
      res,
      500,
      "internal_server_error",
      error.message ?? "Failed to fetch transaction details"
    );
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
      return sendError(
        res,
        status,
        undefined,
        error?.message ?? "Failed to confirm transaction on Horizon"
      );
    }

    updateTransactionStatus(
      txHash,
      pollResult.status,
      blockTime ?? pollResult.createdAt ?? null,
      errorMessage ?? null
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
    sendError(
      res,
      500,
      "internal_server_error",
      error.message ?? "Failed to update transaction status"
    );
  }
});

/**
 * GET /api/audit/:contractId
 * Get audit log for a contract
 * Query params: limit (default 50), offset (default 0), action, user, startDate, endDate, search
 */
router.get("/audit/:contractId", validateContractIdMiddleware, (req, res) => {
  try {
    const { contractId } = req.params;
    if (!validateContractId(contractId, res)) return;

    const pagination = parsePagination(req.query, res, 50, 200);
    if (!pagination) return;
    const { limit, offset } = pagination;

    const { action, user, startDate, endDate, search } = req.query;

    const filters = {};
    if (action) filters.action = action;
    if (user) filters.user = user;
    if (startDate) filters.startDate = startDate;
    if (endDate) filters.endDate = endDate;
    if (search) filters.search = search;

    const auditLog = getAuditLog(contractId, limit, offset, filters);
    const total = countAuditLog(contractId, filters);

    res.json({
      success: true,
      data: auditLog,
      pagination: { limit, offset, total },
    });
  } catch (error) {
    logger.error("Error fetching audit log:", error);
    sendError(res, 500, "internal_server_error", error.message ?? "Failed to fetch audit log");
  }
});

// NOTE: There is intentionally no public POST /api/audit/:contractId route.
// Audit entries must only ever be written server-side as a side effect of a
// real configuration/administrative action (see buildAndRecordTransaction in
// ./_shared.js and the addAuditLog(...) calls in initialize.js, distribute.js,
// and secondary-royalty.js). Accepting an audit entry directly from a client
// request body — as a prior version of this endpoint did — would let anyone
// forge arbitrary history against a contract. The GET route below remains the
// only public audit surface, and it is read-only.

export default router;
