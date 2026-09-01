/**
 * Contributor Verification Workflow routes — closes #602.
 *
 * GET  /api/v1/verification/:walletAddress
 *   Returns current verification step and status for a contributor.
 *
 * POST /api/v1/verification/start
 *   Body: { walletAddress }
 *   Initialises the verification workflow at the 'email' step.
 *
 * POST /api/v1/verification/advance
 *   Body: { walletAddress, step, status, adminNote? }
 *   Advances (or updates) the verification state.  Used by the frontend
 *   after email confirmation, KYC completion, or admin manual review.
 *
 * GET  /api/v1/verification/queue/:step
 *   Returns contributors waiting at a given step (for admin review queues).
 */

import { Router } from "express";
import { z } from "zod";
import { stellarAddress, parsePagination } from "../validation.js";
import { sendError, sendValidationError } from "../error-response.js";
import {
  getVerification,
  upsertVerification,
  getVerificationsByStep,
  VERIFICATION_STEPS,
  VERIFICATION_STATUSES,
} from "../database/index.js";

export const verificationRouter = Router();

const startSchema = z.object({
  walletAddress: stellarAddress,
});

const advanceSchema = z.object({
  walletAddress: stellarAddress,
  step:      z.enum(VERIFICATION_STEPS),
  status:    z.enum(VERIFICATION_STATUSES),
  adminNote: z.string().max(500).optional().nullable(),
});

// ─── GET /api/v1/verification/:walletAddress ───────────────────────────────

verificationRouter.get("/:walletAddress", (req, res) => {
  const { walletAddress } = req.params;

  if (!/^G[A-Z2-7]{55}$/.test(walletAddress)) {
    return sendError(res, 400, "invalid_stellar_address", "Invalid Stellar address format");
  }

  const record = getVerification(walletAddress);
  if (!record) {
    return sendError(res, 404, "verification_not_found", "No verification record found for this wallet");
  }

  return res.json({ success: true, data: record });
});

// ─── POST /api/v1/verification/start ──────────────────────────────────────

verificationRouter.post("/start", (req, res) => {
  const result = startSchema.safeParse(req.body);
  if (!result.success) {
    return sendValidationError(
      res,
      result.error.issues.map((e) => ({ field: e.path.join("."), message: e.message }))
    );
  }

  const { walletAddress } = result.data;

  // Idempotent — if already started, return current state rather than resetting.
  const existing = getVerification(walletAddress);
  if (existing) {
    return res.status(200).json({ success: true, data: existing });
  }

  const record = upsertVerification(walletAddress, "email", "pending");
  return res.status(201).json({ success: true, data: record });
});

// ─── POST /api/v1/verification/advance ────────────────────────────────────

verificationRouter.post("/advance", (req, res) => {
  const result = advanceSchema.safeParse(req.body);
  if (!result.success) {
    return sendValidationError(
      res,
      result.error.issues.map((e) => ({ field: e.path.join("."), message: e.message }))
    );
  }

  const { walletAddress, step, status, adminNote } = result.data;

  const record = upsertVerification(walletAddress, step, status, adminNote ?? null);
  return res.status(200).json({ success: true, data: record });
});

// ─── GET /api/v1/verification/queue/:step ─────────────────────────────────

verificationRouter.get("/queue/:step", (req, res) => {
  const { step } = req.params;

  if (!VERIFICATION_STEPS.includes(step)) {
    return sendError(
      res,
      400,
      "invalid_step",
      `step must be one of: ${VERIFICATION_STEPS.join(", ")}`
    );
  }

  const pagination = parsePagination(req.query, res);
  if (!pagination) return;

  const records = getVerificationsByStep(step, pagination.limit, pagination.offset);
  return res.json({ success: true, data: records, pagination });
});
