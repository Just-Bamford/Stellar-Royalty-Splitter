import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import express from "express";
import request from "supertest";

const prepare = jest.fn();
const transaction = jest.fn((fn) => () => fn());
const countWrite = jest.fn();

await jest.unstable_mockModule("../src/database/core.js", () => ({
  db: {
    prepare,
    transaction,
  },
  countWrite,
}));

const {
  archiveContractEvents,
  getArchiveCutoffDate,
  getArchivedEvents,
  updateArchivePolicy,
} = await import("../src/database/archive.js");

describe("contract event archival database strategy", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.EVENT_ARCHIVE_ENABLED;
    delete process.env.EVENT_ARCHIVE_RETENTION_DAYS;
  });

  test("calculates the default 90 day archive cutoff", () => {
    const cutoff = getArchiveCutoffDate(90, new Date("2026-06-30T00:00:00.000Z"));

    expect(cutoff).toBe("2026-04-01T00:00:00.000Z");
  });

  test("skips archival when retention policy is disabled", () => {
    const result = archiveContractEvents({
      policy: { enabled: false, retentionDays: 90 },
    });

    expect(result).toMatchObject({
      archived: 0,
      enabled: false,
      retentionDays: 90,
      cutoff: null,
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  test("moves old events into the archive table in a bounded transaction", () => {
    const run = jest.fn();
    const all = jest.fn().mockReturnValue([{ id: 10 }, { id: 11 }]);

    prepare.mockImplementation((sql) => {
      if (sql.includes("SELECT id") && sql.includes("FROM transactions")) {
        return { all };
      }
      return { run };
    });

    const result = archiveContractEvents({
      policy: { enabled: true, retentionDays: 90 },
      cutoff: "2026-04-01T00:00:00.000Z",
      batchSize: 2,
    });

    expect(result).toMatchObject({
      archived: 2,
      enabled: true,
      retentionDays: 90,
      cutoff: "2026-04-01T00:00:00.000Z",
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(all).toHaveBeenCalledWith("2026-04-01T00:00:00.000Z", 2);
    expect(run).toHaveBeenCalledTimes(2);
    expect(prepare.mock.calls.some(([sql]) => sql.includes("INSERT OR IGNORE INTO contract_event_archive"))).toBe(true);
    expect(prepare.mock.calls.some(([sql]) => sql.includes("DELETE FROM transactions"))).toBe(true);
    expect(countWrite).toHaveBeenCalledTimes(1);
  });

  test("queries archived events and reconstructs payout JSON", () => {
    prepare.mockReturnValue({
      all: jest.fn().mockReturnValue([
        {
          id: 1,
          originalTransactionId: 22,
          contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          payoutCount: 1,
          payoutsJson: JSON.stringify([
            {
              collaboratorAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
              amountReceived: "100",
            },
          ]),
        },
      ]),
    });

    const rows = getArchivedEvents("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", 10, 0);

    expect(rows).toHaveLength(1);
    expect(rows[0].payouts).toEqual([
      {
        collaboratorAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        amountReceived: "100",
      },
    ]);
    expect(rows[0].payoutsJson).toBeUndefined();
  });

  test("updates retention policy configuration", () => {
    const get = jest
      .fn()
      .mockReturnValueOnce({ enabled: 1, retentionDays: 90, updatedAt: "old" })
      .mockReturnValueOnce({ enabled: 0, retentionDays: 120, updatedAt: "new" });
    const run = jest.fn();

    prepare.mockImplementation((sql) => {
      if (sql.includes("FROM event_archive_policy")) return { get };
      return { run };
    });

    const policy = updateArchivePolicy({ enabled: false, retentionDays: 120 });

    expect(run).toHaveBeenCalledWith(0, 120);
    expect(policy).toMatchObject({
      enabled: false,
      retentionDays: 120,
      updatedAt: "new",
    });
  });
});

const routeGetArchivedEvents = jest.fn();
const routeGetArchivedEventCount = jest.fn();
const routeGetArchivePolicy = jest.fn();
const routeUpdateArchivePolicy = jest.fn();
const routeArchiveContractEvents = jest.fn();

await jest.unstable_mockModule("../src/database/index.js", () => ({
  getTransactionHistory: jest.fn(),
  getTransactionCount: jest.fn(),
  getTransactionDetails: jest.fn(),
  getTransactionById: jest.fn(),
  getAuditLog: jest.fn(),
  addAuditLog: jest.fn(),
  updateTransactionStatus: jest.fn(),
  updateTransactionHash: jest.fn(),
  archiveContractEvents: routeArchiveContractEvents,
  getArchivePolicy: routeGetArchivePolicy,
  getArchivedEventCount: routeGetArchivedEventCount,
  getArchivedEvents: routeGetArchivedEvents,
  updateArchivePolicy: routeUpdateArchivePolicy,
}));

await jest.unstable_mockModule("../src/stellar.js", () => ({
  pollHorizonTransaction: jest.fn(),
}));

await jest.unstable_mockModule("../src/webhook-delivery.js", () => ({
  deliverDistributeWebhooks: jest.fn(),
}));

const { default: historyRouter } = await import("../src/routes/history.js");

const app = express();
app.use(express.json());
app.use("/api/v1", historyRouter);

describe("contract event archival routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("returns archived events through the archive query endpoint", async () => {
    routeGetArchivedEvents.mockReturnValue([{ id: 1, contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }]);
    routeGetArchivedEventCount.mockReturnValue(1);

    const res = await request(app)
      .get("/api/v1/archive/CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
      .query({ limit: 10, offset: 0 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      pagination: { limit: 10, offset: 0, total: 1 },
    });
    expect(routeGetArchivedEvents).toHaveBeenCalledWith(
      "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      10,
      0,
    );
  });

  test("runs archival and reports performance duration", async () => {
    routeArchiveContractEvents.mockReturnValue({
      archived: 500,
      enabled: true,
      retentionDays: 90,
      cutoff: "2026-04-01T00:00:00.000Z",
      durationMs: 18,
    });

    const res = await request(app)
      .post("/api/v1/archive/run")
      .send({ batchSize: 500 });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      archived: 500,
      durationMs: 18,
    });
    expect(routeArchiveContractEvents).toHaveBeenCalledWith({ batchSize: 500 });
  });

  test("updates archive retention policy through configuration endpoint", async () => {
    routeUpdateArchivePolicy.mockReturnValue({
      enabled: false,
      retentionDays: 120,
      updatedAt: "2026-06-30T00:00:00.000Z",
    });

    const res = await request(app)
      .post("/api/v1/archive/policy")
      .send({ enabled: false, retentionDays: 120 });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      enabled: false,
      retentionDays: 120,
    });
    expect(routeUpdateArchivePolicy).toHaveBeenCalledWith({
      enabled: false,
      retentionDays: 120,
    });
  });
});
