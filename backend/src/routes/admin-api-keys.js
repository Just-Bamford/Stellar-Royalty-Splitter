/**
 * API Rate Limit Dashboard routes — closes #608.
 *
 * All endpoints are protected by Bearer ADMIN_ROTATE_TOKEN.
 *
 * GET  /admin/api-keys/usage
 *   Returns current-window usage for every registered API key, including
 *   requests/minute, limit, % used, and an "approaching" flag.
 *
 * GET  /admin/api-keys/usage/:keyValue
 *   Returns current-window usage for one specific API key.
 *
 * GET  /admin/api-keys/usage/:keyValue/history
 *   Returns per-minute historical usage for one key.
 *   Query param: ?minutes=60 (1–1440, default 60)
 *
 * GET  /admin/api-keys/alerts
 *   Returns keys that are currently at or above the alert threshold.
 *
 * POST /admin/api-keys/register
 *   Register a new API key (with optional label) so it appears in the
 *   dashboard before it makes its first request.
 *
 * PATCH /admin/api-keys/:keyValue/limit
 *   Adjust the per-minute rate limit for a specific API key.
 *   Body: { limitPerMinute: number | null }
 *   Passing null reverts the key to the global default.
 */

import { Router } from "express";
import { z } from "zod";
import logger from "../logger.js";
import { sendError } from "../error-response.js";
import { validate } from "../validation.js";
import {
  DEFAULT_AUTH_LIMIT_PER_MINUTE,
  getAllApiKeysUsage,
  getApiKeyCurrentUsage,
  getApiKeyHistory,
  getApproachingLimitAlerts,
  registerApiKey,
  setApiKeyLimit,
  HISTORY_RETENTION_MINUTES,
} from "../database/rate-limit.js";

export const adminApiKeysRouter = Router();

// ─── Auth middleware ──────────────────────────────────────────────────────────

function extractBearerToken(req) {
  const header = req.get("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim();
}

function requireAdminToken(req, res, next) {
  const envToken = process.env.ADMIN_ROTATE_TOKEN;
  if (!envToken) {
    return sendError(
      res,
      503,
      "service_unavailable",
      "Admin operations are not configured on this server"
    );
  }
  const token = extractBearerToken(req);
  if (!token || token !== envToken) {
    return sendError(res, 401, "unauthorized", "Unauthorized");
  }
  next();
}

// ─── Validation schemas ───────────────────────────────────────────────────────

const adjustLimitSchema = z.object({
  limitPerMinute: z
    .union([
      z
        .number()
        .int("limitPerMinute must be an integer")
        .positive("limitPerMinute must be a positive integer"),
      z.null(),
    ])
    .describe("New per-minute limit, or null to restore the server default"),
});

const registerKeySchema = z.object({
  keyValue: z.string().min(1, "keyValue must not be empty").max(512, "keyValue too long"),
  label: z.string().max(255, "label must not exceed 255 characters").nullable().optional(),
});

// ─── GET /admin/api-keys/usage ────────────────────────────────────────────────

adminApiKeysRouter.get("/usage", requireAdminToken, (req, res) => {
  const keys = getAllApiKeysUsage();

  return res.json({
    success: true,
    defaultLimitPerMinute: DEFAULT_AUTH_LIMIT_PER_MINUTE,
    data: keys,
    count: keys.length,
  });
});

// ─── GET /admin/api-keys/alerts ───────────────────────────────────────────────

adminApiKeysRouter.get("/alerts", requireAdminToken, (req, res) => {
  const alerts = getApproachingLimitAlerts();

  return res.json({
    success: true,
    data: alerts,
    count: alerts.length,
  });
});

// ─── POST /admin/api-keys/register ───────────────────────────────────────────

adminApiKeysRouter.post(
  "/register",
  requireAdminToken,
  validate(registerKeySchema),
  (req, res) => {
    const { keyValue, label = null } = req.body;

    registerApiKey(keyValue, label);

    logger.info("API key registered via dashboard", { label });

    return res.status(201).json({
      success: true,
      message: "API key registered",
      data: { keyValue, label },
    });
  }
);

// ─── GET /admin/api-keys/usage/:keyValue ──────────────────────────────────────

adminApiKeysRouter.get("/usage/:keyValue", requireAdminToken, (req, res) => {
  const { keyValue } = req.params;

  const usage = getApiKeyCurrentUsage(keyValue);
  if (!usage) {
    return sendError(
      res,
      404,
      "api_key_not_found",
      `No usage data found for key: ${keyValue}`
    );
  }

  return res.json({ success: true, data: usage });
});

// ─── GET /admin/api-keys/usage/:keyValue/history ──────────────────────────────

adminApiKeysRouter.get("/usage/:keyValue/history", requireAdminToken, (req, res) => {
  const { keyValue } = req.params;
  const rawMinutes = req.query.minutes;

  if (rawMinutes !== undefined) {
    const parsed = parseInt(rawMinutes, 10);
    if (isNaN(parsed) || parsed < 1 || parsed > HISTORY_RETENTION_MINUTES) {
      return sendError(
        res,
        400,
        "invalid_query_parameter",
        `minutes must be an integer between 1 and ${HISTORY_RETENTION_MINUTES}`
      );
    }
  }

  const history = getApiKeyHistory(keyValue, rawMinutes);
  if (!history) {
    return sendError(
      res,
      404,
      "api_key_not_found",
      `No usage data found for key: ${keyValue}`
    );
  }

  return res.json({ success: true, data: history });
});

// ─── PATCH /admin/api-keys/:keyValue/limit ────────────────────────────────────

adminApiKeysRouter.patch(
  "/:keyValue/limit",
  requireAdminToken,
  validate(adjustLimitSchema),
  (req, res) => {
    const { keyValue } = req.params;
    const { limitPerMinute } = req.body;

    const updated = setApiKeyLimit(keyValue, limitPerMinute);
    if (!updated) {
      return sendError(
        res,
        404,
        "api_key_not_found",
        `No API key found matching: ${keyValue}`
      );
    }

    logger.info("API key rate limit adjusted", {
      keyValue,
      newLimit: limitPerMinute ?? "default",
    });

    return res.json({
      success: true,
      message:
        limitPerMinute === null
          ? `Rate limit for key reset to server default (${DEFAULT_AUTH_LIMIT_PER_MINUTE} req/min)`
          : `Rate limit for key set to ${limitPerMinute} req/min`,
      data: { keyValue, limitPerMinute: limitPerMinute ?? DEFAULT_AUTH_LIMIT_PER_MINUTE },
    });
  }
);
