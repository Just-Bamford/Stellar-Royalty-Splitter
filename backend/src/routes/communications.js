/**
 * Contributor communication history routes — closes #612.
 *
 * Provides REST endpoints for:
 *   - POST   /communications                  — record a communication
 *   - GET    /communications/wallet/:wallet   — get comms for a wallet
 *   - GET    /communications/contract/:contractId — get comms for a contract
 *   - POST   /communications/search           — search communications
 *   - GET    /communications/timeline/:wallet — chronological timeline
 *   - POST   /communications/internal-note    — add admin internal note
 */

import { Router } from "express";
import { z } from "zod";
import logger from "../logger.js";
import { validate } from "../validation.js";
import { sendError } from "../error-response.js";
import { addAuditLog } from "../database/index.js";
import {
  recordCommunication,
  getCommunicationsByWallet,
  getCommunicationsByContract,
  searchCommunications,
  addInternalNote,
  getCommunicationTimeline,
  countCommunications,
} from "../database/contributor-communications.js";
import { requireAdminBearerOrRole } from "../middleware/rbac.js";

export const communicationsRouter = Router();

// ─── Schemas ───────────────────────────────────────────────────────────────────

const recordCommunicationSchema = z.object({
  walletAddress: z.string().regex(/^G[A-Z2-7]{55}$/, "Invalid Stellar address"),
  contractId: z.string().optional().nullable(),
  type: z.enum(["email", "support_ticket", "message", "internal_note", "system_notification"]),
  subject: z.string().max(500).optional().nullable(),
  body: z.string().min(1, "Body is required").max(10000),
  direction: z.enum(["inbound", "outbound", "internal"]),
  status: z.enum(["sent", "received", "draft", "archived"]).optional(),
  isInternal: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional().nullable(),
  referenceId: z.string().max(200).optional().nullable(),
  createdBy: z.string().optional().nullable(),
});

const searchSchema = z.object({
  query: z.string().min(1, "Search query is required").max(200),
  includeInternal: z.boolean().optional(),
  limit: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().min(0).optional(),
});

const internalNoteSchema = z.object({
  walletAddress: z.string().regex(/^G[A-Z2-7]{55}$/, "Invalid Stellar address"),
  contractId: z.string().optional().nullable(),
  body: z.string().min(1, "Note body is required").max(10000),
  createdBy: z.string().optional().nullable(),
});

// ─── Routes ────────────────────────────────────────────────────────────────────

/**
 * POST /communications
 * Record a new communication.
 * Requires operator or admin role for outbound/internal messages.
 */
communicationsRouter.post(
  "/",
  requireAdminBearerOrRole("operator"),
  validate(recordCommunicationSchema),
  (req, res) => {
    try {
      const comm = recordCommunication({
        ...req.body,
        status: req.body.status || "sent",
        isInternal: req.body.isInternal || false,
      });

      // Audit log
      try {
        addAuditLog(
          req.body.contractId || "__global__",
          `communication_${comm.type}`,
          req.body.createdBy,
          { communicationId: comm.id, walletAddress: comm.walletAddress }
        );
      } catch (_) { /* non-fatal */ }

      logger.info("Communication recorded", {
        event: "communication_recorded",
        type: comm.type,
        walletAddress: comm.walletAddress,
      });

      res.status(201).json({ success: true, data: comm });
    } catch (err) {
      logger.error("Error recording communication", { error: err.message });
      sendError(res, 500, "communication_create_failed", "Failed to record communication");
    }
  },
);

/**
 * GET /communications/wallet/:walletAddress
 * Get all communications for a wallet address.
 */
communicationsRouter.get("/wallet/:walletAddress", (req, res) => {
  try {
    const { walletAddress } = req.params;
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const offset = Number(req.query.offset) || 0;
    const includeInternal = req.query.includeInternal === "true";

    const comms = getCommunicationsByWallet(walletAddress, { includeInternal, limit, offset });
    const total = countCommunications(walletAddress, { includeInternal });

    res.json({
      success: true,
      data: comms,
      pagination: { total, limit, offset },
    });
  } catch (err) {
    logger.error("Error fetching communications", { error: err.message });
    sendError(res, 500, "communication_fetch_failed", "Failed to fetch communications");
  }
});

/**
 * GET /communications/contract/:contractId
 * Get all communications for a contract.
 */
communicationsRouter.get("/contract/:contractId", (req, res) => {
  try {
    const { contractId } = req.params;
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const offset = Number(req.query.offset) || 0;
    const includeInternal = req.query.includeInternal === "true";

    const comms = getCommunicationsByContract(contractId, { includeInternal, limit, offset });

    res.json({
      success: true,
      data: comms,
      pagination: { limit, offset },
    });
  } catch (err) {
    logger.error("Error fetching contract communications", { error: err.message });
    sendError(res, 500, "communication_fetch_failed", "Failed to fetch communications");
  }
});

/**
 * POST /communications/search
 * Search across all communications.
 */
communicationsRouter.post(
  "/search",
  requireAdminBearerOrRole("operator"),
  validate(searchSchema),
  (req, res) => {
    try {
      const { query, includeInternal, limit, offset } = req.body;

      const results = searchCommunications(query, {
        includeInternal: includeInternal || false,
        limit: limit || 50,
        offset: offset || 0,
      });

      res.json({
        success: true,
        data: results,
        pagination: { limit: limit || 50, offset: offset || 0 },
      });
    } catch (err) {
      logger.error("Error searching communications", { error: err.message });
      sendError(res, 500, "communication_search_failed", "Failed to search communications");
    }
  },
);

/**
 * GET /communications/timeline/:walletAddress
 * Get chronological timeline of communications for a wallet.
 */
communicationsRouter.get("/timeline/:walletAddress", (req, res) => {
  try {
    const { walletAddress } = req.params;
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Number(req.query.offset) || 0;
    const includeInternal = req.query.includeInternal === "true";

    const timeline = getCommunicationTimeline(walletAddress, { includeInternal, limit, offset });

    res.json({
      success: true,
      data: timeline,
      pagination: { limit, offset },
    });
  } catch (err) {
    logger.error("Error fetching timeline", { error: err.message });
    sendError(res, 500, "timeline_fetch_failed", "Failed to fetch timeline");
  }
});

/**
 * POST /communications/internal-note
 * Add an admin-only internal note to a contributor's history.
 * Requires admin role.
 */
communicationsRouter.post(
  "/internal-note",
  requireAdminBearerOrRole("admin"),
  validate(internalNoteSchema),
  (req, res) => {
    try {
      const note = addInternalNote(req.body);

      logger.info("Internal note added", {
        event: "internal_note_added",
        walletAddress: req.body.walletAddress,
      });

      res.status(201).json({ success: true, data: note });
    } catch (err) {
      logger.error("Error adding internal note", { error: err.message });
      sendError(res, 500, "internal_note_failed", "Failed to add internal note");
    }
  },
);