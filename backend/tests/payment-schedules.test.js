/**
 * Tests for Payment Schedule Templates (#599).
 */
import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";

const mockCreatePaymentSchedule = jest.fn();
const mockGetPaymentSchedule = jest.fn();
const mockGetSchedulesByContract = jest.fn();
const mockUpdatePaymentSchedule = jest.fn();
const mockDeletePaymentSchedule = jest.fn();
const mockGetScheduleHistory = jest.fn();
const mockComputeNextRunAt = jest.fn();
const mockAddAuditLog = jest.fn();

await jest.unstable_mockModule("../src/database/payment-schedules.js", () => ({
  createPaymentSchedule: mockCreatePaymentSchedule,
  getPaymentSchedule: mockGetPaymentSchedule,
  getSchedulesByContract: mockGetSchedulesByContract,
  updatePaymentSchedule: mockUpdatePaymentSchedule,
  deletePaymentSchedule: mockDeletePaymentSchedule,
  getScheduleHistory: mockGetScheduleHistory,
  computeNextRunAt: mockComputeNextRunAt,
}));

await jest.unstable_mockModule("../src/database/audit.js", () => ({
  addAuditLog: mockAddAuditLog,
}));

await jest.unstable_mockModule("../src/database/index.js", () => ({
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 12),
}));

import express from "express";
const { paymentSchedulesRouter } = await import("../src/routes/payment-schedules.js");

// Import the real computeNextRunAt at top level (not inside describe) for unit tests
const { computeNextRunAt: realCompute } = await import("../src/database/payment-schedules.js");

const app = express();
app.use(express.json());
app.use("/api/v1/payment-schedules", paymentSchedulesRouter);
app.use((err, _req, res, _next) => {
  res.status(500).json({ error: err.message ?? "Internal error" });
});

const CONTRACT_ID = "CAFQE4X7R7X7R7X7R7X7R7X7R7X7R7X7R7X7R7X7R7X7R7X7R7X7R7";

const mockSchedule = (overrides = {}) => ({
  id: 1,
  name: "Monthly Payroll",
  contractId: CONTRACT_ID,
  schedule_type: "monthly",
  day_of_month: 1,
  day_of_week: null,
  hour_of_day: 9,
  timezone: "UTC",
  enabled: 1,
  created_by: "admin",
  next_run_at: "2026-08-01T09:00:00.000Z",
  last_run_at: null,
  created_at: "2026-07-01T00:00:00.000Z",
  updated_at: "2026-07-01T00:00:00.000Z",
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockComputeNextRunAt.mockReturnValue("2026-08-01T09:00:00.000Z");
  mockCreatePaymentSchedule.mockReturnValue(mockSchedule());
  mockGetPaymentSchedule.mockReturnValue(mockSchedule());
  mockGetSchedulesByContract.mockReturnValue([mockSchedule()]);
  mockUpdatePaymentSchedule.mockReturnValue(mockSchedule({ name: "Updated" }));
  mockDeletePaymentSchedule.mockReturnValue(true);
  mockGetScheduleHistory.mockReturnValue([]);
});

// ---------------------------------------------------------------------------
// Create schedule
// ---------------------------------------------------------------------------

describe("POST /api/v1/payment-schedules — Create Schedule", () => {
  test("creates a monthly schedule", async () => {
    const res = await request(app)
      .post("/api/v1/payment-schedules")
      .send({
        name: "Monthly Payroll",
        contractId: CONTRACT_ID,
        schedule_type: "monthly",
        day_of_month: 1,
        hour_of_day: 9,
        timezone: "UTC",
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.schedule_type).toBe("monthly");
    expect(mockCreatePaymentSchedule).toHaveBeenCalled();
  });

  test("creates a weekly schedule", async () => {
    mockCreatePaymentSchedule.mockReturnValue(mockSchedule({ schedule_type: "weekly", day_of_week: 1 }));
    const res = await request(app)
      .post("/api/v1/payment-schedules")
      .send({
        name: "Weekly Payments",
        contractId: CONTRACT_ID,
        schedule_type: "weekly",
        day_of_week: 1,
      });

    expect(res.status).toBe(201);
    expect(mockCreatePaymentSchedule).toHaveBeenCalled();
  });

  test("creates a biweekly schedule", async () => {
    mockCreatePaymentSchedule.mockReturnValue(mockSchedule({ schedule_type: "biweekly" }));
    const res = await request(app)
      .post("/api/v1/payment-schedules")
      .send({
        name: "Biweekly",
        contractId: CONTRACT_ID,
        schedule_type: "biweekly",
      });

    expect(res.status).toBe(201);
  });

  test("rejects monthly schedule without day_of_month", async () => {
    const res = await request(app)
      .post("/api/v1/payment-schedules")
      .send({
        name: "Bad Monthly",
        contractId: CONTRACT_ID,
        schedule_type: "monthly",
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("validation_error");
  });

  test("rejects weekly schedule without day_of_week", async () => {
    const res = await request(app)
      .post("/api/v1/payment-schedules")
      .send({
        name: "Bad Weekly",
        contractId: CONTRACT_ID,
        schedule_type: "weekly",
      });

    expect(res.status).toBe(400);
  });

  test("rejects invalid contract ID", async () => {
    const res = await request(app)
      .post("/api/v1/payment-schedules")
      .send({
        name: "Test",
        contractId: "NOT_A_CONTRACT",
        schedule_type: "monthly",
        day_of_month: 1,
      });

    expect(res.status).toBe(400);
  });

  test("includes upcoming run times in response", async () => {
    const res = await request(app)
      .post("/api/v1/payment-schedules")
      .send({
        name: "Monthly",
        contractId: CONTRACT_ID,
        schedule_type: "monthly",
        day_of_month: 1,
      });

    expect(res.body.upcoming).toBeDefined();
    expect(Array.isArray(res.body.upcoming)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// List schedules
// ---------------------------------------------------------------------------

describe("GET /api/v1/payment-schedules/:contractId — List Schedules", () => {
  test("returns schedules for a contract", async () => {
    const res = await request(app).get(`/api/v1/payment-schedules/${CONTRACT_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].name).toBe("Monthly Payroll");
  });

  test("enriches schedules with upcoming run times", async () => {
    const res = await request(app).get(`/api/v1/payment-schedules/${CONTRACT_ID}`);
    expect(res.body.data[0].upcoming).toBeDefined();
  });

  test("rejects invalid contract ID", async () => {
    const res = await request(app).get("/api/v1/payment-schedules/BADCONTRACT");
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Update schedule
// ---------------------------------------------------------------------------

describe("PATCH /api/v1/payment-schedules/schedule/:id", () => {
  test("updates schedule fields", async () => {
    const res = await request(app)
      .patch("/api/v1/payment-schedules/schedule/1")
      .send({ name: "Updated", enabled: false });

    expect(res.status).toBe(200);
    expect(mockUpdatePaymentSchedule).toHaveBeenCalledWith(1, expect.objectContaining({ name: "Updated", enabled: false }));
  });

  test("returns 404 for non-existent schedule", async () => {
    mockUpdatePaymentSchedule.mockReturnValue(null);
    const res = await request(app)
      .patch("/api/v1/payment-schedules/schedule/999")
      .send({ enabled: false });

    expect(res.status).toBe(404);
  });

  test("rejects invalid schedule ID", async () => {
    const res = await request(app)
      .patch("/api/v1/payment-schedules/schedule/abc")
      .send({ enabled: false });

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Delete schedule
// ---------------------------------------------------------------------------

describe("DELETE /api/v1/payment-schedules/schedule/:id", () => {
  test("deletes a schedule", async () => {
    const res = await request(app).delete("/api/v1/payment-schedules/schedule/1");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test("returns 404 for non-existent schedule", async () => {
    mockGetPaymentSchedule.mockReturnValue(null);
    const res = await request(app).delete("/api/v1/payment-schedules/schedule/999");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Upcoming runs
// ---------------------------------------------------------------------------

describe("GET /api/v1/payment-schedules/schedule/:id/upcoming", () => {
  test("returns upcoming run times", async () => {
    const res = await request(app).get("/api/v1/payment-schedules/schedule/1/upcoming?count=3");
    expect(res.status).toBe(200);
    expect(res.body.upcoming).toBeDefined();
    expect(res.body.name).toBe("Monthly Payroll");
  });

  test("returns 404 for non-existent schedule", async () => {
    mockGetPaymentSchedule.mockReturnValue(null);
    const res = await request(app).get("/api/v1/payment-schedules/schedule/999/upcoming");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

describe("GET /api/v1/payment-schedules/schedule/:id/history", () => {
  test("returns run history", async () => {
    mockGetScheduleHistory.mockReturnValue([
      { id: 1, scheduleId: 1, contractId: CONTRACT_ID, status: "triggered", triggered_at: "2026-07-01T09:00:00Z" },
    ]);
    const res = await request(app).get("/api/v1/payment-schedules/schedule/1/history");
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// computeNextRunAt unit tests
// ---------------------------------------------------------------------------

describe("computeNextRunAt", () => {
  test("monthly: returns next occurrence of day_of_month", () => {
    const base = new Date("2026-07-15T10:00:00Z");
    const next = realCompute({ schedule_type: "monthly", day_of_month: 1, hour_of_day: 9 }, base);
    expect(next).toMatch(/2026-08-01/);
  });

  test("monthly: same day but already passed, advances to next month", () => {
    const base = new Date("2026-07-01T10:00:00Z"); // past the 9:00 mark
    const next = realCompute({ schedule_type: "monthly", day_of_month: 1, hour_of_day: 9 }, base);
    expect(next).toMatch(/2026-08-01/);
  });

  test("weekly: returns correct day of week", () => {
    const base = new Date("2026-07-27T00:00:00Z"); // Monday
    // Request next Wednesday (day 3)
    const next = realCompute({ schedule_type: "weekly", day_of_week: 3, hour_of_day: 9 }, base);
    expect(next).toMatch(/2026-07-29/); // Wednesday
  });

  test("biweekly: returns 14 days ahead", () => {
    const base = new Date("2026-07-01T00:00:00Z");
    const next = realCompute({ schedule_type: "biweekly", hour_of_day: 9 }, base);
    const diff = (new Date(next).getTime() - base.getTime()) / (24 * 60 * 60 * 1000);
    expect(diff).toBe(14);
  });
});
