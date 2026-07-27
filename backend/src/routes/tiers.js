/**
 * Contributor Tier routes (#589)
 * GET  /api/tiers/:contractId          — list all tier assignments
 * GET  /api/tiers/:contractId/:address — get single contributor tier
 * PUT  /api/tiers/:contractId/:address — set tier (operator+)
 * DELETE /api/tiers/:contractId/:address — reset to regular (operator+)
 */
import { Router } from "express";
import { z } from "zod";
import { validateContractIdMiddleware } from "../validation.js";
import { validate } from "../validation.js";
import { sendError } from "../error-response.js";
import { requireRole } from "../middleware/rbac.js";
import {
  getContractTiers,
  getContributorTier,
  setContributorTier,
  removeContributorTier,
  VALID_TIERS,
} from "../database/index.js";

export const tiersRouter = Router();

const stellarAddress = z.string().regex(/^G[A-Z2-7]{55}$/, "Invalid Stellar address");

const setTierSchema = z.object({
  tier: z.enum(["vip", "regular", "trial"]),
  notes: z.string().max(256).optional().nullable(),
});

tiersRouter.get("/:contractId", validateContractIdMiddleware, (req, res, next) => {
  try {
    const tiers = getContractTiers(req.params.contractId);
    res.json({ success: true, data: tiers, validTiers: VALID_TIERS });
  } catch (err) {
    next(err);
  }
});

tiersRouter.get("/:contractId/:address", validateContractIdMiddleware, (req, res, next) => {
  try {
    const parsed = stellarAddress.safeParse(req.params.address);
    if (!parsed.success) return sendError(res, 400, "invalid_address", "Invalid Stellar address");
    const tier = getContributorTier(req.params.contractId, req.params.address);
    res.json({ success: true, data: { walletAddress: req.params.address, ...tier } });
  } catch (err) {
    next(err);
  }
});

tiersRouter.put(
  "/:contractId/:address",
  validateContractIdMiddleware,
  requireRole("operator"),
  validate(setTierSchema),
  (req, res, next) => {
    try {
      const parsed = stellarAddress.safeParse(req.params.address);
      if (!parsed.success) return sendError(res, 400, "invalid_address", "Invalid Stellar address");
      setContributorTier(
        req.params.contractId,
        req.params.address,
        req.body.tier,
        req.body.notes ?? null,
      );
      res.json({ success: true, message: "Tier updated" });
    } catch (err) {
      next(err);
    }
  },
);

tiersRouter.delete(
  "/:contractId/:address",
  validateContractIdMiddleware,
  requireRole("operator"),
  (req, res, next) => {
    try {
      const parsed = stellarAddress.safeParse(req.params.address);
      if (!parsed.success) return sendError(res, 400, "invalid_address", "Invalid Stellar address");
      removeContributorTier(req.params.contractId, req.params.address);
      res.json({ success: true, message: "Tier reset to regular" });
    } catch (err) {
      next(err);
    }
  },
);
