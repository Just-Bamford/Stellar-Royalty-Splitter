/**
 * SMS notification preferences route — closes #927.
 *
 * POST /api/v1/notifications/sms/preferences
 *   Body: { walletAddress, smsEnabled, phoneNumber? }
 *   Opts a wallet in/out of SMS notifications and stores its phone number.
 *   phoneNumber is required when smsEnabled is true (or already on file).
 *
 * GET /api/v1/notifications/sms/preferences?walletAddress=G...
 *   Returns the stored SMS preference (or the opted-out default).
 *
 * Mirrors the exact validation/response conventions of
 * `src/routes/notification-preferences.js`.
 */

import { Router } from "express";
import { z } from "zod";
import { stellarAddress } from "../../validation.js";
import { sendError, sendValidationError } from "../../error-response.js";
import { getSmsPreferences, saveSmsPreferences } from "../../database/sms-preferences.js";

export const smsPreferencesRouter = Router();

// E.164: optional leading +, 1-15 digits, first digit non-zero.
const E164_REGEX = /^\+?[1-9]\d{1,14}$/;

const savePreferencesSchema = z.object({
  walletAddress: stellarAddress,
  smsEnabled: z.boolean(),
  phoneNumber: z
    .string()
    .regex(E164_REGEX, "phoneNumber must be a valid E.164 phone number")
    .optional(),
});

// ─── GET /api/v1/notifications/sms/preferences ─────────────────────────────

smsPreferencesRouter.get("/preferences", (req, res) => {
  const { walletAddress } = req.query;

  if (!walletAddress || typeof walletAddress !== "string") {
    return sendError(res, 400, "missing_wallet_address", "walletAddress query parameter is required");
  }

  if (!/^G[A-Z2-7]{55}$/.test(walletAddress)) {
    return sendError(res, 400, "invalid_stellar_address", "Invalid Stellar address format");
  }

  const prefs = getSmsPreferences(walletAddress) ?? {
    walletAddress,
    smsEnabled: 0,
    phoneNumber: null,
    updatedAt: null,
  };

  return res.json({ success: true, data: prefs });
});

// ─── POST /api/v1/notifications/sms/preferences ────────────────────────────

smsPreferencesRouter.post("/preferences", (req, res) => {
  const result = savePreferencesSchema.safeParse(req.body);

  if (!result.success) {
    return sendValidationError(
      res,
      result.error.issues.map((e) => ({ field: e.path.join("."), message: e.message }))
    );
  }

  const { walletAddress, smsEnabled, phoneNumber } = result.data;

  // Opting in requires a phone number — either supplied on this call or
  // already on file from a previous save.
  if (smsEnabled) {
    const existing = getSmsPreferences(walletAddress);
    const effectivePhone = phoneNumber ?? existing?.phoneNumber ?? null;
    if (!effectivePhone) {
      return sendError(
        res,
        400,
        "phone_number_required",
        "phoneNumber is required to enable SMS notifications"
      );
    }
  }

  const saved = saveSmsPreferences(walletAddress, { smsEnabled, phoneNumber });
  return res.status(200).json({ success: true, data: saved });
});
