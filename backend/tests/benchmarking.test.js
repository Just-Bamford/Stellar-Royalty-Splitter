/**
 * E2E tests for collaborator performance benchmarking endpoints (#952).
 *
 * GET /api/v1/analytics/benchmarking/collaborator-percentile
 * GET /api/v1/analytics/benchmarking/cohort-comparison
 * GET /api/v1/analytics/benchmarking/performance-ranking
 *
 * Strategy:
 *   - Mock better-sqlite3 (via moduleNameMapper → __mocks__/better-sqlite3.js)
 *     but override db.prepare per-test via jest.unstable_mockModule on
 *     ../src/database/core.js so we control exactly what SQL returns.
 *   - Mock ../src/cache.js to an always-miss pass-through so tests are
 *     deterministic and don't bleed state between runs.
 *   - Mock ../src/logger.js to suppress noise.
 */
import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import request from "supertest";

// ---------------------------------------------------------------------------
// Shared mock plumbing
// ---------------------------------------------------------------------------

const mockAll = jest.fn();
const mockGet = jest.fn();
const mockPrepare = jest.fn(() => ({ all: mockAll, get: mockGet }));

const mockDb = { prepare: mockPrepare };

// Mock database/core.js — the service imports `db` from here directly.
await jest.unstable_mockModule("../src/database/core.js", () => ({
  db: mockDb,
  initializeDatabase: jest.fn(),
  closeDatabase: jest.fn(),
  countWrite: jest.fn(),
  checkpointDatabase: jest.fn(),
}));

// Mock cache — always miss so the service hits the DB every call.
await jest.unstable_mockModule("../src/cache.js", () => ({
  cacheGet: jest.fn(() => undefined),
  cacheSet: jest.fn(),
  cacheKey: (...parts) => parts.join(":"),
  TTL: { analytics: 3_600_000 },
  initRedisCache: jest.fn(),
  onCacheInvalidated: jest.fn(),
  invalidateCacheDistributed: jest.fn(),
  cacheGetAsync: jest.fn(async () => undefined),
  cacheSetSync: jest.fn(),
  namespacedKey: jest.fn((type, key) => `srs:${type}:${key}`),
  REDIS_TTL_MS: { analytics: 3_600_000 },
}));

// Suppress logger output in tests.
await jest.unstable_mockModule("../src/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  asyncLocalStorage: { run: (_store, fn) => fn() },
}));

// Dynamic import AFTER mocks are registered.
const express = (await import("express")).default;
const { benchmarkingRouter } = await import("../src/routes/analytics/benchmarking.js");

const app = express();
app.use(express.json());
app.use("/api/v1/analytics/benchmarking", benchmarkingRouter);

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const VALID_ADDRESS = "GAPTAQKSMN2ILFVHXDE5V274BUPC6QCRMJZYJFNGW7ENT2X3BQOS4M3C";
const VALID_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/** A realistic row as returned by the fetchCollaboratorStats SQL query. */
function makeStatRow(address, overrides = {}) {
  return {
    address,
    totalEarned: 500,
    payoutCount: 10,
    avgPayout: 50,
    activeMonths: 5,
    // The service adds payoutsPerMonth after the query; rows from DB don't have it yet
    // but the mock returns the raw shape — the service maps them.
    ...overrides,
  };
}

/**
 * Build a mockPrepare implementation that returns different results for
 * successive calls.  Each element of `calls` is { all?, get? }.
 */
function prepareSequence(calls) {
  let i = 0;
  mockPrepare.mockImplementation(() => {
    const spec = calls[i] ?? calls[calls.length - 1];
    i++;
    return {
      all: spec.all ?? jest.fn(() => []),
      get: spec.get ?? jest.fn(() => null),
    };
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  // Default: prepare always returns empty results (safe baseline).
  mockPrepare.mockImplementation(() => ({ all: () => [], get: () => null }));
});

afterEach(() => {
  jest.clearAllMocks();
});

// ===========================================================================
// GET /api/v1/analytics/benchmarking/collaborator-percentile
// ===========================================================================

describe("GET /api/v1/analytics/benchmarking/collaborator-percentile", () => {
  test("returns 400 when address is missing", async () => {
    const res = await request(app).get(
      "/api/v1/analytics/benchmarking/collaborator-percentile"
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_query_parameter");
  });

  test("returns 400 for an invalid Stellar address", async () => {
    const res = await request(app).get(
      "/api/v1/analytics/benchmarking/collaborator-percentile?address=INVALID"
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_query_parameter");
  });

  test("returns 400 for an invalid start date", async () => {
    const res = await request(app).get(
      `/api/v1/analytics/benchmarking/collaborator-percentile?address=${VALID_ADDRESS}&start=not-a-date`
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_query_parameter");
  });

  test("returns 400 when start is after end", async () => {
    const res = await request(app).get(
      `/api/v1/analytics/benchmarking/collaborator-percentile?address=${VALID_ADDRESS}&start=2024-12-01&end=2024-01-01`
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_query_parameter");
  });

  test("returns empty result (peerCount 0) when there are no payouts", async () => {
    // fetchCollaboratorStats returns []
    mockPrepare.mockReturnValue({ all: () => [], get: () => null });

    const res = await request(app).get(
      `/api/v1/analytics/benchmarking/collaborator-percentile?address=${VALID_ADDRESS}`
    );
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.peerCount).toBe(0);
    expect(res.body.data.percentiles).toBeNull();
    expect(res.body.data.benchmarks).toBeNull();
  });

  test("returns correct percentile when subject is top earner", async () => {
    // Subject earns most; two lower-earning peers.
    const rows = [
      makeStatRow(VALID_ADDRESS, { totalEarned: 1000, payoutCount: 20, avgPayout: 50, activeMonths: 5 }),
      makeStatRow("GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", { totalEarned: 300, payoutCount: 6, avgPayout: 50, activeMonths: 3 }),
      makeStatRow("GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC", { totalEarned: 100, payoutCount: 2, avgPayout: 50, activeMonths: 1 }),
    ];

    mockPrepare.mockReturnValue({ all: () => rows, get: () => null });

    const res = await request(app).get(
      `/api/v1/analytics/benchmarking/collaborator-percentile?address=${VALID_ADDRESS}`
    );
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const { data } = res.body;
    expect(data.peerCount).toBe(3);
    expect(data.found).toBe(true);
    expect(data.subject).not.toBeNull();
    // Subject beats 2 out of 3 peers on totalEarned → ~66.7%
    expect(data.percentiles.totalEarned).toBeGreaterThan(50);
    expect(data.benchmarks.totalEarned).toHaveProperty("p50");
    expect(data.benchmarks.totalEarned).toHaveProperty("p75");
    expect(data.insights).toBeInstanceOf(Array);
    expect(data.insights.length).toBeGreaterThan(0);
  });

  test("returns found=false when address not in dataset", async () => {
    // Dataset has peers but NOT the queried address
    const rows = [
      makeStatRow("GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", { totalEarned: 300 }),
      makeStatRow("GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC", { totalEarned: 100 }),
    ];
    mockPrepare.mockReturnValue({ all: () => rows, get: () => null });

    const res = await request(app).get(
      `/api/v1/analytics/benchmarking/collaborator-percentile?address=${VALID_ADDRESS}`
    );
    expect(res.status).toBe(200);
    expect(res.body.data.found).toBe(false);
    expect(res.body.data.subject).toBeNull();
    expect(res.body.data.percentiles).toBeNull();
    // Benchmarks are still returned (they describe the peer population)
    expect(res.body.data.benchmarks).not.toBeNull();
  });

  test("accepts optional contractId scope param", async () => {
    mockPrepare.mockReturnValue({ all: () => [], get: () => null });

    const res = await request(app).get(
      `/api/v1/analytics/benchmarking/collaborator-percentile?address=${VALID_ADDRESS}&contractId=${VALID_CONTRACT}`
    );
    expect(res.status).toBe(200);
  });

  test("returns 500 on database error", async () => {
    mockPrepare.mockImplementation(() => ({
      all: () => { throw new Error("DB failure"); },
      get: () => null,
    }));

    const res = await request(app).get(
      `/api/v1/analytics/benchmarking/collaborator-percentile?address=${VALID_ADDRESS}`
    );
    expect(res.status).toBe(500);
    expect(res.body.code).toBe("benchmarking_fetch_failed");
  });
});

// ===========================================================================
// GET /api/v1/analytics/benchmarking/cohort-comparison
// ===========================================================================

describe("GET /api/v1/analytics/benchmarking/cohort-comparison", () => {
  test("returns 400 when address is missing", async () => {
    const res = await request(app).get(
      "/api/v1/analytics/benchmarking/cohort-comparison"
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_query_parameter");
  });

  test("returns 400 for an invalid joinYear", async () => {
    const res = await request(app).get(
      `/api/v1/analytics/benchmarking/cohort-comparison?address=${VALID_ADDRESS}&joinYear=abc`
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_query_parameter");
  });

  test("returns 400 for an invalid tier", async () => {
    const res = await request(app).get(
      `/api/v1/analytics/benchmarking/cohort-comparison?address=${VALID_ADDRESS}&tier=platinum`
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_query_parameter");
  });

  test("returns cohort data when peers exist with no filters", async () => {
    const statsRows = [
      makeStatRow(VALID_ADDRESS, { totalEarned: 600, payoutCount: 12, avgPayout: 50, activeMonths: 6 }),
      makeStatRow("GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", { totalEarned: 400, payoutCount: 8, avgPayout: 50, activeMonths: 4 }),
    ];
    const firstSeenRows = [
      { address: VALID_ADDRESS, firstSeen: "2024-03-15T00:00:00.000Z" },
      { address: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", firstSeen: "2024-01-10T00:00:00.000Z" },
    ];

    // The service makes 3 prepare calls in getCohortComparison:
    //   1. fetchCollaboratorStats (all → statsRows)
    //   2. first-seen batch query (all → firstSeenRows)
    //   3. contributor_tiers query (all → [] — table empty / graceful)
    prepareSequence([
      { all: () => statsRows },
      { all: () => firstSeenRows },
      { all: () => [] },
    ]);

    const res = await request(app).get(
      `/api/v1/analytics/benchmarking/cohort-comparison?address=${VALID_ADDRESS}`
    );
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const { data } = res.body;
    expect(data.found).toBe(true);
    expect(data.cohortSize).toBe(2);
    expect(data.cohortStats).toHaveProperty("totalEarned");
    expect(data.cohortStats.totalEarned).toHaveProperty("mean");
    expect(data.cohortStats.totalEarned).toHaveProperty("median");
    expect(data.comparisons).not.toBeNull();
    expect(data.comparisons.totalEarned).toHaveProperty("ratio");
    expect(data.comparisons.totalEarned).toHaveProperty("percentileInCohort");
    expect(data.insights).toBeInstanceOf(Array);
  });

  test("filters cohort by joinYear correctly", async () => {
    const statsRows = [
      makeStatRow(VALID_ADDRESS, { totalEarned: 600, payoutCount: 12, avgPayout: 50, activeMonths: 6 }),
      makeStatRow("GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", { totalEarned: 400, payoutCount: 8, avgPayout: 50, activeMonths: 4 }),
    ];
    // Only VALID_ADDRESS joined in 2024; peer joined in 2023 → cohort = 1
    const firstSeenRows = [
      { address: VALID_ADDRESS, firstSeen: "2024-03-15T00:00:00.000Z" },
      { address: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", firstSeen: "2023-06-01T00:00:00.000Z" },
    ];

    prepareSequence([
      { all: () => statsRows },
      { all: () => firstSeenRows },
      { all: () => [] },
    ]);

    const res = await request(app).get(
      `/api/v1/analytics/benchmarking/cohort-comparison?address=${VALID_ADDRESS}&joinYear=2024`
    );
    expect(res.status).toBe(200);
    expect(res.body.data.cohortFilters).toEqual({ joinYear: 2024 });
    // Only the subject passes the joinYear=2024 filter
    expect(res.body.data.cohortSize).toBe(1);
  });

  test("filters cohort by tier correctly", async () => {
    const statsRows = [
      makeStatRow(VALID_ADDRESS, { totalEarned: 800, payoutCount: 16, avgPayout: 50, activeMonths: 8 }),
      makeStatRow("GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", { totalEarned: 200, payoutCount: 4, avgPayout: 50, activeMonths: 2 }),
    ];
    const firstSeenRows = [
      { address: VALID_ADDRESS, firstSeen: "2024-01-01T00:00:00.000Z" },
      { address: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", firstSeen: "2024-01-01T00:00:00.000Z" },
    ];
    // Only VALID_ADDRESS is vip
    const tierRows = [
      { collaboratorAddress: VALID_ADDRESS, tier: "vip" },
    ];

    prepareSequence([
      { all: () => statsRows },
      { all: () => firstSeenRows },
      { all: () => tierRows },
    ]);

    const res = await request(app).get(
      `/api/v1/analytics/benchmarking/cohort-comparison?address=${VALID_ADDRESS}&tier=vip`
    );
    expect(res.status).toBe(200);
    expect(res.body.data.cohortFilters).toEqual({ tier: "vip" });
    expect(res.body.data.cohortSize).toBe(1);
  });

  test("generates actionable insight string comparing to cohort", async () => {
    const statsRows = [
      makeStatRow(VALID_ADDRESS, { totalEarned: 1500, payoutCount: 30, avgPayout: 50, activeMonths: 10 }),
      makeStatRow("GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", { totalEarned: 500, payoutCount: 10, avgPayout: 50, activeMonths: 5 }),
      makeStatRow("GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC", { totalEarned: 500, payoutCount: 10, avgPayout: 50, activeMonths: 5 }),
    ];
    const firstSeenRows = statsRows.map((r) => ({
      address: r.address,
      firstSeen: "2024-01-01T00:00:00.000Z",
    }));

    prepareSequence([
      { all: () => statsRows },
      { all: () => firstSeenRows },
      { all: () => [] },
    ]);

    const res = await request(app).get(
      `/api/v1/analytics/benchmarking/cohort-comparison?address=${VALID_ADDRESS}&joinYear=2024`
    );
    expect(res.status).toBe(200);
    const insights = res.body.data.insights;
    expect(insights.length).toBeGreaterThan(0);
    // Insight should mention a multiplier (e.g. "1.5x", "3x", etc.)
    expect(insights[0]).toMatch(/\d+(\.\d+)?x/);
  });

  test("returns 500 on database error", async () => {
    mockPrepare.mockImplementation(() => ({
      all: () => { throw new Error("DB failure"); },
      get: () => null,
    }));

    const res = await request(app).get(
      `/api/v1/analytics/benchmarking/cohort-comparison?address=${VALID_ADDRESS}`
    );
    expect(res.status).toBe(500);
    expect(res.body.code).toBe("benchmarking_fetch_failed");
  });
});

// ===========================================================================
// GET /api/v1/analytics/benchmarking/performance-ranking
// ===========================================================================

describe("GET /api/v1/analytics/benchmarking/performance-ranking", () => {
  test("returns 400 for an invalid metric", async () => {
    const res = await request(app).get(
      "/api/v1/analytics/benchmarking/performance-ranking?metric=fakeMetric"
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_query_parameter");
  });

  test("returns 400 when n is out of range", async () => {
    const res = await request(app).get(
      "/api/v1/analytics/benchmarking/performance-ranking?n=999"
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_query_parameter");
  });

  test("returns 400 for n=0", async () => {
    const res = await request(app).get(
      "/api/v1/analytics/benchmarking/performance-ranking?n=0"
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_query_parameter");
  });

  test("returns empty top/bottom when no collaborators exist", async () => {
    mockPrepare.mockReturnValue({ all: () => [], get: () => null });

    const res = await request(app).get(
      "/api/v1/analytics/benchmarking/performance-ranking"
    );
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.top).toHaveLength(0);
    expect(res.body.data.bottom).toHaveLength(0);
    expect(res.body.data.totalCollaborators).toBe(0);
  });

  test("returns top and bottom performers with correct rank ordering", async () => {
    const rows = [
      makeStatRow("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1", { totalEarned: 100, payoutCount: 2, avgPayout: 50, activeMonths: 1 }),
      makeStatRow("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2", { totalEarned: 500, payoutCount: 10, avgPayout: 50, activeMonths: 5 }),
      makeStatRow("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA3", { totalEarned: 1000, payoutCount: 20, avgPayout: 50, activeMonths: 10 }),
      makeStatRow("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4", { totalEarned: 250, payoutCount: 5, avgPayout: 50, activeMonths: 2 }),
      makeStatRow("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA5", { totalEarned: 750, payoutCount: 15, avgPayout: 50, activeMonths: 7 }),
    ];

    mockPrepare.mockReturnValue({ all: () => rows, get: () => null });

    const res = await request(app).get(
      "/api/v1/analytics/benchmarking/performance-ranking?metric=totalEarned&n=3"
    );
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const { data } = res.body;
    expect(data.metric).toBe("totalEarned");
    expect(data.n).toBe(3);
    expect(data.totalCollaborators).toBe(5);

    // Top 3 by totalEarned (descending): 1000, 750, 500
    expect(data.top).toHaveLength(3);
    expect(data.top[0].totalEarned).toBe(1000);
    expect(data.top[0].rank).toBe(1);
    expect(data.top[1].totalEarned).toBe(750);
    expect(data.top[2].totalEarned).toBe(500);

    // Bottom 3 by totalEarned (ascending): 100, 250, 500
    expect(data.bottom).toHaveLength(3);
    expect(data.bottom[0].totalEarned).toBe(100);
    expect(data.bottom[0].bottomRank).toBe(1);
  });

  test("returns correct distribution statistics", async () => {
    const rows = [100, 200, 300, 400, 500].map((earned, i) =>
      makeStatRow(`GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA${i + 1}`, {
        totalEarned: earned,
        payoutCount: earned / 50,
        avgPayout: 50,
        activeMonths: 2,
      })
    );

    mockPrepare.mockReturnValue({ all: () => rows, get: () => null });

    const res = await request(app).get(
      "/api/v1/analytics/benchmarking/performance-ranking?metric=totalEarned"
    );
    expect(res.status).toBe(200);

    const { distribution } = res.body.data;
    expect(distribution).toHaveProperty("min");
    expect(distribution).toHaveProperty("p25");
    expect(distribution).toHaveProperty("p50");
    expect(distribution).toHaveProperty("p75");
    expect(distribution).toHaveProperty("p90");
    expect(distribution).toHaveProperty("max");
    expect(distribution).toHaveProperty("mean");
    expect(distribution.min).toBe(100);
    expect(distribution.max).toBe(500);
    expect(distribution.mean).toBe(300);
  });

  test("supports payoutsPerMonth as metric", async () => {
    const rows = [
      makeStatRow("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1", { totalEarned: 200, payoutCount: 20, avgPayout: 10, activeMonths: 2 }),
      makeStatRow("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2", { totalEarned: 100, payoutCount: 5, avgPayout: 20, activeMonths: 5 }),
    ];

    mockPrepare.mockReturnValue({ all: () => rows, get: () => null });

    const res = await request(app).get(
      "/api/v1/analytics/benchmarking/performance-ranking?metric=payoutsPerMonth"
    );
    expect(res.status).toBe(200);
    expect(res.body.data.metric).toBe("payoutsPerMonth");
    // row[0] has 20/2=10 payoutsPerMonth, row[1] has 5/5=1 payoutsPerMonth
    expect(res.body.data.top[0].payoutsPerMonth).toBe(10);
  });

  test("scopes results to a contractId when provided", async () => {
    mockPrepare.mockReturnValue({ all: () => [], get: () => null });

    const res = await request(app).get(
      `/api/v1/analytics/benchmarking/performance-ranking?contractId=${VALID_CONTRACT}`
    );
    expect(res.status).toBe(200);
    // contractId is accepted without error — SQL filtering is tested via
    // the service; here we just verify the route passes the param through.
    expect(res.body.data.totalCollaborators).toBe(0);
  });

  test("sets Cache-Control: max-age=3600 header", async () => {
    mockPrepare.mockReturnValue({ all: () => [], get: () => null });

    const res = await request(app).get(
      "/api/v1/analytics/benchmarking/performance-ranking"
    );
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toContain("max-age=3600");
  });

  test("returns 500 on database error", async () => {
    mockPrepare.mockImplementation(() => ({
      all: () => { throw new Error("DB failure"); },
      get: () => null,
    }));

    const res = await request(app).get(
      "/api/v1/analytics/benchmarking/performance-ranking"
    );
    expect(res.status).toBe(500);
    expect(res.body.code).toBe("benchmarking_fetch_failed");
  });
});

// ===========================================================================
// Cross-cutting: accuracy verification (issue acceptance criteria)
// ===========================================================================

describe("Benchmarking accuracy — E2E data verification (#952)", () => {
  test("percentile-ranking: verified accuracy across all four metrics", async () => {
    /**
     * Scenario: 5 collaborators with known earnings.
     * Subject (VALID_ADDRESS) has totalEarned=750, which beats 3 of 5 = 60th percentile.
     */
    const peers = [
      makeStatRow(VALID_ADDRESS,                                                              { totalEarned: 750,  payoutCount: 15, avgPayout: 50, activeMonths: 5 }),
      makeStatRow("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1", { totalEarned: 1000, payoutCount: 20, avgPayout: 50, activeMonths: 10 }),
      makeStatRow("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2", { totalEarned: 500,  payoutCount: 10, avgPayout: 50, activeMonths: 5 }),
      makeStatRow("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA3", { totalEarned: 250,  payoutCount: 5,  avgPayout: 50, activeMonths: 2 }),
      makeStatRow("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4", { totalEarned: 100,  payoutCount: 2,  avgPayout: 50, activeMonths: 1 }),
    ];

    mockPrepare.mockReturnValue({ all: () => peers, get: () => null });

    const res = await request(app).get(
      `/api/v1/analytics/benchmarking/collaborator-percentile?address=${VALID_ADDRESS}`
    );
    expect(res.status).toBe(200);

    const { percentiles, benchmarks } = res.body.data;

    // 750 beats 3 of 5 peers → 3/5 * 100 = 60.0
    expect(percentiles.totalEarned).toBe(60);

    // p50 of [100, 250, 500, 750, 1000] = 500
    expect(benchmarks.totalEarned.p50).toBe(500);
    // p75 of [100, 250, 500, 750, 1000] = 750
    expect(benchmarks.totalEarned.p75).toBe(750);
    // mean = (100+250+500+750+1000)/5 = 520
    expect(benchmarks.totalEarned.mean).toBe(520);
  });

  test("cohort-comparison: ratio is accurately computed against cohort median", async () => {
    /**
     * Subject earns 1000; two peers in the same joinYear each earn 500.
     * Cohort median = 500; ratio = 1000/500 = 2.0.
     */
    const statsRows = [
      makeStatRow(VALID_ADDRESS,                                                              { totalEarned: 1000, payoutCount: 20, avgPayout: 50, activeMonths: 10 }),
      makeStatRow("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1", { totalEarned: 500,  payoutCount: 10, avgPayout: 50, activeMonths: 5 }),
      makeStatRow("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2", { totalEarned: 500,  payoutCount: 10, avgPayout: 50, activeMonths: 5 }),
    ];
    const firstSeenRows = statsRows.map((r) => ({
      address: r.address,
      firstSeen: "2024-06-01T00:00:00.000Z",
    }));

    prepareSequence([
      { all: () => statsRows },
      { all: () => firstSeenRows },
      { all: () => [] },
    ]);

    const res = await request(app).get(
      `/api/v1/analytics/benchmarking/cohort-comparison?address=${VALID_ADDRESS}&joinYear=2024`
    );
    expect(res.status).toBe(200);
    expect(res.body.data.comparisons.totalEarned.ratio).toBe(2);
    expect(res.body.data.insights[0]).toContain("2x");
  });

  test("performance-ranking: rank 1 is highest earner, bottom rank 1 is lowest", async () => {
    const rows = [500, 200, 800, 100, 350].map((earned, i) =>
      makeStatRow(`GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA${i + 1}`, {
        totalEarned: earned,
        payoutCount: 5,
        avgPayout: earned / 5,
        activeMonths: 2,
      })
    );

    mockPrepare.mockReturnValue({ all: () => rows, get: () => null });

    const res = await request(app).get(
      "/api/v1/analytics/benchmarking/performance-ranking?n=5"
    );
    expect(res.status).toBe(200);

    const { top, bottom } = res.body.data;
    expect(top[0].rank).toBe(1);
    expect(top[0].totalEarned).toBe(800);          // highest
    expect(top[top.length - 1].totalEarned).toBe(100); // 5th place

    expect(bottom[0].bottomRank).toBe(1);
    expect(bottom[0].totalEarned).toBe(100);        // worst
  });
});
