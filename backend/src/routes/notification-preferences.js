/**
 * Contributor Notification Preferences routes — closes #605.
 *
 * GET  /api/v1/preferences/notifications?walletAddress=G...
 *   Returns stored per-channel preferences (or defaults if none saved).
 *
 * POST /api/v1/preferences/notifications
 *   Body: { walletAddress, email?, sms?, inApp?, push? }
 *   Upserts (merges) the preference and returns the saved record.
 */

import { Router } from "express";
import { z } from "zod";
import { stellarAddress } from "../validation.js";
import { sendError, sendValidationError } from "../error-response.js";
import {
  getNotificationPreferences,
  saveNotificationPreferences,
} from "../database/index.js";

export const notificationPreferencesRouter = Router();

const saveSchema = z.object({
  walletAddress: stellarAddress,
  email: z.boolean().optional(),
  sms:   z.boolean().optional(),
  inApp: z.boolean().optional(),
  push:  z.boolean().optional(),
});

// ─── GET /api/v1/preferences/notifications ─────────────────────────────────

notificationPreferencesRouter.get("/notifications", (req, res) => {
  const { walletAddress } = req.query;

  if (!walletAddress || typeof walletAddress !== "string") {
    return sendError(res, 400, "missing_wallet_address", "walletAddress query parameter is required");
  }

  if (!/^G[A-Z2-7]{55}$/.test(walletAddress)) {
    return sendError(res, 400, "invalid_stellar_address", "Invalid Stellar address format");
  }

  // Return stored preferences or the default opt-in set.
  const prefs = getNotificationPreferences(walletAddress) ?? {
    walletAddress,
    email: 1,
    sms: 0,
    inApp: 1,
    push: 0,
    updatedAt: null,
  };

  return res.json({ success: true, data: prefs });
});

// ─── POST /api/v1/preferences/notifications ────────────────────────────────

notificationPreferencesRouter.post("/notifications", (req, res) => {
  const result = saveSchema.safeParse(req.body);

  if (!result.success) {
    return sendValidationError(
      res,
      result.error.issues.map((e) => ({ field: e.path.join("."), message: e.message }))
    );
  }

  const { walletAddress, ...channels } = result.data;

  // Require at least one channel key in the body so callers are explicit.
  if (Object.keys(channels).length === 0) {
    return sendError(
      res,
      400,
      "no_channels_provided",
      "Provide at least one channel (email, sms, inApp, push) to update"
    );
  }

  const saved = saveNotificationPreferences(walletAddress, channels);
  return res.status(200).json({ success: true, data: saved });
});
