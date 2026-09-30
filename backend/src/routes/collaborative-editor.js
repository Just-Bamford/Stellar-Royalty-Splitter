import express from "express";
import { sendError } from "../error-response.js";
import {
  createEditSession,
  extendEditSession,
  releaseEditSession,
  getActiveEditSessions,
  recordContractEdit,
  getContractEditHistory,
  applyOperationalTransform,
  getFieldVersion,
} from "../database/index.js";
import { broadcastContractEdit } from "../websocket.js";
import { attachRole, requireRole } from "../middleware/rbac.js";
import logger from "../logger.js";

const router = express.Router();

/**
 * #959: Real-time collaborative contract editor routes
 */

/**
 * POST /api/v1/contracts/:contractId/edit-session
 * Create or acquire an edit session for a contract field
 */
router.post("/contracts/:contractId/edit-session", attachRole, requireRole("collaborator"), (req, res) => {
  try {
    const { contractId } = req.params;
    const { field, userId, expiresIn = 300 } = req.body;

    if (!field || !userId) {
      return sendError(res, 400, "validation_failed", "field and userId are required");
    }

    const session = createEditSession(contractId, userId, field, expiresIn);

    // Broadcast field lock event
    broadcastContractEdit(contractId, {
      type: "field_locked",
      field,
      userId,
      sessionId: session.id,
      expiresAt: session.expiresAt,
    });

    res.json({
      success: true,
      session,
    });
  } catch (err) {
    logger.error("Failed to create edit session", { error: err.message });
    if (err.message.includes("currently being edited")) {
      return sendError(res, 409, "conflict", err.message);
    }
    return sendError(res, 500, "server_error", "Failed to create edit session");
  }
});

/**
 * PUT /api/v1/contracts/:contractId/edit-session/:sessionId/extend
 * Extend an existing edit session
 */
router.put("/contracts/:contractId/edit-session/:sessionId/extend", attachRole, requireRole("collaborator"), (req, res) => {
  try {
    const { sessionId } = req.params;
    const { extendBy = 300 } = req.body;

    extendEditSession(parseInt(sessionId), extendBy);

    res.json({
      success: true,
      message: "Edit session extended",
    });
  } catch (err) {
    logger.error("Failed to extend edit session", { error: err.message });
    return sendError(res, 500, "server_error", "Failed to extend edit session");
  }
});

/**
 * DELETE /api/v1/contracts/:contractId/edit-session/:sessionId
 * Release an edit session (unlock field)
 */
router.delete("/contracts/:contractId/edit-session/:sessionId", attachRole, requireRole("collaborator"), (req, res) => {
  try {
    const { contractId, sessionId } = req.params;
    const { field, userId } = req.body;

    releaseEditSession(parseInt(sessionId));

    // Broadcast field unlock event
    if (field && userId) {
      broadcastContractEdit(contractId, {
        type: "field_unlocked",
        field,
        userId,
        sessionId: parseInt(sessionId),
      });
    }

    res.json({
      success: true,
      message: "Edit session released",
    });
  } catch (err) {
    logger.error("Failed to release edit session", { error: err.message });
    return sendError(res, 500, "server_error", "Failed to release edit session");
  }
});

/**
 * GET /api/v1/contracts/:contractId/edit-sessions
 * Get all active edit sessions for a contract
 */
router.get("/contracts/:contractId/edit-sessions", attachRole, requireRole("viewer"), (req, res) => {
  try {
    const { contractId } = req.params;
    const sessions = getActiveEditSessions(contractId);

    res.json({
      success: true,
      sessions,
    });
  } catch (err) {
    logger.error("Failed to get edit sessions", { error: err.message });
    return sendError(res, 500, "server_error", "Failed to get edit sessions");
  }
});

/**
 * POST /api/v1/contracts/:contractId/field-update
 * Update a contract field with operational transform
 */
router.post("/contracts/:contractId/field-update", attachRole, requireRole("operator"), (req, res) => {
  try {
    const { contractId } = req.params;
    const { field, operation, userId, oldValue, newValue } = req.body;

    if (!field || !operation || !userId) {
      return sendError(res, 400, "validation_failed", "field, operation, and userId are required");
    }

    // Apply operational transform
    const result = applyOperationalTransform(contractId, field, operation, userId);

    // Record the edit in history
    recordContractEdit(contractId, userId, field, oldValue, newValue, "update");

    // Broadcast update event
    broadcastContractEdit(contractId, {
      type: "field_updated",
      field,
      userId,
      version: result.version,
      value: result.value,
    });

    res.json({
      success: true,
      version: result.version,
      value: result.value,
    });
  } catch (err) {
    logger.error("Failed to update contract field", { error: err.message });
    if (err.message.includes("Conflict detected")) {
      return sendError(res, 409, "conflict", err.message);
    }
    return sendError(res, 500, "server_error", "Failed to update contract field");
  }
});

/**
 * GET /api/v1/contracts/:contractId/field-version/:field
 * Get current version of a field
 */
router.get("/contracts/:contractId/field-version/:field", attachRole, requireRole("viewer"), (req, res) => {
  try {
    const { contractId, field } = req.params;
    const version = getFieldVersion(contractId, field);

    if (!version) {
      return res.json({
        success: true,
        version: null,
      });
    }

    res.json({
      success: true,
      version: {
        ...version,
        value: JSON.parse(version.value),
      },
    });
  } catch (err) {
    logger.error("Failed to get field version", { error: err.message });
    return sendError(res, 500, "server_error", "Failed to get field version");
  }
});

/**
 * GET /api/v1/contracts/:contractId/edit-history
 * Get edit history for a contract
 */
router.get("/contracts/:contractId/edit-history", attachRole, requireRole("viewer"), (req, res) => {
  try {
    const { contractId } = req.params;
    const { limit = 50, offset = 0 } = req.query;

    const history = getContractEditHistory(contractId, parseInt(limit), parseInt(offset));

    res.json({
      success: true,
      history: history.map((entry) => ({
        ...entry,
        oldValue: entry.oldValue ? JSON.parse(entry.oldValue) : null,
        newValue: entry.newValue ? JSON.parse(entry.newValue) : null,
      })),
    });
  } catch (err) {
    logger.error("Failed to get edit history", { error: err.message });
    return sendError(res, 500, "server_error", "Failed to get edit history");
  }
});

export const collaborativeEditorRouter = router;
