/**
 * Transaction Fee Display routes — closes #606.
 *
 * GET  /api/v1/fees/:contractId
 *   Returns paginated fee records for a contract so contributors can see
 *   what Soroban resource fees were deducted from each distribution.
 *
 * GET  /api/v1/fees/transaction/:transactionId
 *   Returns the fee record for a single transaction.
 *
 * Fees are recorded directly by the distribute route via `recordTransactionFee`
 * (no public write endpoint).
 */

import { Router } from "express";
import { sendError } from "../error-response.js";
import { validateContractIdMiddleware, parsePagination } from "../validation.js";
import {
  getTransactionFee,
  getFeesByContract,
  getFeeCountByContract,
} from "../database/index.js";

export const feesRouter = Router();

// ─── GET /api/v1/fees/:contractId ──────────────────────────────────────────

feesRouter.get("/:contractId", validateContractIdMiddleware, (req, res) => {
  const { contractId } = req.params;
  const pagination = parsePagination(req.query, res, 50, 100);
  if (!pagination) return;

  const fees = getFeesByContract(contractId, pagination.limit, pagination.offset);
  const total = getFeeCountByContract(contractId);
  return res.json({ success: true, data: fees, pagination: { ...pagination, total } });
});

// ─── GET /api/v1/fees/transaction/:transactionId ───────────────────────────

feesRouter.get("/transaction/:transactionId", (req, res) => {
  const id = parseInt(req.params.transactionId, 10);
  if (isNaN(id) || id <= 0) {
    return sendError(res, 400, "invalid_transaction_id", "transactionId must be a positive integer");
  }

  const fee = getTransactionFee(id);
  if (!fee) {
    return sendError(res, 404, "fee_not_found", "No fee record found for this transaction");
  }

  return res.json({ success: true, data: fee });
});
