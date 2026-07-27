/**
 * Payment Schedule Template routes (#599).
 *
 * POST   /api/v1/payment-schedules              — Create a schedule template
 * GET    /api/v1/payment-schedules/:contractId  — List schedules for a contract
 * PATCH  /api/v1/payment-schedules/:id          — Update / enable / disable a schedule
 * DELETE /api/v1/payment-schedules/:id          — Remove a schedule
 * GET    /api/v1/payment-schedules/:id/upcoming — Show next N upcoming run times
 * GET    /api/v1/payment-schedules/:id/history  — Run history for a schedule
 */

import express from "express";
import { z } from "zod";
import {
  createPaymentSchedule,
  getPaymentSchedule,
  getSchedulesByContract,
  updatePaymentSchedule,
  deletePaymentSchedule,
  computeNextRunAt,
  getScheduleHistory,
} from "../database/payment-schedules.js";
import { validateContractIdMiddleware } from "../validation.js";
import { sendError } from "../error-response.js";
import { addAuditLog } from "../database/audit.js";
import logger from "../logger.js";

const router = express.Router();

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const VALID_SCHEDULE_TYPES = ["monthly", "biweekly", "weekly", "custom"];
const VALID_TIMEZONES = [
  "UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
  "America/Sao_Paulo", "Europe/London", "Europe/Berlin", "Europe/Paris", "Europe/Moscow",
  "Asia/Dubai", "Asia/Kolkata", "Asia/Tokyo", "Asia/Shanghai", "Australia/Sydney",
  "Pacific/Auckland",
];

const createScheduleSchema = z
  .object({
    name: z.string().min(1).max(100),
    contractId: z.string().regex(/^C[A-Z2-7]{55}$/, "Invalid contract ID"),
    schedule_type: z.enum(["monthly", "biweekly", "weekly", "custom"]),
    day_of_month: z.number().int().min(1).max(28).optional(),
    day_of_week: z.number().int().min(0).max(6).optional(),
    hour_of_day: z.number().int().min(0).max(23).optional().default(9),
    timezone: z.string().min(1).max(50).optional().default("UTC"),
    enabled: z.boolean().optional().default(true),
    created_by: z.string().max(100).optional().default("admin"),
  })
  .superRefine((d, ctx) => {
    if (d.schedule_type === "monthly" && !d.day_of_month) {
      ctx.addIssue({ code: "custom", path: ["day_of_month"], message: "day_of_month required for monthly schedule" });
    }
    if (d.schedule_type === "weekly" && d.day_of_week === undefined) {
      ctx.addIssue({ code: "custom", path: ["day_of_week"], message: "day_of_week required for weekly schedule" });
    }
  });

const updateScheduleSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  schedule_type: z.enum(["monthly", "biweekly", "weekly", "custom"]).optional(),
  day_of_month: z.number().int().min(1).max(28).optional(),
  day_of_week: z.number().int().min(0).max(6).optional(),
  hour_of_day: z.number().int().min(0).max(23).optional(),
  timezone: z.string().min(1).max(50).optional(),
  enabled: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseScheduleId(raw, res) {
  const id = parseInt(raw, 10);
  if (isNaN(id) || id <= 0) {
    sendError(res, 400, "invalid_schedule_id", "Invalid schedule ID");
    return null;
  }
  return id;
}

/**
 * Generate the next N upcoming run timestamps for a schedule.
 */
function getUpcomingRuns(schedule, count = 5) {
  const upcoming = [];
  let from = new Date();
  for (let i = 0; i < count; i++) {
    const next = computeNextRunAt(schedule, from);
    upcoming.push(next);
    from = new Date(new Date(next).getTime() + 60 * 1000); // 1 min past to advance
  }
  return upcoming;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/payment-schedules
 * Create a new payment schedule template.
 */
router.post("/", (req, res) => {
  const result = createScheduleSchema.safeParse(req.body);
  if (!result.success) {
    return sendError(res, 400, "validation_error", result.error.issues[0]?.message ?? "Validation failed");
  }

  try {
    const schedule = createPaymentSchedule(result.data);

    addAuditLog(result.data.contractId, "payment_schedule_created", result.data.created_by, {
      scheduleId: schedule.id,
      name: schedule.name,
      schedule_type: schedule.schedule_type,
      next_run_at: schedule.next_run_at,
    });

    logger.info("Payment schedule created", { scheduleId: schedule.id, contractId: result.data.contractId });

    return res.status(201).json({
      success: true,
      data: schedule,
      upcoming: getUpcomingRuns(schedule, 3),
    });
  } catch (err) {
    logger.error("Failed to create payment schedule", { error: err.message });
    return sendError(res, 500, "internal_server_error", err.message ?? "Failed to create schedule");
  }
});

/**
 * GET /api/v1/payment-schedules/:contractId
 * List schedules for a contract.
 */
router.get("/:contractId", validateContractIdMiddleware, (req, res) => {
  try {
    const schedules = getSchedulesByContract(req.params.contractId);

    const enriched = schedules.map((s) => ({
      ...s,
      upcoming: getUpcomingRuns(s, 3),
    }));

    return res.json({ success: true, data: enriched });
  } catch (err) {
    logger.error("Failed to list payment schedules", { error: err.message });
    return sendError(res, 500, "internal_server_error", err.message ?? "Failed to list schedules");
  }
});

/**
 * PATCH /api/v1/payment-schedules/schedule/:id
 * Update a payment schedule.
 */
router.patch("/schedule/:id", (req, res) => {
  const id = parseScheduleId(req.params.id, res);
  if (!id) return;

  const result = updateScheduleSchema.safeParse(req.body);
  if (!result.success) {
    return sendError(res, 400, "validation_error", result.error.issues[0]?.message ?? "Validation failed");
  }

  try {
    const updated = updatePaymentSchedule(id, result.data);
    if (!updated) {
      return sendError(res, 404, "not_found", "Payment schedule not found");
    }

    addAuditLog(updated.contractId, "payment_schedule_updated", "admin", {
      scheduleId: id,
      changes: result.data,
    });

    return res.json({
      success: true,
      data: updated,
      upcoming: getUpcomingRuns(updated, 3),
    });
  } catch (err) {
    logger.error("Failed to update payment schedule", { error: err.message });
    return sendError(res, 500, "internal_server_error", err.message ?? "Failed to update schedule");
  }
});

/**
 * DELETE /api/v1/payment-schedules/schedule/:id
 * Delete a payment schedule.
 */
router.delete("/schedule/:id", (req, res) => {
  const id = parseScheduleId(req.params.id, res);
  if (!id) return;

  try {
    const schedule = getPaymentSchedule(id);
    if (!schedule) {
      return sendError(res, 404, "not_found", "Payment schedule not found");
    }

    const deleted = deletePaymentSchedule(id);
    if (!deleted) {
      return sendError(res, 404, "not_found", "Payment schedule not found");
    }

    addAuditLog(schedule.contractId, "payment_schedule_deleted", "admin", { scheduleId: id });

    return res.json({ success: true, message: "Payment schedule deleted" });
  } catch (err) {
    logger.error("Failed to delete payment schedule", { error: err.message });
    return sendError(res, 500, "internal_server_error", err.message ?? "Failed to delete schedule");
  }
});

/**
 * GET /api/v1/payment-schedules/schedule/:id/upcoming
 * Preview upcoming run times for a schedule.
 */
router.get("/schedule/:id/upcoming", (req, res) => {
  const id = parseScheduleId(req.params.id, res);
  if (!id) return;

  const count = Math.min(Math.max(parseInt(req.query.count) || 5, 1), 20);

  try {
    const schedule = getPaymentSchedule(id);
    if (!schedule) {
      return sendError(res, 404, "not_found", "Payment schedule not found");
    }

    const upcoming = getUpcomingRuns(schedule, count);

    return res.json({
      success: true,
      scheduleId: id,
      name: schedule.name,
      schedule_type: schedule.schedule_type,
      timezone: schedule.timezone,
      upcoming,
    });
  } catch (err) {
    logger.error("Failed to get upcoming runs", { error: err.message });
    return sendError(res, 500, "internal_server_error", err.message ?? "Failed to get upcoming runs");
  }
});

/**
 * GET /api/v1/payment-schedules/schedule/:id/history
 * Get run history for a schedule.
 */
router.get("/schedule/:id/history", (req, res) => {
  const id = parseScheduleId(req.params.id, res);
  if (!id) return;

  const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);

  try {
    const schedule = getPaymentSchedule(id);
    if (!schedule) {
      return sendError(res, 404, "not_found", "Payment schedule not found");
    }

    const history = getScheduleHistory(id, limit);

    return res.json({
      success: true,
      scheduleId: id,
      data: history,
    });
  } catch (err) {
    logger.error("Failed to get schedule history", { error: err.message });
    return sendError(res, 500, "internal_server_error", err.message ?? "Failed to get schedule history");
  }
});

export { router as paymentSchedulesRouter };
