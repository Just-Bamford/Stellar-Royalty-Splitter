import express from "express";
import { sendError } from "../error-response.js";
import {
  subscribeEmailDigest,
  unsubscribeByEmailDigest,
  getSubscriberByToken,
  getSubscriberByWallet,
  updateSubscriberPreferences,
  getDigestHistory,
} from "../database/email-digest.js";
import { isEmailConfigured } from "../email/email-service.js";
import {
  validate,
  emailDigestSubscribeSchema,
  emailDigestPreferencesSchema,
  parsePagination,
} from "../validation.js";
import logger from "../logger.js";

const router = express.Router();

router.post("/email-digest/subscribe", validate(emailDigestSubscribeSchema), (req, res) => {
  try {
    if (!isEmailConfigured()) {
      return sendError(res, 503, "email_not_configured", "Email service is not configured on this server");
    }

    const { walletAddress, email, timezone, dayOfWeek, hourOfDay } = req.body;

    const subscriber = subscribeEmailDigest({
      walletAddress,
      email,
      timezone: timezone ?? "UTC",
      dayOfWeek: dayOfWeek ?? 0,
      hourOfDay: hourOfDay ?? 9,
    });

    res.status(201).json({
      success: true,
      message: "Subscribed to weekly email digest",
      subscriber: {
        walletAddress: subscriber.walletAddress,
        email: subscriber.email,
        timezone: subscriber.timezone,
        dayOfWeek: subscriber.dayOfWeek,
        hourOfDay: subscriber.hourOfDay,
        enabled: !!subscriber.enabled,
      },
    });
  } catch (error) {
    logger.error("Error subscribing to email digest:", error);
    sendError(res, 500, "internal_server_error", error.message ?? "Failed to subscribe");
  }
});

router.get("/email-digest/preferences/:walletAddress", (req, res) => {
  try {
    const { walletAddress } = req.params;
    if (!/^G[A-Z2-7]{55}$/.test(walletAddress)) {
      return sendError(res, 400, "invalid_stellar_address", "Invalid Stellar address format");
    }

    const subscriber = getSubscriberByWallet(walletAddress);
    if (!subscriber) {
      return sendError(res, 404, "not_found", "No email digest subscription found for this wallet");
    }

    res.json({
      success: true,
      subscriber: {
        walletAddress: subscriber.walletAddress,
        email: subscriber.email,
        timezone: subscriber.timezone,
        dayOfWeek: subscriber.dayOfWeek,
        hourOfDay: subscriber.hourOfDay,
        enabled: !!subscriber.enabled,
      },
    });
  } catch (error) {
    logger.error("Error fetching email digest preferences:", error);
    sendError(res, 500, "internal_server_error", error.message ?? "Failed to fetch preferences");
  }
});

router.put("/email-digest/preferences", validate(emailDigestPreferencesSchema), (req, res) => {
  try {
    const { walletAddress, email, timezone, dayOfWeek, hourOfDay } = req.body;

    const updated = updateSubscriberPreferences({
      walletAddress,
      email: email ?? null,
      timezone: timezone ?? null,
      dayOfWeek: dayOfWeek ?? null,
      hourOfDay: hourOfDay ?? null,
    });

    if (!updated) {
      return sendError(res, 404, "not_found", "No active subscription found for this wallet");
    }

    res.json({
      success: true,
      message: "Preferences updated",
    });
  } catch (error) {
    logger.error("Error updating email digest preferences:", error);
    sendError(res, 500, "internal_server_error", error.message ?? "Failed to update preferences");
  }
});

router.post("/email-digest/unsubscribe", (req, res) => {
  try {
    const { token } = req.body;
    if (!token || typeof token !== "string") {
      return sendError(res, 400, "validation_failed", "Unsubscribe token is required");
    }

    const subscriber = getSubscriberByToken(token);
    if (!subscriber) {
      return sendError(res, 404, "not_found", "Invalid unsubscribe token");
    }

    if (!subscriber.enabled) {
      return res.json({
        success: true,
        message: "Already unsubscribed",
      });
    }

    unsubscribeByEmailDigest(token);

    res.json({
      success: true,
      message: "Successfully unsubscribed from weekly email digests",
    });
  } catch (error) {
    logger.error("Error unsubscribing from email digest:", error);
    sendError(res, 500, "internal_server_error", error.message ?? "Failed to unsubscribe");
  }
});

router.get("/email-digest/history/:walletAddress", (req, res) => {
  try {
    const { walletAddress } = req.params;
    if (!/^G[A-Z2-7]{55}$/.test(walletAddress)) {
      return sendError(res, 400, "invalid_stellar_address", "Invalid Stellar address format");
    }

    const subscriber = getSubscriberByWallet(walletAddress);
    if (!subscriber) {
      return sendError(res, 404, "not_found", "No email digest subscription found for this wallet");
    }

    const pagination = parsePagination(req.query, res, 10, 100);
    if (!pagination) return;
    const { limit, offset } = pagination;

    const history = getDigestHistory(subscriber.id, limit, offset);

    res.json({
      success: true,
      data: history.map((h) => ({
        id: h.id,
        weekStart: h.weekStart,
        weekEnd: h.weekEnd,
        sentAt: h.sentAt,
        status: h.status,
        earningsSummary: JSON.parse(h.earningsSummary),
      })),
      pagination: { limit, offset },
    });
  } catch (error) {
    logger.error("Error fetching email digest history:", error);
    sendError(res, 500, "internal_server_error", error.message ?? "Failed to fetch history");
  }
});

export default router;
