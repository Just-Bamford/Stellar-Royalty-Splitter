/**
 * Tests for batch payment processing and distribution scheduler (#991).
 *
 * Three test suites:
 *  1. distribution-scheduler unit tests — computeNextRunAt, computeNextRunAfter, runSchedulerTick
 *  2. batch-processor unit tests        — executeBatch happy path, per-item failure isolation
 *  3. schedules/batch route integration — HTTP layer via supertest
 */

import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";

// ─────────────────────────────────────────────────────────────────────────────
// Shared test fixtures
// ─────────────────────────────────────────────────────────────────────────────

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WALLET   = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TOKEN    = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1 — distribution-scheduler unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe("distribution-scheduler — computeNextRunAt", () => {
  // Import the pure functions directly — no DB or Stellar mocking needed
  const { computeNextRunAt, computeNextRunAfter } = await import(
    "../src/services/distribution-scheduler.js"
  );

  // A fixed reference Monday 2026-09-28 12:00 UTC
  const MONDAY_NOON = new Date("2026-09-28T12:00:00.000Z"); // getUTCDay() === 1

  test("weekly — same weekday but future hour returns today", () => {
    const schedule = {
      frequency: "weekly",
      dayOfWeek: 1, // Monday
      dayOfMonth: null,
      hourOfDay: 14, // 14:00 UTC — two hours after now
      minuteOfHour: 0,
    };
    const result = new Date(computeNextRunAt(schedule, MONDAY_NOON));
    expect(result.getUTCDay()).toBe(1);
    expect(result.getUTCHours()).toBe(14);
  });

  test("weekly — same weekday but past hour advances 7 days", () => {
    const schedule = {
      frequency: "weekly",
      dayOfWeek: 1,
      dayOfMonth: null,
      hourOfDay: 10, // 10:00 UTC — already passed
      minuteOfHour: 0,
    };
    const result = new Date(computeNextRunAt(schedule, MONDAY_NOON));
    expect(result.getUTCDay()).toBe(1);
    // Should be next Monday — 7 days later
    const diffMs = result - MONDAY_NOON;
    expect(diffMs).toBeGreaterThan(0);
    expect(result.getUTCDate()).toBe(MONDAY_NOON.getUTCDate() + 7);
  });

  test("weekly — different weekday picks the correct upcoming day", () => {
    const schedule = {
      frequency: "weekly",
      dayOfWeek: 5, // Friday
      dayOfMonth: null,
      hourOfDay: 9,
      minuteOfHour: 0,
    };
    const result = new Date(computeNextRunAt(schedule, MONDAY_NOON));
    expect(result.getUTCDay()).toBe(5); // Friday
    // From Monday to Friday = 4 days
    expect(result.getUTCDate()).toBe(MONDAY_NOON.getUTCDate() + 4);
  });

  test("biweekly — advances 14 days from last run", () => {
    const schedule = {
      frequency: "biweekly",
      dayOfWeek: 1,
      dayOfMonth: null,
      hourOfDay: 9,
      minuteOfHour: 0,
    };
    const lastRun = new Date("2026-09-28T09:00:00.000Z"); // Monday
    const next = new Date(computeNextRunAfter(schedule, lastRun));
    const diffDays = (next - lastRun) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBe(14);
    expect(next.getUTCDay()).toBe(1); // still Monday
  });

  test("monthly — picks the given day of the current month if future", () => {
    const schedule = {
      frequency: "monthly",
      dayOfWeek: null,
      dayOfMonth: 28,
      hourOfDay: 9,
      minuteOfHour: 0,
    };
    // 2026-09-28 12:00 — day 28 at 09:00 has already passed
    const result = new Date(computeNextRunAt(schedule, MONDAY_NOON));
    // Should land in October
    expect(result.getUTCMonth()).toBe(9); // October (0-indexed)
    expect(result.getUTCDate()).toBe(28);
  });

  test("monthly — computeNextRunAfter advances by exactly one month", () => {
    const schedule = {
      frequency: "monthly",
      dayOfWeek: null,
      dayOfMonth: 15,
      hourOfDay: 10,
      minuteOfHour: 0,
    };
    const lastRun = new Date("2026-09-15T10:00:00.000Z");
    const next = new Date(computeNextRunAfter(schedule, lastRun));
    expect(next.getUTCMonth()).toBe(9); // October (0-indexed)
    expect(next.getUTCDate()).toBe(15);
  });

  test("unknown frequency throws", () => {
    const schedule = {
      frequency: "daily",
      dayOfWeek: null,
      dayOfMonth: null,
      hourOfDay: 0,
      minuteOfHour: 0,
    };
    expect(() => computeNextRunAt(schedule, MONDAY_NOON)).toThrow(
      /unknown schedule frequency/i
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2 — batch-processor unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe("batch-processor — executeBatch", () => {
  // Per-suite mocks
  const retryBuildTx = jest.fn();
  const recordTransactionMock = jest.fn(() => 42);
  const addAuditLogMock = jest.fn();
  const createBatchExecutionMock = jest.fn(() => 1);
  const markBatchRunningMock = jest.fn();
  const markBatchCompletedMock = jest.fn();
  const markBatchFailedMock = jest.fn();
  const recordBatchItemMock = jest.fn();

  // db.transaction needs to immediately invoke the callback and return a function
  const transactionMock = jest.fn((fn) => () => fn());

  await jest.unstable_mockModule("../src/stellar.js", () => ({
    retryBuildTx,
    addressToScVal: jest.fn((a) => a),
  }));

  await jest.unstable_mockModule("../src/database/index.js", () => ({
    recordTransaction: recordTransactionMock,
    addAuditLog: addAuditLogMock,
    createBatchExecution: createBatchExecutionMock,
    markBatchRunning: markBatchRunningMock,
    markBatchCompleted: markBatchCompletedMock,
    markBatchFailed: markBatchFailedMock,
    recordBatchItem: recordBatchItemMock,
  }));

  await jest.unstable_mockModule("../src/database/core.js", () => ({
    db: { transaction: transactionMock },
    countWrite: jest.fn(),
  }));

  const { executeBatch } = await import("../src/services/batch-processor.js");

  beforeEach(() => jest.clearAllMocks());

  test("returns correct summary for a fully successful batch", async () => {
    retryBuildTx.mockResolvedValue("signed-xdr");

    const result = await executeBatch(
      [
        { contractId: CONTRACT, walletAddress: WALLET, tokenId: TOKEN },
        { contractId: CONTRACT, walletAddress: WALLET, tokenId: TOKEN },
      ],
      null
    );

    expect(result.totalItems).toBe(2);
    expect(result.successCount).toBe(2);
    expect(result.failureCount).toBe(0);
    expect(result.batchId).toBe(1);
    expect(createBatchExecutionMock).toHaveBeenCalledWith(null, 2);
    expect(markBatchRunningMock).toHaveBeenCalledWith(1);
    expect(markBatchCompletedMock).toHaveBeenCalledWith(1, 2, 0);
    expect(recordBatchItemMock).toHaveBeenCalledTimes(2);
  });

  test("isolates per-item failures — other items still succeed", async () => {
    retryBuildTx
      .mockResolvedValueOnce("xdr-ok")
      .mockRejectedValueOnce(new Error("RPC timeout"));

    const result = await executeBatch(
      [
        { contractId: CONTRACT, walletAddress: WALLET, tokenId: TOKEN },
        { contractId: CONTRACT, walletAddress: WALLET, tokenId: TOKEN },
      ],
      null
    );

    expect(result.successCount).toBe(1);
    expect(result.failureCount).toBe(1);
    // First item succeeded
    expect(result.results[0].status).toBe("success");
    expect(result.results[0].xdr).toBe("xdr-ok");
    // Second item failed but recorded
    expect(result.results[1].status).toBe("failed");
    expect(result.results[1].errorMessage).toMatch(/rpc timeout/i);
    // Batch still completes (not throws)
    expect(markBatchCompletedMock).toHaveBeenCalledWith(1, 1, 1);
    expect(markBatchFailedMock).not.toHaveBeenCalled();
  });

  test("fully failed batch still calls markBatchCompleted with 0 success", async () => {
    retryBuildTx.mockRejectedValue(new Error("network error"));

    const result = await executeBatch(
      [{ contractId: CONTRACT, walletAddress: WALLET, tokenId: TOKEN }],
      null
    );

    expect(result.successCount).toBe(0);
    expect(result.failureCount).toBe(1);
    expect(markBatchCompletedMock).toHaveBeenCalledWith(1, 0, 1);
  });

  test("throws and calls markBatchFailed when db.transaction throws", async () => {
    retryBuildTx.mockResolvedValue("xdr-ok");
    // Make the transaction wrapper throw on invocation
    transactionMock.mockImplementationOnce(() => () => {
      throw new Error("DB write failed");
    });

    await expect(
      executeBatch(
        [{ contractId: CONTRACT, walletAddress: WALLET, tokenId: TOKEN }],
        null
      )
    ).rejects.toThrow("DB write failed");

    expect(markBatchFailedMock).toHaveBeenCalledWith(1, "DB write failed");
  });

  test("rejects with error when items array is empty", async () => {
    await expect(executeBatch([], null)).rejects.toThrow(
      /non-empty items array/i
    );
  });

  test("passes scheduleId through to createBatchExecution", async () => {
    retryBuildTx.mockResolvedValue("xdr");
    await executeBatch(
      [{ contractId: CONTRACT, walletAddress: WALLET, tokenId: TOKEN }],
      99
    );
    expect(createBatchExecutionMock).toHaveBeenCalledWith(99, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 3 — schedules & batch route integration tests
// ─────────────────────────────────────────────────────────────────────────────

describe("schedules & batch routes — integration", () => {
  // ── DB mock stubs (overridden per-test as needed) ──────────────────────────

  const createScheduleMock         = jest.fn(() => 1);
  const getScheduleByIdMock        = jest.fn();
  const listSchedulesByContractMock = jest.fn(() => []);
  const countSchedulesByContractMock = jest.fn(() => 0);
  const updateScheduleMock         = jest.fn(() => true);
  const deleteScheduleMock         = jest.fn(() => true);
  const getBatchExecutionMock      = jest.fn(() => ({ execution: null, items: [] }));
  const listBatchExecutionsByScheduleMock = jest.fn(() => []);
  const listRecentBatchExecutionsMock = jest.fn(() => []);
  const addAuditLogMock            = jest.fn();
  const executeBatchMock           = jest.fn();

  const mockSchedule = {
    id: 1,
    contractId: CONTRACT,
    walletAddress: WALLET,
    tokenId: TOKEN,
    frequency: "weekly",
    dayOfWeek: 5,
    dayOfMonth: null,
    hourOfDay: 9,
    minuteOfHour: 0,
    enabled: 1,
    nextRunAt: "2026-10-02T09:00:00.000Z",
    lastRunAt: null,
    lastRunStatus: null,
    createdAt: "2026-09-28T12:00:00.000Z",
    updatedAt: "2026-09-28T12:00:00.000Z",
  };

  await jest.unstable_mockModule("../src/database/index.js", () => ({
    createSchedule: createScheduleMock,
    getScheduleById: getScheduleByIdMock,
    listSchedulesByContract: listSchedulesByContractMock,
    countSchedulesByContract: countSchedulesByContractMock,
    updateSchedule: updateScheduleMock,
    deleteSchedule: deleteScheduleMock,
    getBatchExecution: getBatchExecutionMock,
    listBatchExecutionsBySchedule: listBatchExecutionsByScheduleMock,
    listRecentBatchExecutions: listRecentBatchExecutionsMock,
    addAuditLog: addAuditLogMock,
    // other functions the route module doesn't use but that other app modules do
    recordTransaction: jest.fn(),
    initializeDatabase: jest.fn(),
    getMigrationVersion: jest.fn(() => 8),
  }));

  await jest.unstable_mockModule("../src/services/batch-processor.js", () => ({
    executeBatch: executeBatchMock,
  }));

  // computeNextRunAt is a pure function — use the real implementation
  // by NOT mocking distribution-scheduler

  const { default: app } = await import("./app.js");

  beforeEach(() => jest.clearAllMocks());

  // ── GET /api/v1/schedules ────────────────────────────────────────────────

  test("GET /api/v1/schedules — 400 when contractId missing", async () => {
    const res = await request(app).get("/api/v1/schedules");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("missing_parameter");
  });

  test("GET /api/v1/schedules — 400 for invalid contractId", async () => {
    const res = await request(app).get("/api/v1/schedules?contractId=INVALID");
    expect(res.status).toBe(400);
  });

  test("GET /api/v1/schedules — returns list with pagination meta", async () => {
    listSchedulesByContractMock.mockReturnValueOnce([mockSchedule]);
    countSchedulesByContractMock.mockReturnValueOnce(1);

    const res = await request(app).get(`/api/v1/schedules?contractId=${CONTRACT}`);
    expect(res.status).toBe(200);
    expect(res.body.schedules).toHaveLength(1);
    expect(res.body.total).toBe(1);
    expect(res.body.schedules[0].contractId).toBe(CONTRACT);
  });

  // ── POST /api/v1/schedules ───────────────────────────────────────────────

  const validWeeklyBody = {
    contractId: CONTRACT,
    walletAddress: WALLET,
    tokenId: TOKEN,
    frequency: "weekly",
    dayOfWeek: 5,
    hourOfDay: 9,
    minuteOfHour: 0,
  };

  test("POST /api/v1/schedules — 201 and returns schedule on success", async () => {
    getScheduleByIdMock.mockReturnValueOnce(mockSchedule);

    const res = await request(app).post("/api/v1/schedules").send(validWeeklyBody);
    expect(res.status).toBe(201);
    expect(res.body.schedule).toMatchObject({ id: 1, frequency: "weekly" });
    expect(createScheduleMock).toHaveBeenCalledTimes(1);
    expect(addAuditLogMock).toHaveBeenCalledWith(
      CONTRACT,
      "schedule_created",
      WALLET,
      expect.objectContaining({ scheduleId: 1 })
    );
  });

  test("POST /api/v1/schedules — 400 when frequency is invalid", async () => {
    const res = await request(app)
      .post("/api/v1/schedules")
      .send({ ...validWeeklyBody, frequency: "daily" });
    expect(res.status).toBe(400);
    expect(createScheduleMock).not.toHaveBeenCalled();
  });

  test("POST /api/v1/schedules — 400 when dayOfWeek missing for weekly", async () => {
    // eslint-disable-next-line no-unused-vars
    const { dayOfWeek: _dayOfWeek, ...body } = validWeeklyBody;
    const res = await request(app).post("/api/v1/schedules").send(body);
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "dayOfWeek" }),
      ])
    );
  });

  test("POST /api/v1/schedules — 400 when dayOfMonth missing for monthly", async () => {
    const res = await request(app)
      .post("/api/v1/schedules")
      .send({ ...validWeeklyBody, frequency: "monthly", dayOfWeek: undefined });
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "dayOfMonth" }),
      ])
    );
  });

  test("POST /api/v1/schedules — 400 when contractId is not a contract address", async () => {
    const res = await request(app)
      .post("/api/v1/schedules")
      .send({ ...validWeeklyBody, contractId: WALLET }); // G-address instead of C
    expect(res.status).toBe(400);
  });

  // ── GET /api/v1/schedules/:id ────────────────────────────────────────────

  test("GET /api/v1/schedules/:id — 200 returns schedule", async () => {
    getScheduleByIdMock.mockReturnValueOnce(mockSchedule);
    const res = await request(app).get("/api/v1/schedules/1");
    expect(res.status).toBe(200);
    expect(res.body.schedule.id).toBe(1);
  });

  test("GET /api/v1/schedules/:id — 404 when not found", async () => {
    getScheduleByIdMock.mockReturnValueOnce(null);
    const res = await request(app).get("/api/v1/schedules/999");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("schedule_not_found");
  });

  test("GET /api/v1/schedules/:id — 400 for non-integer id", async () => {
    const res = await request(app).get("/api/v1/schedules/abc");
    expect(res.status).toBe(400);
  });

  // ── PATCH /api/v1/schedules/:id ──────────────────────────────────────────

  test("PATCH /api/v1/schedules/:id — 200 updates timing and re-computes nextRunAt", async () => {
    getScheduleByIdMock
      .mockReturnValueOnce(mockSchedule)     // existence check
      .mockReturnValueOnce({ ...mockSchedule, hourOfDay: 14 }); // after update

    const res = await request(app)
      .patch("/api/v1/schedules/1")
      .send({ hourOfDay: 14 });

    expect(res.status).toBe(200);
    expect(updateScheduleMock).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ hourOfDay: 14, nextRunAt: expect.any(String) })
    );
  });

  test("PATCH /api/v1/schedules/:id — pausing sets enabled=0", async () => {
    getScheduleByIdMock
      .mockReturnValueOnce(mockSchedule)
      .mockReturnValueOnce({ ...mockSchedule, enabled: 0 });

    const res = await request(app)
      .patch("/api/v1/schedules/1")
      .send({ enabled: false });

    expect(res.status).toBe(200);
    expect(updateScheduleMock).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ enabled: 0 })
    );
  });

  test("PATCH /api/v1/schedules/:id — 404 when schedule not found", async () => {
    getScheduleByIdMock.mockReturnValueOnce(null);
    const res = await request(app)
      .patch("/api/v1/schedules/999")
      .send({ hourOfDay: 10 });
    expect(res.status).toBe(404);
  });

  test("PATCH /api/v1/schedules/:id — 400 when body has no recognised fields", async () => {
    getScheduleByIdMock.mockReturnValueOnce(mockSchedule);
    const res = await request(app)
      .patch("/api/v1/schedules/1")
      .send({ unknownField: "x" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("no_changes");
  });

  // ── DELETE /api/v1/schedules/:id ─────────────────────────────────────────

  test("DELETE /api/v1/schedules/:id — 204 on success", async () => {
    getScheduleByIdMock.mockReturnValueOnce(mockSchedule);
    const res = await request(app).delete("/api/v1/schedules/1");
    expect(res.status).toBe(204);
    expect(deleteScheduleMock).toHaveBeenCalledWith(1);
    expect(addAuditLogMock).toHaveBeenCalledWith(
      CONTRACT,
      "schedule_deleted",
      WALLET,
      expect.objectContaining({ scheduleId: 1 })
    );
  });

  test("DELETE /api/v1/schedules/:id — 404 when not found", async () => {
    getScheduleByIdMock.mockReturnValueOnce(null);
    const res = await request(app).delete("/api/v1/schedules/999");
    expect(res.status).toBe(404);
    expect(deleteScheduleMock).not.toHaveBeenCalled();
  });

  // ── GET /api/v1/schedules/:id/history ────────────────────────────────────

  test("GET /api/v1/schedules/:id/history — 200 returns executions", async () => {
    getScheduleByIdMock.mockReturnValueOnce(mockSchedule);
    listBatchExecutionsByScheduleMock.mockReturnValueOnce([
      { id: 10, scheduleId: 1, status: "completed", successCount: 1, failureCount: 0 },
    ]);

    const res = await request(app).get("/api/v1/schedules/1/history");
    expect(res.status).toBe(200);
    expect(res.body.executions).toHaveLength(1);
    expect(res.body.executions[0].id).toBe(10);
  });

  test("GET /api/v1/schedules/:id/history — 404 when schedule not found", async () => {
    getScheduleByIdMock.mockReturnValueOnce(null);
    const res = await request(app).get("/api/v1/schedules/999/history");
    expect(res.status).toBe(404);
  });

  // ── GET /api/v1/schedules/:id/history/:batchId ───────────────────────────

  test("GET /api/v1/schedules/:id/history/:batchId — 200 returns batch detail", async () => {
    const mockExecution = { id: 10, scheduleId: 1, status: "completed" };
    const mockItems = [
      { id: 1, batchExecutionId: 10, contractId: CONTRACT, status: "success" },
    ];
    getScheduleByIdMock.mockReturnValueOnce(mockSchedule);
    getBatchExecutionMock.mockReturnValueOnce({ execution: mockExecution, items: mockItems });

    const res = await request(app).get("/api/v1/schedules/1/history/10");
    expect(res.status).toBe(200);
    expect(res.body.execution.id).toBe(10);
    expect(res.body.items).toHaveLength(1);
  });

  test("GET /api/v1/schedules/:id/history/:batchId — 404 batch belongs to different schedule", async () => {
    getScheduleByIdMock.mockReturnValueOnce(mockSchedule);
    // Batch belongs to scheduleId=2, not 1
    getBatchExecutionMock.mockReturnValueOnce({
      execution: { id: 10, scheduleId: 2, status: "completed" },
      items: [],
    });

    const res = await request(app).get("/api/v1/schedules/1/history/10");
    expect(res.status).toBe(404);
  });

  // ── POST /api/v1/batch ────────────────────────────────────────────────────

  const validBatchBody = {
    items: [
      { contractId: CONTRACT, walletAddress: WALLET, tokenId: TOKEN },
    ],
  };

  test("POST /api/v1/batch — 200 on full success", async () => {
    executeBatchMock.mockResolvedValue({
      batchId: 5,
      totalItems: 1,
      successCount: 1,
      failureCount: 0,
      results: [{ contractId: CONTRACT, status: "success", xdr: "xdr-val", transactionId: 1, errorMessage: null }],
    });

    const res = await request(app).post("/api/v1/batch").send(validBatchBody);
    expect(res.status).toBe(200);
    expect(res.body.batchId).toBe(5);
    expect(res.body.successCount).toBe(1);
  });

  test("POST /api/v1/batch — 207 on partial failure", async () => {
    executeBatchMock.mockResolvedValue({
      batchId: 6,
      totalItems: 2,
      successCount: 1,
      failureCount: 1,
      results: [
        { contractId: CONTRACT, status: "success", xdr: "xdr", transactionId: 1, errorMessage: null },
        { contractId: CONTRACT, status: "failed", xdr: null, transactionId: null, errorMessage: "RPC fail" },
      ],
    });

    const res = await request(app)
      .post("/api/v1/batch")
      .send({
        items: [
          { contractId: CONTRACT, walletAddress: WALLET, tokenId: TOKEN },
          { contractId: CONTRACT, walletAddress: WALLET, tokenId: TOKEN },
        ],
      });
    expect(res.status).toBe(207);
    expect(res.body.failureCount).toBe(1);
  });

  test("POST /api/v1/batch — 400 when items array is empty", async () => {
    const res = await request(app).post("/api/v1/batch").send({ items: [] });
    expect(res.status).toBe(400);
    expect(executeBatchMock).not.toHaveBeenCalled();
  });

  test("POST /api/v1/batch — 400 when items array exceeds 50 entries", async () => {
    const items = Array.from({ length: 51 }, () => ({
      contractId: CONTRACT,
      walletAddress: WALLET,
      tokenId: TOKEN,
    }));
    const res = await request(app).post("/api/v1/batch").send({ items });
    expect(res.status).toBe(400);
    expect(executeBatchMock).not.toHaveBeenCalled();
  });

  test("POST /api/v1/batch — 400 when an item has invalid walletAddress", async () => {
    const res = await request(app)
      .post("/api/v1/batch")
      .send({
        items: [{ contractId: CONTRACT, walletAddress: "NOT-VALID", tokenId: TOKEN }],
      });
    expect(res.status).toBe(400);
  });

  // ── GET /api/v1/batch/history ─────────────────────────────────────────────

  test("GET /api/v1/batch/history — 200 returns recent executions", async () => {
    listRecentBatchExecutionsMock.mockReturnValueOnce([
      { id: 1, scheduleId: null, status: "completed" },
    ]);
    const res = await request(app).get("/api/v1/batch/history");
    expect(res.status).toBe(200);
    expect(res.body.executions).toHaveLength(1);
  });

  // ── E2E flow: schedule creation + execution verification ──────────────────

  test("E2E — create schedule then retrieve it with nextRunAt set", async () => {
    // Step 1: create
    getScheduleByIdMock.mockReturnValueOnce(mockSchedule);
    const createRes = await request(app)
      .post("/api/v1/schedules")
      .send(validWeeklyBody);
    expect(createRes.status).toBe(201);
    const { schedule } = createRes.body;
    expect(schedule.nextRunAt).toBeTruthy();
    expect(new Date(schedule.nextRunAt).getUTCDay()).toBe(5); // Friday

    // Step 2: retrieve it
    getScheduleByIdMock.mockReturnValueOnce(mockSchedule);
    const getRes = await request(app).get(`/api/v1/schedules/${schedule.id}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.schedule.frequency).toBe("weekly");

    // Step 3: pause it
    getScheduleByIdMock
      .mockReturnValueOnce(mockSchedule)
      .mockReturnValueOnce({ ...mockSchedule, enabled: 0 });
    const pauseRes = await request(app)
      .patch(`/api/v1/schedules/${schedule.id}`)
      .send({ enabled: false });
    expect(pauseRes.status).toBe(200);
    expect(pauseRes.body.schedule.enabled).toBe(0);

    // Step 4: execute an ad-hoc batch for the same contract
    executeBatchMock.mockResolvedValue({
      batchId: 99,
      totalItems: 1,
      successCount: 1,
      failureCount: 0,
      results: [{ contractId: CONTRACT, status: "success", xdr: "xdr", transactionId: 1, errorMessage: null }],
    });
    const batchRes = await request(app)
      .post("/api/v1/batch")
      .send({ items: [{ contractId: CONTRACT, walletAddress: WALLET, tokenId: TOKEN }] });
    expect(batchRes.status).toBe(200);
    expect(batchRes.body.batchId).toBe(99);
  });
});
