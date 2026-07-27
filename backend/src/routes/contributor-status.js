/**
 * Contributor Suspension / Deactivation endpoints (#593).
 *
 * GET  /api/v1/contributor-status/:contractId
 *   Returns all non-active contributors for a contract.
 *   Query: ?includeActive=true  — also return active entries
 *
 * GET  /api/v1/contributor-status/:contractId/:address
 *   Returns the status record for one contributor.
 *
 * POST /api/v1/contributor-status/:contractId/:address
 *   Body: { status, reason?, updatedBy? }
 *   Requires operator or admin role.
 */
import { Router } from "express";
import { z } from "zod";
import {
  getContributorStatus,
  listContributorStatuses,
  setContributorStatus,
} from "../database/contributor-status.js";
import { addAuditLog } from "../database/index.js";
import { validateContractIdMiddleware } from "../validation.js";
import { sendError } from "../error-response.js";
import { requireRole } from "../middleware/rbac.js";
import { validate } from "../validation.js";
import logger from "../logger.js";

export const contributorStatusRouter = Router();

const stellarAddressRe = /^G[A-Z2-7]{55}$/;

function validateAddress(address, res) {
  if (!stellarAddressRe.test(address)) {
    sendError(res, 400, "invalid_stellar_address", "Invalid Stellar address format");
    return false;
  }
  return true;
}

const setStatusSchema = z.object({
  status: z.enum(["active", "suspended", "deactivated"]),
  reason: z.string().max(500).optional().nullable(),
  updatedBy: z
    .string()
    .regex(stellarAddressRe, "Invalid Stellar address")
    .optional()
    .nullable(),
});

/**
 * GET /api/v1/contributor-status/:contractId
 */
contributorStatusRouter.get(
  "/:contractId",
  validateContractIdMiddleware,
  (req, res, next) => {
    try {
      const { contractId } = req.params;
      const includeActive = req.query.includeActive === "true";
      const rows = listContributorStatuses(contractId, { includeActive });
      res.json({ success: true, data: rows });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/v1/contributor-status/:contractId/:address
 */
contributorStatusRouter.get(
  "/:contractId/:address",
  validateContractIdMiddleware,
  (req, res, next) => {
    try {
      const { contractId, address } = req.params;
      if (!validateAddress(address, res)) return;

      const row = getContributorStatus(contractId, address);
      // No explicit record means the contributor is active by default
      res.json({
        success: true,
        data: row ?? {
          contractId,
          address,
          status: "active",
          reason: null,
          suspendedAt: null,
          deactivatedAt: null,
          updatedBy: null,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/v1/contributor-status/:contractId/:address
 */
contributorStatusRouter.post(
  "/:contractId/:address",
  requireRole("operator"),
  validateContractIdMiddleware,
  validate(setStatusSchema),
  (req, res, next) => {
    try {
      const { contractId, address } = req.params;
      if (!validateAddress(address, res)) return;

      const { status, reason, updatedBy } = req.body;

      const record = setContributorStatus(contractId, address, status, {
        reason: reason ?? null,
        updatedBy: updatedBy ?? null,
      });

      addAuditLog(contractId, `contributor_${status}`, updatedBy ?? null, {
        address,
        status,
        reason: reason ?? null,
      });

      logger.info("Contributor status updated", {
        contractId,
        address,
        status,
        updatedBy,
      });

      res.json({ success: true, data: record });
    } catch (err) {
      next(err);
    }
  }
);
