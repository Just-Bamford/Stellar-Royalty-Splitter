import express from "express";
import { sendError } from "../error-response.js";
import {
  createVestingSchedule,
  calculateVestedAmount,
  releaseVestedTokens,
  getVestingSchedule,
  getVestingSchedulesByBeneficiary,
  getVestingSchedulesByContract,
  getVestingReleaseHistory,
  getSchedulesWithReleasableTokens,
  cancelVestingSchedule,
  getVestingStatistics,
  addAuditEntry,
} from "../database/index.js";
import { attachRole, requireRole } from "../middleware/rbac.js";
import logger from "../logger.js";

const router = express.Router();

/**
 * #983: Time-locked vesting contracts for team incentives
 */

/**
 * POST /api/v1/vesting/create
 * Create a new vesting schedule
 */
router.post("/vesting/create", attachRole, requireRole("admin"), (req, res) => {
  try {
    const {
      contractId,
      beneficiary,
      totalAmount,
      tokenAddress,
      startTime,
      cliffDuration,
      vestingDuration,
      createdBy,
    } = req.body;

    if (!contractId || !beneficiary || !totalAmount || !tokenAddress || !startTime || !cliffDuration || !vestingDuration) {
      return sendError(res, 400, "validation_failed", "Missing required fields");
    }

    const scheduleId = createVestingSchedule({
      contractId,
      beneficiary,
      totalAmount,
      tokenAddress,
      startTime,
      cliffDuration,
      vestingDuration,
      createdBy: createdBy || req.user?.walletAddress || "admin",
    });

    // Add audit log entry
    addAuditEntry({
      contractId,
      action: "vesting_schedule_created",
      user: createdBy || req.user?.walletAddress || "admin",
      details: {
        scheduleId,
        beneficiary,
        totalAmount,
        cliffDuration,
        vestingDuration,
      },
      category: "admin_action",
      severity: "info",
    });

    res.json({
      success: true,
      scheduleId,
      message: "Vesting schedule created successfully",
    });
  } catch (err) {
    logger.error("Failed to create vesting schedule", { error: err.message });
    return sendError(res, 500, "server_error", "Failed to create vesting schedule");
  }
});

/**
 * GET /api/v1/vesting/:scheduleId
 * Get vesting schedule details with current vested amount
 */
router.get("/vesting/:scheduleId", attachRole, requireRole("viewer"), (req, res) => {
  try {
    const { scheduleId } = req.params;
    const schedule = getVestingSchedule(parseInt(scheduleId));

    if (!schedule) {
      return sendError(res, 404, "not_found", "Vesting schedule not found");
    }

    const vested = calculateVestedAmount(parseInt(scheduleId));

    res.json({
      success: true,
      schedule,
      ...vested,
    });
  } catch (err) {
    logger.error("Failed to get vesting schedule", { error: err.message });
    return sendError(res, 500, "server_error", "Failed to get vesting schedule");
  }
});

/**
 * POST /api/v1/vesting/:scheduleId/release
 * Release vested tokens
 */
router.post("/vesting/:scheduleId/release", attachRole, requireRole("operator"), (req, res) => {
  try {
    const { scheduleId } = req.params;
    const { amount, txHash } = req.body;

    if (!amount || !txHash) {
      return sendError(res, 400, "validation_failed", "amount and txHash are required");
    }

    const result = releaseVestedTokens(parseInt(scheduleId), amount, txHash);
    const schedule = getVestingSchedule(parseInt(scheduleId));

    // Add audit log entry
    addAuditEntry({
      contractId: schedule.contractId,
      action: "vesting_tokens_released",
      user: req.user?.walletAddress || "system",
      details: {
        scheduleId: parseInt(scheduleId),
        amount,
        txHash,
        remaining: result.remaining,
      },
      category: "transaction",
      severity: "info",
    });

    res.json({
      success: true,
      ...result,
      message: "Vested tokens released successfully",
    });
  } catch (err) {
    logger.error("Failed to release vested tokens", { error: err.message });
    if (err.message.includes("Cannot release") || err.message.includes("not found")) {
      return sendError(res, 400, "invalid_request", err.message);
    }
    return sendError(res, 500, "server_error", "Failed to release vested tokens");
  }
});

/**
 * GET /api/v1/vesting/beneficiary/:address
 * Get all vesting schedules for a beneficiary
 */
router.get("/vesting/beneficiary/:address", attachRole, requireRole("viewer"), (req, res) => {
  try {
    const { address } = req.params;
    const schedules = getVestingSchedulesByBeneficiary(address);

    // Calculate current vested amounts for each schedule
    const schedulesWithVested = schedules.map((schedule) => {
      const vested = calculateVestedAmount(schedule.id);
      return {
        ...schedule,
        ...vested,
      };
    });

    res.json({
      success: true,
      schedules: schedulesWithVested,
    });
  } catch (err) {
    logger.error("Failed to get beneficiary schedules", { error: err.message });
    return sendError(res, 500, "server_error", "Failed to get beneficiary schedules");
  }
});

/**
 * GET /api/v1/vesting/contract/:contractId
 * Get all vesting schedules for a contract
 */
router.get("/vesting/contract/:contractId", attachRole, requireRole("viewer"), (req, res) => {
  try {
    const { contractId } = req.params;
    const schedules = getVestingSchedulesByContract(contractId);

    // Calculate current vested amounts for each schedule
    const schedulesWithVested = schedules.map((schedule) => {
      const vested = calculateVestedAmount(schedule.id);
      return {
        ...schedule,
        ...vested,
      };
    });

    res.json({
      success: true,
      schedules: schedulesWithVested,
    });
  } catch (err) {
    logger.error("Failed to get contract schedules", { error: err.message });
    return sendError(res, 500, "server_error", "Failed to get contract schedules");
  }
});

/**
 * GET /api/v1/vesting/:scheduleId/releases
 * Get release history for a schedule
 */
router.get("/vesting/:scheduleId/releases", attachRole, requireRole("viewer"), (req, res) => {
  try {
    const { scheduleId } = req.params;
    const releases = getVestingReleaseHistory(parseInt(scheduleId));

    res.json({
      success: true,
      releases,
    });
  } catch (err) {
    logger.error("Failed to get release history", { error: err.message });
    return sendError(res, 500, "server_error", "Failed to get release history");
  }
});

/**
 * GET /api/v1/vesting/releasable
 * Get all schedules with releasable tokens (admin only)
 */
router.get("/vesting/releasable", attachRole, requireRole("admin"), (req, res) => {
  try {
    const schedules = getSchedulesWithReleasableTokens();

    res.json({
      success: true,
      schedules,
    });
  } catch (err) {
    logger.error("Failed to get releasable schedules", { error: err.message });
    return sendError(res, 500, "server_error", "Failed to get releasable schedules");
  }
});

/**
 * DELETE /api/v1/vesting/:scheduleId
 * Cancel a vesting schedule (admin only)
 */
router.delete("/vesting/:scheduleId", attachRole, requireRole("admin"), (req, res) => {
  try {
    const { scheduleId } = req.params;
    const { reason } = req.body;
    const cancelledBy = req.user?.walletAddress || "admin";

    cancelVestingSchedule(parseInt(scheduleId), cancelledBy, reason || "Cancelled by admin");

    const schedule = getVestingSchedule(parseInt(scheduleId));

    // Add audit log entry
    addAuditEntry({
      contractId: schedule.contractId,
      action: "vesting_schedule_cancelled",
      user: cancelledBy,
      details: {
        scheduleId: parseInt(scheduleId),
        reason,
      },
      category: "admin_action",
      severity: "warning",
    });

    res.json({
      success: true,
      message: "Vesting schedule cancelled",
    });
  } catch (err) {
    logger.error("Failed to cancel vesting schedule", { error: err.message });
    if (err.message.includes("not found") || err.message.includes("already cancelled")) {
      return sendError(res, 404, "not_found", err.message);
    }
    return sendError(res, 500, "server_error", "Failed to cancel vesting schedule");
  }
});

/**
 * GET /api/v1/vesting/statistics/:beneficiary
 * Get vesting statistics for a beneficiary
 */
router.get("/vesting/statistics/:beneficiary", attachRole, requireRole("viewer"), (req, res) => {
  try {
    const { beneficiary } = req.params;
    const stats = getVestingStatistics(beneficiary);

    res.json({
      success: true,
      statistics: stats,
    });
  } catch (err) {
    logger.error("Failed to get vesting statistics", { error: err.message });
    return sendError(res, 500, "server_error", "Failed to get vesting statistics");
  }
});

export const vestingRouter = router;
