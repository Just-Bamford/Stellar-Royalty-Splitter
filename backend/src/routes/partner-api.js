/**
 * Partner API routes — third-party marketplace integrations, metering and
 * analytics (#996).
 *
 * Public partner surface (requires an `x-api-key` partner key):
 *   GET /api/v1/partner/me              — key identity, tier and live quota
 *   GET /api/v1/partner/usage           — this partner's calls over time
 *   GET /api/v1/partner/usage/endpoints — this partner's top endpoints
 *   GET /api/v1/partner/errors          — this partner's error rates
 *   GET /api/v1/partner/pricing         — tier catalogue (no key required)
 *
 * Operator/admin surface (RBAC `operator` or higher):
 *   POST    /api/v1/partner/keys              — issue a key
 *   GET     /api/v1/partner/keys              — list keys
 *   PATCH   /api/v1/partner/keys/:id          — change tier / limits / price
 *   DELETE  /api/v1/partner/keys/:id          — revoke a key
 *   GET     /api/v1/partner/analytics         — full dashboard payload
 *   GET     /api/v1/partner/analytics/revenue — revenue per partner
 *   GET     /api/v1/partner/analytics/overview — headline counters
 *
 * The router is wrapped by `apiKeyAuth()` + `partnerRateLimit()` +
 * `meterApiCall()` where it is mounted in index.js, so every call is metered
 * and the tier quota is enforced before a handler runs.
 */

import { Router } from "express";
import { z } from "zod";
import { sendError } from "../error-response.js";
import { validate, validateQuery } from "../validation.js";
import { requireRole } from "../middleware/rbac.js";
import { apiKeyAuth } from "../middleware/api-key-auth.js";
import {
  TIERS,
  checkRateLimit,
  getAnalyticsDashboard,
  getErrorRates,
  getPartnerOverview,
  getPricingTiers,
  getRevenueByPartner,
  getTopEndpoints,
  getUsageOverTime,
  issueApiKey,
  listApiKeys,
  revokeApiKey,
  updateApiKey,
} from "../services/api-metering.js";

export const partnerApiRouter = Router();

const requirePartnerKey = apiKeyAuth({ required: true });
const requireOperator = requireRole("operator");

// ─── Validation schemas ───────────────────────────────────────────────────────

const daysSchema = z.coerce
  .number()
  .int("days must be an integer")
  .min(1, "days must be at least 1")
  .max(365, "days must be 365 or less");

const issueKeySchema = z.object({
  partnerId: z
    .string()
    .min(1, "partnerId is required")
    .max(128, "partnerId must not exceed 128 characters"),
  partnerName: z
    .string()
    .min(1, "partnerName is required")
    .max(128, "partnerName must not exceed 128 characters"),
  tier: z.enum(TIERS).default("free"),
  dailyCallLimit: z.number().int().positive().nullable().optional(),
  monthlyCallLimit: z.number().int().positive().nullable().optional(),
  monthlyPriceCents: z.number().int().nonnegative().nullable().optional(),
  expiresAt: z.string().max(64).nullable().optional(),
});

const updateKeySchema = z.object({
  tier: z.enum(TIERS).optional(),
  dailyCallLimit: z.number().int().positive().nullable().optional(),
  monthlyCallLimit: z.number().int().positive().nullable().optional(),
  monthlyPriceCents: z.number().int().nonnegative().nullable().optional(),
});

const analyticsQuerySchema = z.object({
  days: daysSchema.optional(),
  partnerId: z.string().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

// ─── Public partner surface ───────────────────────────────────────────────────

/** GET /api/v1/partner/pricing — tier catalogue and usage-based pricing. */
partnerApiRouter.get("/pricing", (_req, res) =>
  res.json({ success: true, data: { tiers: getPricingTiers() } })
);

/** GET /api/v1/partner/me — identity, tier and live quota for the caller. */
partnerApiRouter.get("/me", requirePartnerKey, (req, res) => {
  const quota = checkRateLimit(req.apiKey, { skipMetering: true });

  return res.json({
    success: true,
    data: {
      keyId: req.apiKey.keyId,
      partnerId: req.apiKey.partnerId,
      partnerName: req.apiKey.partnerName,
      tier: req.apiKey.tier,
      createdAt: req.apiKey.createdAt,
      expiresAt: req.apiKey.expiresAt,
      limits: {
        dailyLimit: quota.dailyLimit,
        monthlyLimit: quota.monthlyLimit,
      },
      usage: {
        dailyUsed: quota.dailyUsed,
        monthlyUsed: quota.monthlyUsed,
        window: quota.window,
        limit: quota.limit,
        remaining: quota.remaining,
        percentUsed: quota.percentUsed,
        resetsAt: quota.resetsAt,
      },
    },
  });
});

/** GET /api/v1/partner/usage?days=30 — calls over time for the caller's key. */
partnerApiRouter.get(
  "/usage",
  requirePartnerKey,
  validateQuery(analyticsQuerySchema),
  (req, res) =>
    res.json({
      success: true,
      data: getUsageOverTime({ partnerId: req.apiKey.partnerId, days: req.query.days }),
    })
);

/** GET /api/v1/partner/usage/endpoints?days=30&limit=10 */
partnerApiRouter.get(
  "/usage/endpoints",
  requirePartnerKey,
  validateQuery(analyticsQuerySchema),
  (req, res) =>
    res.json({
      success: true,
      data: getTopEndpoints({
        partnerId: req.apiKey.partnerId,
        days: req.query.days,
        limit: req.query.limit,
      }),
    })
);

/** GET /api/v1/partner/errors?days=30 */
partnerApiRouter.get(
  "/errors",
  requirePartnerKey,
  validateQuery(analyticsQuerySchema),
  (req, res) =>
    res.json({
      success: true,
      data: getErrorRates({ partnerId: req.apiKey.partnerId, days: req.query.days }),
    })
);

// ─── Operator/admin surface ───────────────────────────────────────────────────

/** POST /api/v1/partner/keys — issue a key. The plaintext is returned once. */
partnerApiRouter.post("/keys", requireOperator, validate(issueKeySchema), (req, res) => {
  const issued = issueApiKey(req.body);

  return res.status(201).json({
    success: true,
    message: "API key issued. Store it now — the plaintext value is never shown again.",
    data: issued,
  });
});

/** GET /api/v1/partner/keys?partnerId=… */
partnerApiRouter.get("/keys", requireOperator, (req, res) => {
  const { partnerId } = req.query;
  const keys = listApiKeys({ partnerId });

  return res.json({ success: true, count: keys.length, data: keys });
});

/** PATCH /api/v1/partner/keys/:id — change tier, limits or negotiated price. */
partnerApiRouter.patch("/keys/:id", requireOperator, validate(updateKeySchema), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    return sendError(res, 400, "invalid_key_id", "Key id must be an integer");
  }

  let updated;
  try {
    updated = updateApiKey(id, req.body);
  } catch (error) {
    return sendError(res, 400, "invalid_tier", error.message);
  }

  if (!updated) {
    return sendError(res, 404, "api_key_not_found", `No API key with id ${id}`);
  }

  return res.json({ success: true, message: "API key updated", data: updated });
});

/** DELETE /api/v1/partner/keys/:id — revoke a key. */
partnerApiRouter.delete("/keys/:id", requireOperator, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    return sendError(res, 400, "invalid_key_id", "Key id must be an integer");
  }

  if (!revokeApiKey(id)) {
    return sendError(res, 404, "api_key_not_found", `No active API key with id ${id}`);
  }

  return res.json({ success: true, message: "API key revoked", data: { id } });
});

/** GET /api/v1/partner/analytics?days=30&partnerId=… — dashboard payload. */
partnerApiRouter.get(
  "/analytics",
  requireOperator,
  validateQuery(analyticsQuerySchema),
  (req, res) =>
    res.json({
      success: true,
      data: getAnalyticsDashboard({ partnerId: req.query.partnerId, days: req.query.days }),
    })
);

/** GET /api/v1/partner/analytics/revenue?days=30 */
partnerApiRouter.get(
  "/analytics/revenue",
  requireOperator,
  validateQuery(analyticsQuerySchema),
  (req, res) => res.json({ success: true, data: getRevenueByPartner({ days: req.query.days }) })
);

/** GET /api/v1/partner/analytics/overview?days=30 */
partnerApiRouter.get(
  "/analytics/overview",
  requireOperator,
  validateQuery(analyticsQuerySchema),
  (req, res) => res.json({ success: true, data: getPartnerOverview({ days: req.query.days }) })
);

export default partnerApiRouter;
