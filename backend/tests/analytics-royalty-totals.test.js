/**
 * Tests for primary/secondary royalty totals in the analytics endpoint (#688).
 */

import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";

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

describe("GET /api/v1/analytics/:contractId — primary/secondary royalty totals (#688)", () => {
  beforeEach(() => jest.clearAllMocks());

  function makeAnalyticsMock({ summary = {}, primaryTotal = 0, secondaryTotal = 0 } = {}) {
    // The analytics route calls prepare() 6 times:
    //   .get()  → summary
    //   .all()  → trends
    //   .all()  → topEarners
    //   .all()  → collaboratorStats
    //   .get()  → primaryRow
    //   .get()  → secondaryRow
    const mockGetFn = jest.fn()
      .mockReturnValueOnce({ totalTransactions: 0, totalDistributed: 0, averagePayout: 0, ...summary })
      .mockReturnValueOnce({ primaryTotal })
      .mockReturnValueOnce({ secondaryTotal });
    const mockAllFn = jest.fn().mockReturnValue([]);
    mockPrepare.mockImplementation(() => ({ get: mockGetFn, all: mockAllFn }));
  }

  test("returns primaryRoyaltiesTotal and secondaryRoyaltiesTotal in response", async () => {
    makeAnalyticsMock({ summary: { totalTransactions: 5, totalDistributed: 500, averagePayout: 100 }, primaryTotal: 400, secondaryTotal: 100 });

    const res = await request(app).get(`/api/v1/analytics/${VALID_CONTRACT}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty("primaryRoyaltiesTotal");
    expect(res.body.data).toHaveProperty("secondaryRoyaltiesTotal");
  });

  test("primaryRoyaltiesTotal defaults to 0 when no primary distributions exist", async () => {
    makeAnalyticsMock({ primaryTotal: 0, secondaryTotal: 50 });

    const res = await request(app).get(`/api/v1/analytics/${VALID_CONTRACT}`);
    expect(res.status).toBe(200);
    expect(res.body.data.primaryRoyaltiesTotal).toBe(0);
  });

  test("secondaryRoyaltiesTotal defaults to 0 when no secondary distributions exist", async () => {
    makeAnalyticsMock({ primaryTotal: 200, secondaryTotal: 0 });

    const res = await request(app).get(`/api/v1/analytics/${VALID_CONTRACT}`);
    expect(res.status).toBe(200);
    expect(res.body.data.secondaryRoyaltiesTotal).toBe(0);
  });

  test("totals are rounded to 2 decimal places", async () => {
    makeAnalyticsMock({ primaryTotal: 333.3333, secondaryTotal: 66.6666 });

    const res = await request(app).get(`/api/v1/analytics/${VALID_CONTRACT}`);
    expect(res.status).toBe(200);
    expect(res.body.data.primaryRoyaltiesTotal).toBe(333.33);
    expect(res.body.data.secondaryRoyaltiesTotal).toBe(66.67);
  });

  test("date range params are forwarded to analytics queries", async () => {
    makeAnalyticsMock({ primaryTotal: 100, secondaryTotal: 20 });

    const res = await request(app)
      .get(`/api/v1/analytics/${VALID_CONTRACT}?start=2024-01-01&end=2024-06-30`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty("primaryRoyaltiesTotal");
    expect(res.body.data).toHaveProperty("secondaryRoyaltiesTotal");
  });

  test("returns 400 for invalid start date", async () => {
    const res = await request(app)
      .get(`/api/v1/analytics/${VALID_CONTRACT}?start=not-a-date`);
    expect(res.status).toBe(400);
  });

  test("loading state: returns 500 on DB error with analytics_fetch_failed code", async () => {
    mockPrepare.mockImplementation(() => ({
      get: () => { throw new Error("DB failure"); },
      all: () => [],
    }));

    const res = await request(app).get(`/api/v1/analytics/${VALID_CONTRACT}`);
    expect(res.status).toBe(500);
    expect(res.body.code).toBe("analytics_fetch_failed");
  });
});
