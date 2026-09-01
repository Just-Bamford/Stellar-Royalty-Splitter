/**
 * Snapshot management routes — closes #613.
 *
 * Provides REST endpoints for:
 *   - POST   /snapshots/:contractId       — create a snapshot
 *   - GET    /snapshots/:contractId       — list snapshots for a contract
 *   - GET    /snapshots/:contractId/:id   — get a specific snapshot
 *   - POST   /snapshots/:contractId/verify/:id — verify snapshot integrity
 *   - GET    /snapshots/all               — get all snapshots (admin)
 *   - DELETE /snapshots/:contractId/prune — prune old snapshots
 */

import { Router } from "express";
import { z } from "zod";
import logger from "../logger.js";
import { validate } from "../validation.js";
import { sendError } from "../error-response.js";
import { addAuditLog } from "../database/index.js";
import {
  createSnapshot,
  listSnapshots,
  getSnapshot,
  verifySnapshotIntegrity,
  countSnapshots,
  getAllSnapshots,
  pruneSnapshots,
} from "../database/contract-snapshots.js";
import { requireAdminBearerOrRole } from "../middleware/rbac.js";

export const snapshotRouter = Router();

// ─── Schemas ───────────────────────────────────────────────────────────────────

const createSnapshotSchema = z.object({
  label: z.string().max(200).optional(),
  collaborators: z.string().optional(),
  shares: z.string().optional(),
  balances: z.string().optional(),
  transactionCount: z.number().int().nonnegative().optional(),
  createdBy: z.string().optional(),
});

// ─── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /snapshots/all
 * Get all snapshots across all contracts (admin only).
 */
snapshotRouter.get(
  "/all",
  requireAdminBearerOrRole("admin"),
  (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 100, 1000);
      const offset = Number(req.query.offset) || 0;

      const snapshots = getAllSnapshots({ limit, offset });

      res.json({
        success: true,
        data: snapshots,
        pagination: { limit, offset },
      });
    } catch (err) {
      logger.error("Error fetching all snapshots", { error: err.message });
      sendError(res, 500, "snapshot_fetch_failed", "Failed to fetch snapshots");
    }
  },
);

/**
 * GET /snapshots/:contractId
 * List snapshots for a specific contract.
 */
snapshotRouter.get("/:contractId", (req, res) => {
  try {
    const { contractId } = req.params;
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const offset = Number(req.query.offset) || 0;

    const snapshots = listSnapshots(contractId, { limit, offset });
    const total = countSnapshots(contractId);

    res.json({
      success: true,
      data: snapshots,
      pagination: { total, limit, offset },
    });
  } catch (err) {
    logger.error("Error listing snapshots", { error: err.message });
    sendError(res, 500, "snapshot_list_failed", "Failed to list snapshots");
  }
});

/**
 * POST /snapshots/:contractId
 * Create a new snapshot for a contract.
 * Requires operator or admin role.
 */
snapshotRouter.post(
  "/:contractId",
  requireAdminBearerOrRole("operator"),
  validate(createSnapshotSchema),
  (req, res) => {
    try {
      const { contractId } = req.params;
      const {
        label,
        collaborators = "[]",
        shares = "{}",
        balances = "{}",
        transactionCount = 0,
        createdBy,
      } = req.body;

      const snapshot = createSnapshot({
        contractId,
        label: label ?? `manual-snapshot-${new Date().toISOString()}`,
        collaborators,
        shares,
        balances,
        transactionCount,
        createdBy: createdBy || req.get("x-api-key") || "api",
      });

      // Audit log
      try {
        addAuditLog(contractId, "snapshot_created", createdBy, {
          snapshotId: snapshot.id,
          label: snapshot.label,
        });
      } catch (_) { /* non-fatal */ }

      logger.info("Snapshot created", {
        event: "snapshot_created",
        contractId,
        snapshotId: snapshot.id,
      });

      res.status(201).json({ success: true, data: snapshot });
    } catch (err) {
      logger.error("Error creating snapshot", { error: err.message });
      sendError(res, 500, "snapshot_create_failed", "Failed to create snapshot");
    }
  },
);

/**
 * GET /snapshots/:contractId/:id
 * Get a specific snapshot by ID.
 */
snapshotRouter.get("/:contractId/:id", (req, res) => {
  try {
    const snapshotId = Number(req.params.id);
    if (isNaN(snapshotId)) {
      return sendError(res, 400, "invalid_id", "Snapshot ID must be a number");
    }

    const snapshot = getSnapshot(snapshotId);
    if (!snapshot) {
      return sendError(res, 404, "not_found", "Snapshot not found");
    }

    res.json({ success: true, data: snapshot });
  } catch (err) {
    logger.error("Error fetching snapshot", { error: err.message });
    sendError(res, 500, "snapshot_fetch_failed", "Failed to fetch snapshot");
  }
});

/**
 * POST /snapshots/:contractId/verify/:id
 * Verify data integrity of a snapshot by recomputing its hash.
 */
snapshotRouter.post("/:contractId/verify/:id", (req, res) => {
  try {
    const snapshotId = Number(req.params.id);
    if (isNaN(snapshotId)) {
      return sendError(res, 400, "invalid_id", "Snapshot ID must be a number");
    }

    const result = verifySnapshotIntegrity(snapshotId);

    res.json({
      success: true,
      data: result,
    });
  } catch (err) {
    logger.error("Error verifying snapshot", { error: err.message });
    sendError(res, 500, "snapshot_verify_failed", "Failed to verify snapshot");
  }
});

/**
 * DELETE /snapshots/:contractId/prune
 * Prune old snapshots, keeping the most recent N (default: 90).
 * Requires admin role.
 */
snapshotRouter.delete(
  "/:contractId/prune",
  requireAdminBearerOrRole("admin"),
  (req, res) => {
    try {
      const { contractId } = req.params;
      const keepCount = Math.max(1, Number(req.query.keep) || 90);

      const deleted = pruneSnapshots(contractId, keepCount);

      // Audit log
      try {
        addAuditLog(contractId, "snapshots_pruned", null, {
          deleted,
          keepCount,
        });
      } catch (_) { /* non-fatal */ }

      res.json({
        success: true,
        data: { deleted, keepCount },
      });
    } catch (err) {
      logger.error("Error pruning snapshots", { error: err.message });
      sendError(res, 500, "snapshot_prune_failed", "Failed to prune snapshots");
    }
  },
);