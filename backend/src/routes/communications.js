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
 *   - GET    /communications/segments         — list user segments and sizes
 *   - POST   /communications/campaigns        — create a targeted campaign
 *   - GET    /communications/campaigns/:id/analytics — campaign performance
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
import {
  buildSegments,
  getSegmentMembers,
  getSegmentSizes,
} from "../services/user-segmentation.js";
import {
  createCampaign,
  getCampaign,
  getCampaignAnalytics,
  listCampaigns,
  recordCampaignEvent,
} from "../services/campaign-manager.js";

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

const segmentQuerySchema = z.object({
  earnings: z.enum(["high", "medium", "low"]).optional(),
  activity: z.enum(["active", "inactive", "churned"]).optional(),
  tenure: z.enum(["new", "established", "veteran"]).optional(),
  geography: z.string().max(100).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().min(0).optional(),
});

const campaignSchema = z.object({
  name: z.string().min(1, "Campaign name is required").max(200),
  segment: segmentQuerySchema,
  variants: z
    .array(
      z.object({
        id: z.string().min(1).max(100),
        subject: z.string().max(500).optional().nullable(),
        body: z.string().min(1, "Variant body is required").max(10000),
        weight: z.number().min(0).max(1).optional(),
      }),
    )
    .min(1, "At least one variant is required"),
  createdBy: z.string().optional().nullable(),
});

const campaignEventSchema = z.object({
  campaignId: z.string().min(1, "Campaign id is required").max(200),
  variantId: z.string().min(1, "Variant id is required").max(100),
  walletAddress: z.string().regex(/^G[A-Z2-7]{55}$/, "Invalid Stellar address"),
  event: z.enum(["sent", "delivered", "opened", "clicked", "converted", "unsubscribed"]),
  metadata: z.record(z.unknown()).optional().nullable(),
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

/**
 * GET /communications/segments
 * List user segments with sizes.
 * Requires operator or admin role.
 */
communicationsRouter.get(
  "/segments",
  requireAdminBearerOrRole("operator"),
  (req, res) => {
    try {
      const sizes = getSegmentSizes();
      res.json({ success: true, data: sizes });
    } catch (err) {
      logger.error("Error listing segments", { error: err.message });
      sendError(res, 500, "segment_list_failed", "Failed to list segments");
    }
  },
);

/**
 * POST /communications/segments/members
 * Get members of a segment matching targeting rules.
 * Requires operator or admin role.
 */
communicationsRouter.post(
  "/segments/members",
  requireAdminBearerOrRole("operator"),
  validate(segmentQuerySchema),
  (req, res) => {
    try {
      const { limit, offset, ...rules } = req.body;
      const members = getSegmentMembers(rules, { limit: limit || 100, offset: offset || 0 });
      res.json({
        success: true,
        data: members,
        pagination: { limit: limit || 100, offset: offset || 0 },
      });
    } catch (err) {
      logger.error("Error fetching segment members", { error: err.message });
      sendError(res, 500, "segment_members_failed", "Failed to fetch segment members");
    }
  },
);

/**
 * POST /communications/campaigns
 * Create a targeted campaign for a specific segment with A/B variants.
 * Requires operator or admin role.
 */
communicationsRouter.post(
  "/campaigns",
  requireAdminBearerOrRole("operator"),
  validate(campaignSchema),
  (req, res) => {
    try {
      const campaign = createCampaign(req.body);

      try {
        addAuditLog("__global__", "campaign_created", req.body.createdBy, {
          campaignId: campaign.id,
          segment: campaign.segment,
          variants: campaign.variants.map((v) => v.id),
        });
      } catch (_) { /* non-fatal */ }

      logger.info("Campaign created", {
        event: "campaign_created",
        campaignId: campaign.id,
      });

      res.status(201).json({ success: true, data: campaign });
    } catch (err) {
      logger.error("Error creating campaign", { error: err.message });
      sendError(res, 500, "campaign_create_failed", "Failed to create campaign");
    }
  },
);

/**
 * GET /communications/campaigns
 * List campaigns.
 * Requires operator or admin role.
 */
communicationsRouter.get(
  "/campaigns",
  requireAdminBearerOrRole("operator"),
  (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 500);
      const offset = Number(req.query.offset) || 0;
      const campaigns = listCampaigns({ limit, offset });
      res.json({
        success: true,
        data: campaigns,
        pagination: { limit, offset },
      });
    } catch (err) {
      logger.error("Error listing campaigns", { error: err.message });
      sendError(res, 500, "campaign_list_failed", "Failed to list campaigns");
    }
  },
);

/**
 * GET /communications/campaigns/:campaignId/analytics
 * Get performance analytics for a campaign, including A/B variant breakdown.
 * Requires operator or admin role.
 */
communicationsRouter.get(
  "/campaigns/:campaignId/analytics",
  requireAdminBearerOrRole("operator"),
  (req, res) => {
    try {
      const { campaignId } = req.params;
      const campaign = getCampaign(campaignId);
      if (!campaign) {
        return sendError(res, 404, "campaign_not_found", "Campaign not found");
      }
      const analytics = getCampaignAnalytics(campaignId);
      res.json({ success: true, data: analytics });
    } catch (err) {
      logger.error("Error fetching campaign analytics", { error: err.message });
      sendError(res, 500, "campaign_analytics_failed", "Failed to fetch campaign analytics");
    }
  },
);

/**
 * POST /communications/campaigns/events
 * Record a campaign engagement/conversion event for A/B tracking.
 * Requires operator or admin role.
 */
communicationsRouter.post(
  "/campaigns/events",
  requireAdminBearerOrRole("operator"),
  validate(campaignEventSchema),
  (req, res) => {
    try {
      const event = recordCampaignEvent(req.body);
      res.status(201).json({ success: true, data: event });
    } catch (err) {
      logger.error("Error recording campaign event", { error: err.message });
      sendError(res, 500, "campaign_event_failed", "Failed to record campaign event");
    }
  },
);