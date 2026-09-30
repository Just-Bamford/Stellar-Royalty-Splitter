/**
 * API routes for the fraud detection & anomaly scoring system (#1042).
 *
 * GET  /api/v1/security/fraud-alerts          list alerts (admin)
 * GET  /api/v1/security/fraud-alerts/:id      alert detail
 * POST /api/v1/security/fraud-alerts/:id/resolve  resolve (approve|block) [admin]
 * POST /api/v1/security/fraud-alerts/:id/verify   submit 2FA/email verification [user]
 */

import express from "express";
import fraudDetection from "../../services/fraud-detection.js";
import { sendError } from "../../error-response.js";
import logger from "../../logger.js";

const router = express.Router();

/**
 * GET /api/v1/security/fraud-alerts
 * List fraud alerts, optionally filtered by userId and status.
 */
router.get("/", (req, res) => {
  try {
    const { userId, status } = req.query;
    const alerts = fraudDetection.getAlerts({
      userId: userId || undefined,
      status: status || undefined,
    });
    res.json({ success: true, alerts, count: alerts.length });
  } catch (err) {
    logger.error("Fraud alert listing failed", { error: err.message });
    sendError(res, 500, "fraud_list_failed", err.message);
  }
});

/**
 * GET /api/v1/security/fraud-alerts/:id
 * Fetch a single fraud alert.
 */
router.get("/:id", (req, res) => {
  try {
    const alert = fraudDetection.getAlert(Number(req.params.id));
    if (!alert) {
      return sendError(res, 404, "not_found", "fraud alert not found");
    }
    res.json({ success: true, alert });
  } catch (err) {
    logger.error("Fraud alert fetch failed", { error: err.message });
    sendError(res, 500, "fraud_fetch_failed", err.message);
  }
});

/**
 * POST /api/v1/security/fraud-alerts/:id/resolve
 * Admin-only: resolve an alert with action "approve" (legitimise) or "block"
 * (confirm fraudulent).
 */
router.post("/:id/resolve", (req, res) => {
  try {
    const { action, resolvedBy, resolution } = req.body || {};
    const alert = fraudDetection.resolveAlert(Number(req.params.id), {
      action,
      resolvedBy,
      resolution,
    });
    if (!alert) {
      return sendError(res, 404, "not_found", "fraud alert not found");
    }
    res.json({ success: true, alert });
  } catch (err) {
    logger.error("Fraud alert resolution failed", { error: err.message });
    const status = err.message && err.message.includes("invalid") ? 400 : 500;
    sendError(res, status, "fraud_resolve_failed", err.message);
  }
});

/**
 * POST /api/v1/security/fraud-alerts/:id/verify
 * End-user: submit the 2FA / email verification token issued when an alert
 * was raised at the "require_verification" level. A valid token resolves the
 * alert as "approved".
 */
router.post("/:id/verify", (req, res) => {
  try {
    const { token } = req.body || {};
    const result = fraudDetection.verifyToken(Number(req.params.id), token);
    if (!result.valid) {
      return sendError(res, 403, "verification_failed", result.reason || "invalid verification token");
    }
    res.json({
      success: true,
      message: "verification accepted; alert approved",
      alertId: result.alertId,
    });
  } catch (err) {
    logger.error("Fraud verification failed", { error: err.message });
    sendError(res, 500, "fraud_verify_failed", err.message);
  }
});

export { router as fraudAlertsRouter };
