import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";

// Mock the db with a prepare().get()/.all() chain
const mockGet = jest.fn();
const mockAll = jest.fn();
const mockPrepare = jest.fn(() => ({ get: mockGet, all: mockAll }));

const mockDb = { prepare: mockPrepare };

await jest.unstable_mockModule("../src/database/index.js", () => ({
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 9),
  default: mockDb,
}));

await jest.unstable_mockModule("../src/middleware/rbac.js", () => ({
  attachRole: (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
  ROLES: ["viewer", "collaborator", "operator", "admin"],
}));

const express = (await import("express")).default;
const { analyticsRouter } = await import("../src/routes/analytics.js");

const app = express();
app.use(express.json());
app.use("/api/v1", analyticsRouter);

const VALID_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const VALID_ADDRESS = "GAPTAQKSMN2ILFVHXDE5V274BUPC6QCRMJZYJFNGW7ENT2X3BQOS4M3C";

describe("GET /api/v1/analytics/:contractId/volume (#590)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAll.mockReturnValue([
      { period: "2024-01-15", transactions: 5, volume: 100.5 },
      { period: "2024-01-16", transactions: 3, volume: 60.0 },
    ]);
    mockGet.mockReturnValue({ status: "confirmed", cnt: 8 });
  });

  test("returns volume buckets and success rate", async () => {
    // Reset per-call to handle multiple prepare calls
    let callCount = 0;
    mockPrepare.mockImplementation(() => ({
      all: () => {
        callCount++;
        if (callCount === 1) {
          return [{ period: "2024-01-15", transactions: 5, volume: 100.5 }];
        }
        // status counts query
        return [
          { status: "confirmed", cnt: 5 },
          { status: "failed", cnt: 1 },
        ];
      },
      get: () => null,
    }));

    const res = await request(app).get(`/api/v1/analytics/${VALID_CONTRACT}/volume`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty("successRate");
    expect(res.body.data).toHaveProperty("buckets");
    expect(res.body.data).toHaveProperty("statusBreakdown");
  });

  test("returns 400 for invalid bucket param — defaults gracefully", async () => {
    mockPrepare.mockReturnValue({ all: () => [], get: () => null });
    const res = await request(app).get(`/api/v1/analytics/${VALID_CONTRACT}/volume?bucket=invalid`);
    // Invalid bucket defaults to 'day', so still 200
    expect(res.status).toBe(200);
    expect(res.body.data.bucket).toBe("day");
  });

  test("returns 400 for invalid start date", async () => {
    const res = await request(app).get(
      `/api/v1/analytics/${VALID_CONTRACT}/volume?start=not-a-date`
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/v1/analytics/multi-contract (#568)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("returns aggregated earnings across contracts", async () => {
    mockPrepare.mockReturnValue({
      all: () => [
        {
          contractId: VALID_CONTRACT,
          totalEarned: 500,
          payoutCount: 10,
          avgPayout: 50,
          lastActivity: "2024-01-20T00:00:00.000Z",
        },
      ],
    });

    const res = await request(app).get(`/api/v1/analytics/multi-contract?address=${VALID_ADDRESS}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.summary.contractCount).toBe(1);
    expect(res.body.data.summary.totalEarned).toBe(500);
    expect(res.body.data.contracts).toHaveLength(1);
  });

  test("returns 400 when address is missing", async () => {
    const res = await request(app).get("/api/v1/analytics/multi-contract");
    expect(res.status).toBe(400);
  });

  test("returns 400 for invalid address format", async () => {
    const res = await request(app).get("/api/v1/analytics/multi-contract?address=INVALID");
    expect(res.status).toBe(400);
  });

  test("returns empty contracts array when no earnings found", async () => {
    mockPrepare.mockReturnValue({ all: () => [] });
    const res = await request(app).get(`/api/v1/analytics/multi-contract?address=${VALID_ADDRESS}`);
    expect(res.status).toBe(200);
    expect(res.body.data.summary.totalEarned).toBe(0);
    expect(res.body.data.contracts).toHaveLength(0);
  });
});
