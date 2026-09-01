/**
 * Payment Preferences route — closes #584
 *
 * GET  /api/v1/preferences/payment?walletAddress=G...
 *   Returns the stored preference (or a 404 if none).
 *
 * POST /api/v1/preferences/payment
 *   Body: { walletAddress: "G...", paymentMethod: "direct_transfer" | "usdc" | "xlm" }
 *   Upserts the preference and returns the saved record.
 */

import { Router } from "express";
import { z } from "zod";
import { stellarAddress } from "../validation.js";
import { sendError, sendValidationError } from "../error-response.js";
import {
  getPaymentPreference,
  savePaymentPreference,
} from "../database/index.js";

export const preferencesRouter = Router();

const PAYMENT_METHODS = ["direct_transfer", "usdc", "xlm"];

const savePreferenceSchema = z.object({
  walletAddress: stellarAddress,
  paymentMethod: z.enum(["direct_transfer", "usdc", "xlm"], {
    errorMap: () => ({
      message: `paymentMethod must be one of: ${PAYMENT_METHODS.join(", ")}`,
    }),
  }),
});

// ─── GET /api/v1/preferences/payment ───────────────────────────────────────

preferencesRouter.get("/payment", (req, res) => {
  const { walletAddress } = req.query;

  if (!walletAddress || typeof walletAddress !== "string") {
    return sendError(
      res,
      400,
      "missing_wallet_address",
      "walletAddress query parameter is required"
    );
  }

  if (!/^G[A-Z2-7]{55}$/.test(walletAddress)) {
    return sendError(
      res,
      400,
      "invalid_stellar_address",
      "Invalid Stellar address format"
    );
  }

  const preference = getPaymentPreference(walletAddress);

  if (!preference) {
    return sendError(
      res,
      404,
      "preference_not_found",
      "No payment preference found for this wallet address"
    );
  }

  return res.json({ success: true, data: preference });
});

// ─── POST /api/v1/preferences/payment ──────────────────────────────────────

preferencesRouter.post("/payment", (req, res) => {
  const result = savePreferenceSchema.safeParse(req.body);

  if (!result.success) {
    return sendValidationError(
      res,
      result.error.issues.map((e) => ({
        field: e.path.join("."),
        message: e.message,
      }))
    );
  }

  const { walletAddress, paymentMethod } = result.data;
  const saved = savePaymentPreference(walletAddress, paymentMethod);

  return res.status(200).json({ success: true, data: saved });
});
