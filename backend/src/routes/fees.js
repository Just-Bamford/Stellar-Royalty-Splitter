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
 * POST /api/v1/fees/record
 *   Records (or updates) the simulated fee for a transaction.
 *   Called automatically by the distribute route after simulation.
 */

import { Router } from "express";
import { z } from "zod";
import { sendError, sendValidationError } from "../error-response.js";
import { validateContractIdMiddleware, parsePagination } from "../validation.js";
import {
  recordTransactionFee,
  getTransactionFee,
  getFeesByContract,
} from "../database/index.js";

export const feesRouter = Router();

const recordFeeSchema = z.object({
  transactionId: z.number().int().positive(),
  contractId: z
    .string()
    .regex(/^C[A-Z2-7]{55}$/, "Invalid contract address"),
  feeStroops: z.union([
    z.number().int().min(0),
    z.string().regex(/^\d+$/, "feeStroops must be a non-negative integer string"),
  ]),
});

// ─── GET /api/v1/fees/:contractId ──────────────────────────────────────────

feesRouter.get("/:contractId", validateContractIdMiddleware, (req, res) => {
  const { contractId } = req.params;
  const pagination = parsePagination(req.query, res);
  if (!pagination) return;

  const fees = getFeesByContract(contractId, pagination.limit, pagination.offset);
  return res.json({ success: true, data: fees, pagination });
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

// ─── POST /api/v1/fees/record ──────────────────────────────────────────────

feesRouter.post("/record", (req, res) => {
  const result = recordFeeSchema.safeParse(req.body);
  if (!result.success) {
    return sendValidationError(
      res,
      result.error.issues.map((e) => ({ field: e.path.join("."), message: e.message }))
    );
  }

  const { transactionId, contractId, feeStroops } = result.data;
  const saved = recordTransactionFee(transactionId, contractId, feeStroops);
  return res.status(200).json({ success: true, data: saved });
});
