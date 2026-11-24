import { Router } from "express";
import { sendError } from "../error-response.js";
import { requireRole } from "../middleware/rbac.js";
import {
  placeHold,
  releaseHold,
  approveHoldRelease,
  getTransactionWithHold,
  getHeldTransactions,
  getAllHeldTransactions,
  getHoldAuditTrail,
  getTransactionsPendingHoldRelease,
} from "../database/payment-holds.js";
import { addAuditLog } from "../database/audit.js";

export const paymentHoldsRouter = Router();

function parsePositiveTransactionId(req, res) {
  const id = parseInt(req.params.transactionId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    sendError(res, 400, "invalid_parameter", "Transaction ID must be a positive integer");
    return null;
  }
  return id;
}

paymentHoldsRouter.post("/place", requireRole("admin"), (req, res) => {
  try {
    const { transactionId, holdReason, holdUntil } = req.body;
    if (!transactionId || !holdReason) {
      return sendError(res, 400, "validation_error", "transactionId and holdReason are required");
    }
    const actor = req.user?.walletAddress ?? req.user?.id ?? "unknown";
    const result = placeHold(transactionId, holdReason, holdUntil ?? null, actor);
    if (!result) {
      return sendError(res, 404, "not_found", "Transaction not found");
    }
    addAuditLog(result.contractId, "payment_hold_placed", actor, JSON.stringify({ transactionId, holdReason, holdUntil }));
    res.json({ success: true, data: result });
  } catch (err) {
    sendError(res, 500, "hold_place_error", err.message);
  }
});

paymentHoldsRouter.post("/release", requireRole("admin"), (req, res) => {
  try {
    const { transactionId, approvalNote } = req.body;
    if (!transactionId) {
      return sendError(res, 400, "validation_error", "transactionId is required");
    }
    const actor = req.user?.walletAddress ?? req.user?.id ?? "unknown";
    const result = releaseHold(transactionId, actor, approvalNote ?? null);
    if (!result) {
      return sendError(res, 404, "not_found", "Transaction not found or not on hold");
    }
    addAuditLog(result.contractId, "payment_hold_released", actor, JSON.stringify({ transactionId, approvalNote }));
    res.json({ success: true, data: result });
  } catch (err) {
    sendError(res, 500, "hold_release_error", err.message);
  }
});

paymentHoldsRouter.post("/approve-release", requireRole("admin"), (req, res) => {
  try {
    const { transactionId, approvalNote } = req.body;
    if (!transactionId) {
      return sendError(res, 400, "validation_error", "transactionId is required");
    }
    const actor = req.user?.walletAddress ?? req.user?.id ?? "unknown";
    const result = approveHoldRelease(transactionId, actor, approvalNote ?? null);
    if (!result) {
      return sendError(res, 404, "not_found", "Transaction not found or not on hold");
    }
    addAuditLog(result.contractId, "hold_release_approved", actor, JSON.stringify({ transactionId, approvalNote }));
    res.json({ success: true, data: result });
  } catch (err) {
    sendError(res, 500, "approve_error", err.message);
  }
});

paymentHoldsRouter.get("/transaction/:transactionId", (req, res) => {
  const id = parsePositiveTransactionId(req, res);
  if (id === null) return;
  try {
    const result = getTransactionWithHold(id);
    if (!result) {
      return sendError(res, 404, "not_found", "Transaction not found");
    }
    const auditTrail = getHoldAuditTrail(id);
    res.json({ success: true, data: { ...result, auditTrail } });
  } catch (err) {
    sendError(res, 500, "fetch_error", err.message);
  }
});

paymentHoldsRouter.get("/contract/:contractId", (req, res) => {
  try {
    const status = req.query.status ?? "active";
    const transactions = getHeldTransactions(req.params.contractId, status);
    res.json({ success: true, data: transactions, count: transactions.length });
  } catch (err) {
    sendError(res, 500, "fetch_error", err.message);
  }
});

paymentHoldsRouter.get("/all", requireRole("admin"), (req, res) => {
  try {
    const status = req.query.status ?? "active";
    const transactions = getAllHeldTransactions(status);
    res.json({ success: true, data: transactions, count: transactions.length });
  } catch (err) {
    sendError(res, 500, "fetch_error", err.message);
  }
});

paymentHoldsRouter.get("/pending-release", requireRole("admin"), (_req, res) => {
  try {
    const transactions = getTransactionsPendingHoldRelease();
    res.json({ success: true, data: transactions, count: transactions.length });
  } catch (err) {
    sendError(res, 500, "fetch_error", err.message);
  }
});

paymentHoldsRouter.get("/audit/:transactionId", (req, res) => {
  const id = parsePositiveTransactionId(req, res);
  if (id === null) return;
  try {
    const auditTrail = getHoldAuditTrail(id);
    res.json({ success: true, data: auditTrail });
  } catch (err) {
    sendError(res, 500, "audit_error", err.message);
  }
});
