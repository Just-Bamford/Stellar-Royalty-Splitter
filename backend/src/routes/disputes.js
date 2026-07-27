/**
 * Dispute resolution routes — closes #607.
 *
 * Contributor endpoints (no auth — wallet address is the identity):
 *   POST   /api/v1/disputes                        — submit a new dispute
 *   GET    /api/v1/disputes?walletAddress=G...      — list disputes for a wallet
 *   GET    /api/v1/disputes/:ticketId               — get a single dispute with comments
 *   POST   /api/v1/disputes/:ticketId/comments      — contributor adds a comment
 *
 * Admin endpoints (Bearer ADMIN_ROTATE_TOKEN):
 *   GET    /api/v1/disputes/admin/all               — list all disputes (filterable by status)
 *   PATCH  /api/v1/disputes/admin/:ticketId/status  — update status + optional note
 *   POST   /api/v1/disputes/admin/:ticketId/comments — admin posts a comment
 */

import { Router } from "express";
import logger from "../logger.js";
import { validate } from "../validation.js";
import { sendError } from "../error-response.js";
import { parsePagination } from "../validation.js";
import {
  disputeSubmitSchema,
  disputeContributorCommentSchema,
  disputeAdminReviewSchema,
  disputeAdminCommentSchema,
} from "../validation.js";
import {
  createDispute,
  getDisputeByTicketId,
  getDisputesByWallet,
  countDisputesByWallet,
  getAllDisputes,
  countAllDisputes,
  updateDisputeStatus,
  addDisputeComment,
} from "../database/disputes.js";
import { sendEmail, isEmailConfigured } from "../email/email-service.js";
import {
  disputeSubmittedEmail,
  disputeStatusUpdateEmail,
} from "../email/templates/dispute-notification.js";

export const disputesRouter = Router();

// ─── Admin auth middleware ────────────────────────────────────────────────────

function extractBearerToken(req) {
  const header = req.get("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim();
}

function requireAdminToken(req, res, next) {
  const envToken = process.env.ADMIN_ROTATE_TOKEN;
  if (!envToken) {
    return sendError(res, 503, "service_unavailable", "Admin operations are not configured on this server");
  }
  const token = extractBearerToken(req);
  if (!token || token !== envToken) {
    return sendError(res, 401, "unauthorized", "Unauthorized");
  }
  next();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Look up a dispute by ticketId route param; sends 404 and returns null if missing.
 * @param {string} ticketId
 * @param {object} res
 * @returns {object|null}
 */
function resolveDispute(ticketId, res) {
  const dispute = getDisputeByTicketId(ticketId);
  if (!dispute) {
    sendError(res, 404, "dispute_not_found", `No dispute found with ticket ID ${ticketId}`);
    return null;
  }
  return dispute;
}

/**
 * Notify the contributor by email (fire-and-forget; never throws).
 * Silently skips when email is not configured.
 */
async function notifyContributor(emailAddress, template) {
  if (!emailAddress || !isEmailConfigured()) return;
  try {
    await sendEmail({ to: emailAddress, ...template });
  } catch (err) {
    logger.warn("Failed to send dispute notification email", { error: err.message });
  }
}

// ─── Contributor: submit a dispute ───────────────────────────────────────────

disputesRouter.post("/", validate(disputeSubmitSchema), async (req, res, next) => {
  try {
    const { walletAddress, contractId, category, description } = req.body;

    const dispute = createDispute({ walletAddress, contractId, category, description });

    logger.info("Dispute created", {
      ticketId: dispute.ticketId,
      walletAddress,
      category,
    });

    // Confirmation email — contributor must have registered an email elsewhere;
    // if req.body carries one we use it, otherwise we skip silently.
    const contributorEmail = req.body.email ?? null;
    if (contributorEmail) {
      await notifyContributor(
        contributorEmail,
        disputeSubmittedEmail({
          ticketId: dispute.ticketId,
          category,
          description,
          contractId,
        })
      );
    }

    return res.status(201).json({ success: true, data: dispute });
  } catch (err) {
    next(err);
  }
});

// ─── Contributor: list disputes for a wallet ──────────────────────────────────

disputesRouter.get("/", (req, res) => {
  const { walletAddress } = req.query;

  if (!walletAddress || typeof walletAddress !== "string") {
    return sendError(res, 400, "missing_wallet_address", "walletAddress query parameter is required");
  }
  if (!/^G[A-Z2-7]{55}$/.test(walletAddress)) {
    return sendError(res, 400, "invalid_stellar_address", "Invalid Stellar address format");
  }

  const pagination = parsePagination(req.query, res);
  if (!pagination) return;

  const items = getDisputesByWallet(walletAddress, pagination);
  const total = countDisputesByWallet(walletAddress);

  return res.json({
    success: true,
    data: items,
    pagination: { total, limit: pagination.limit, offset: pagination.offset },
  });
});

// ─── Admin: list all disputes ─────────────────────────────────────────────────
// NOTE: this route must be registered before /:ticketId to avoid "admin" being
// matched as a ticketId.

disputesRouter.get("/admin/all", requireAdminToken, (req, res) => {
  const { status } = req.query;

  const VALID_STATUSES = ["open", "under_review", "resolved", "closed"];
  if (status && !VALID_STATUSES.includes(status)) {
    return sendError(
      res,
      400,
      "invalid_status",
      `status must be one of: ${VALID_STATUSES.join(", ")}`
    );
  }

  const pagination = parsePagination(req.query, res);
  if (!pagination) return;

  const items = getAllDisputes({ status, ...pagination });
  const total = countAllDisputes({ status });

  return res.json({
    success: true,
    data: items,
    pagination: { total, limit: pagination.limit, offset: pagination.offset },
  });
});

// ─── Admin: update dispute status ─────────────────────────────────────────────

disputesRouter.patch(
  "/admin/:ticketId/status",
  requireAdminToken,
  validate(disputeAdminReviewSchema),
  async (req, res, next) => {
    try {
      const { ticketId } = req.params;
      const { status, adminNote } = req.body;

      const existing = getDisputeByTicketId(ticketId);
      if (!existing) {
        return sendError(res, 404, "dispute_not_found", `No dispute found with ticket ID ${ticketId}`);
      }

      const updated = updateDisputeStatus(existing.id, status, adminNote);

      logger.info("Dispute status updated", {
        ticketId,
        previousStatus: existing.status,
        newStatus: status,
      });

      // Notify contributor if we have a contact email on file.
      // The email_digest_subscribers table stores wallet→email mappings;
      // we attempt a best-effort lookup via the database module.
      const contributorEmail = await resolveContributorEmail(existing.walletAddress);
      if (contributorEmail) {
        await notifyContributor(
          contributorEmail,
          disputeStatusUpdateEmail({ ticketId, newStatus: status, adminNote })
        );
      }

      return res.json({ success: true, data: updated });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Admin: post a comment ────────────────────────────────────────────────────

disputesRouter.post(
  "/admin/:ticketId/comments",
  requireAdminToken,
  validate(disputeAdminCommentSchema),
  async (req, res, next) => {
    try {
      const { ticketId } = req.params;
      const { message } = req.body;

      const dispute = getDisputeByTicketId(ticketId);
      if (!dispute) {
        return sendError(res, 404, "dispute_not_found", `No dispute found with ticket ID ${ticketId}`);
      }

      const comment = addDisputeComment(dispute.id, "admin", message);

      logger.info("Admin comment added to dispute", { ticketId, commentId: comment.id });

      // Notify contributor of the new admin response
      const contributorEmail = await resolveContributorEmail(dispute.walletAddress);
      if (contributorEmail) {
        await notifyContributor(
          contributorEmail,
          disputeStatusUpdateEmail({
            ticketId,
            newStatus: dispute.status,
            adminComment: message,
          })
        );
      }

      return res.status(201).json({ success: true, data: comment });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Contributor: get a single dispute with comments ─────────────────────────

disputesRouter.get("/:ticketId", (req, res) => {
  const dispute = resolveDispute(req.params.ticketId, res);
  if (!dispute) return;
  return res.json({ success: true, data: dispute });
});

// ─── Contributor: add a comment ───────────────────────────────────────────────

disputesRouter.post(
  "/:ticketId/comments",
  validate(disputeContributorCommentSchema),
  (req, res, next) => {
    try {
      const { ticketId } = req.params;
      const { walletAddress, message } = req.body;

      const dispute = resolveDispute(ticketId, res);
      if (!dispute) return;

      // Only the owning wallet may comment as contributor
      if (dispute.walletAddress !== walletAddress) {
        return sendError(res, 403, "forbidden", "You do not have permission to comment on this dispute");
      }

      // Closed/resolved disputes accept no further comments from contributors
      if (dispute.status === "closed" || dispute.status === "resolved") {
        return sendError(
          res,
          409,
          "dispute_closed",
          "Cannot add comments to a resolved or closed dispute"
        );
      }

      const comment = addDisputeComment(dispute.id, "contributor", message);

      logger.info("Contributor comment added to dispute", { ticketId, commentId: comment.id });

      return res.status(201).json({ success: true, data: comment });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Internal: resolve contributor email from digest subscribers ──────────────

/**
 * Best-effort lookup of a contributor's email address via the email_digest_subscribers
 * table.  Returns null if the subscriber is not found or the DB call fails.
 *
 * @param {string} walletAddress
 * @returns {Promise<string|null>}
 */
async function resolveContributorEmail(walletAddress) {
  try {
    // Dynamic import avoids a circular dep at module load time
    const { getSubscriberByWallet } = await import("../database/email-digest.js");
    const subscriber = getSubscriberByWallet(walletAddress);
    return subscriber?.email ?? null;
  } catch {
    return null;
  }
}
