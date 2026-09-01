import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockGetOrComputeMetrics = jest.fn();
const mockRecomputeMetrics = jest.fn();
const mockGetContractLeaderboard = jest.fn();
const mockRecomputeContractMetrics = jest.fn();
const mockAddAuditLog = jest.fn();

await jest.unstable_mockModule("../src/database/index.js", () => ({
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 15),
  getOrComputeMetrics: mockGetOrComputeMetrics,
  recomputeMetrics: mockRecomputeMetrics,
  getContractLeaderboard: mockGetContractLeaderboard,
  recomputeContractMetrics: mockRecomputeContractMetrics,
  addAuditLog: mockAddAuditLog,
}));

await jest.unstable_mockModule("../src/middleware/rbac.js", () => ({
  attachRole: (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
  ROLES: ["viewer", "collaborator", "operator", "admin"],
}));

const express = (await import("express")).default;
const { contributorMetricsRouter } = await import("../src/routes/contributor-metrics.js");

const app = express();
app.use(express.json());
app.use("/api/v1/contributor-metrics", contributorMetricsRouter);

const VALID_WALLET = "GAPTAQKSMN2ILFVHXDE5V274BUPC6QCRMJZYJFNGW7ENT2X3BQOS4M3C";
const VALID_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const sampleMetrics = {
  walletAddress: VALID_WALLET,
  successRate: 95.5,
  avgPayoutTime: 2.3,
  reliabilityScore: 88,
  totalPayouts: 24,
  totalEarned: 15000,
  firstPayoutAt: "2025-01-01T00:00:00Z",
  lastPayoutAt: "2026-01-01T00:00:00Z",
  trend: [
    { period: "2025-08", payoutCount: 2, totalAmount: 1200 },
    { period: "2025-09", payoutCount: 3, totalAmount: 1800 },
  ],
  computedAt: "2026-01-27T10:00:00Z",
};

// ─── GET profile ──────────────────────────────────────────────────────────────

describe("GET /api/v1/contributor-metrics/:walletAddress", () => {
  beforeEach(() => jest.clearAllMocks());

  test("returns metrics for a valid wallet", async () => {
    mockGetOrComputeMetrics.mockReturnValue(sampleMetrics);

    const res = await request(app).get(`/api/v1/contributor-metrics/${VALID_WALLET}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.walletAddress).toBe(VALID_WALLET);
    expect(res.body.data.successRate).toBe(95.5);
    expect(res.body.data.reliabilityScore).toBe(88);
    expect(res.body.data.trend).toHaveLength(2);
    expect(mockGetOrComputeMetrics).toHaveBeenCalledWith(VALID_WALLET, 300_000);
  });

  test("force-refreshes metrics when refresh=true", async () => {
    mockRecomputeMetrics.mockReturnValue(sampleMetrics);

    const res = await request(app).get(`/api/v1/contributor-metrics/${VALID_WALLET}?refresh=true`);

    expect(res.status).toBe(200);
    expect(mockRecomputeMetrics).toHaveBeenCalledWith(VALID_WALLET);
    expect(mockGetOrComputeMetrics).not.toHaveBeenCalled();
  });

  test("respects custom maxAgeMs parameter", async () => {
    mockGetOrComputeMetrics.mockReturnValue(sampleMetrics);

    const res = await request(app).get(
      `/api/v1/contributor-metrics/${VALID_WALLET}?maxAgeMs=60000`
    );

    expect(res.status).toBe(200);
    expect(mockGetOrComputeMetrics).toHaveBeenCalledWith(VALID_WALLET, 60000);
  });

  test("returns 400 for invalid wallet address", async () => {
    const res = await request(app).get("/api/v1/contributor-metrics/INVALID");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_stellar_address");
  });
});

// ─── POST refresh ─────────────────────────────────────────────────────────────

describe("POST /api/v1/contributor-metrics/:walletAddress/refresh", () => {
  beforeEach(() => jest.clearAllMocks());

  test("refreshes and returns updated metrics", async () => {
    mockRecomputeMetrics.mockReturnValue(sampleMetrics);

    const res = await request(app)
      .post(`/api/v1/contributor-metrics/${VALID_WALLET}/refresh`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.data.reliabilityScore).toBe(88);
    expect(mockRecomputeMetrics).toHaveBeenCalledWith(VALID_WALLET);
    expect(mockAddAuditLog).toHaveBeenCalledWith(
      "SYSTEM",
      "contributor_metrics_refreshed",
      VALID_WALLET,
      expect.objectContaining({ successRate: 95.5, reliabilityScore: 88 })
    );
  });

  test("returns 400 for invalid wallet address", async () => {
    const res = await request(app).post("/api/v1/contributor-metrics/BADINPUT/refresh").send({});
    expect(res.status).toBe(400);
  });
});

// ─── GET leaderboard ──────────────────────────────────────────────────────────

describe("GET /api/v1/contributor-metrics/leaderboard/:contractId", () => {
  beforeEach(() => jest.clearAllMocks());

  test("returns ranked leaderboard for a contract", async () => {
    mockGetContractLeaderboard.mockReturnValue([
      { walletAddress: VALID_WALLET, reliabilityScore: 90, successRate: 97, totalPayouts: 30 },
    ]);

    const res = await request(app).get(`/api/v1/contributor-metrics/leaderboard/${VALID_CONTRACT}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(mockGetContractLeaderboard).toHaveBeenCalledWith(
      VALID_CONTRACT,
      expect.objectContaining({ sortBy: "reliabilityScore" })
    );
  });

  test("accepts custom sortBy parameter", async () => {
    mockGetContractLeaderboard.mockReturnValue([]);

    const res = await request(app).get(
      `/api/v1/contributor-metrics/leaderboard/${VALID_CONTRACT}?sortBy=totalEarned`
    );

    expect(res.status).toBe(200);
    expect(mockGetContractLeaderboard).toHaveBeenCalledWith(
      VALID_CONTRACT,
      expect.objectContaining({ sortBy: "totalEarned" })
    );
  });

  test("returns 400 for invalid contract address", async () => {
    const res = await request(app).get("/api/v1/contributor-metrics/leaderboard/INVALID");
    expect(res.status).toBe(400);
  });
});

// ─── POST bulk recompute ──────────────────────────────────────────────────────

describe("POST /api/v1/contributor-metrics/recompute/:contractId", () => {
  beforeEach(() => jest.clearAllMocks());

  test("bulk recomputes and returns count", async () => {
    mockRecomputeContractMetrics.mockReturnValue(5);

    const res = await request(app)
      .post(`/api/v1/contributor-metrics/recompute/${VALID_CONTRACT}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.data.updated).toBe(5);
    expect(mockAddAuditLog).toHaveBeenCalledWith(
      VALID_CONTRACT,
      "contributor_metrics_bulk_recomputed",
      "system",
      { updated: 5 }
    );
  });

  test("returns 400 for invalid contract", async () => {
    const res = await request(app)
      .post("/api/v1/contributor-metrics/recompute/BADCONTRACT")
      .send({});
    expect(res.status).toBe(400);
  });
});

// ─── Reliability score formula ────────────────────────────────────────────────

describe("reliability score edge cases", () => {
  test("wallet with 0 payouts gets score 0 on metric endpoint", async () => {
    mockGetOrComputeMetrics.mockReturnValue({
      ...sampleMetrics,
      successRate: 0,
      reliabilityScore: 0,
      totalPayouts: 0,
    });

    const res = await request(app).get(`/api/v1/contributor-metrics/${VALID_WALLET}`);
    expect(res.body.data.reliabilityScore).toBe(0);
  });

  test("perfect wallet gets high score", async () => {
    mockGetOrComputeMetrics.mockReturnValue({
      ...sampleMetrics,
      successRate: 100,
      reliabilityScore: 100,
      totalPayouts: 48,
    });

    const res = await request(app).get(`/api/v1/contributor-metrics/${VALID_WALLET}`);
    expect(res.body.data.reliabilityScore).toBe(100);
  });
});
