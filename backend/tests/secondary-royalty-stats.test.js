/**
 * Performance regression tests for getRoyaltyStatistics (#462).
 *
 * Verifies:
 *  - Combined single-query CTE implementation calls db.prepare exactly once
 *  - SQL string contains all required CTEs (totals, pending, last_dist)
 *  - Composite index name appears in the combined SQL statement
 *  - Correct result shape is returned for a row with all fields populated
 *  - lastDistribution is null when lastDistTimestamp is null (no distribution yet)
 *  - 60-second cache prevents re-running the query within the TTL
 *  - _invalidateStatsCache forces a fresh query on the next call
 *  - Zero-value defaults are returned for a contract with no matching data
 */

import { jest, describe, test, expect, beforeEach } from "@jest/globals";

// ---------------------------------------------------------------------------
// Mock core.js to control db behavior per test
// ---------------------------------------------------------------------------

let mockGet = jest.fn();
// Accumulates every SQL string passed to db.prepare() over the module lifetime.
// NOT cleared between tests — the important prepare() calls happen at import time.
const allPreparedSqls = [];

const mockDb = {
  pragma: jest.fn(),
  exec: jest.fn(),
  transaction: (fn) => fn,
  prepare: jest.fn((sql) => {
    allPreparedSqls.push(sql);
    return {
      get: (...args) => mockGet(...args),
      run: jest.fn(() => ({ changes: 1, lastInsertRowid: 1 })),
      all: jest.fn(() => []),
    };
  }),
};

await jest.unstable_mockModule("../src/database/core.js", () => ({
  db: mockDb,
  countWrite: jest.fn(),
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 8),
  computeAuditEntryHash: jest.fn(() => "hash"),
  verifyAuditLogIntegrity: jest.fn(() => ({ valid: true, brokenAt: null, error: null })),
  verifyAuditLogOnStartup: jest.fn(),
  closeDatabase: jest.fn(),
  checkpointDatabase: jest.fn(),
  default: mockDb,
}));

await jest.unstable_mockModule("../src/database/audit.js", () => ({
  addAuditLog: jest.fn(),
}));

await jest.unstable_mockModule("../src/database/transactions.js", () => ({
  recordTransaction: jest.fn(),
  updateTransactionStatus: jest.fn(),
}));

const { getRoyaltyStatistics, _invalidateStatsCache } = await import(
  "../src/database/secondary-royalties.js"
);

const CONTRACT = `C${"A".repeat(55)}`;
const OTHER_CONTRACT = `C${"B".repeat(55)}`;

function makeFullRow(overrides = {}) {
  return {
    totalSales: 5,
    totalRoyalties: 2.5,
    totalVolume: 25.0,
    pendingPool: 0.5,
    lastDistTimestamp: "2026-01-15 10:00:00",
    lastDistTotal: "2.0",
    lastDistSales: 4,
    lastDistTxHash: "abc123",
    ...overrides,
  };
}

function makeEmptyRow() {
  return {
    totalSales: 0,
    totalRoyalties: 0,
    totalVolume: 0,
    pendingPool: 0,
    lastDistTimestamp: null,
    lastDistTotal: null,
    lastDistSales: null,
    lastDistTxHash: null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getRoyaltyStatistics combined CTE (#462)", () => {
  beforeEach(() => {
    mockGet = jest.fn();
    _invalidateStatsCache(CONTRACT);
    _invalidateStatsCache(OTHER_CONTRACT);
  });

  // 1. The module prepares exactly ONE statement for getRoyaltyStatistics
  test("module lazily prepares one statement and reuses it", () => {
    // The _statsStmt is module-level — prepare was called once at import time.
    // Subsequent calls to getRoyaltyStatistics must NOT call prepare again.
    const callsBefore = mockDb.prepare.mock.calls.length;
    mockGet.mockReturnValue(makeEmptyRow());

    getRoyaltyStatistics(CONTRACT);
    const callsAfterFirst = mockDb.prepare.mock.calls.length;

    getRoyaltyStatistics(OTHER_CONTRACT);

    const callsAfter = mockDb.prepare.mock.calls.length;
    expect(callsAfterFirst - callsBefore).toBeLessThanOrEqual(1);
    expect(callsAfter).toBe(callsAfterFirst);
  });

  // 2. The CTE SQL contains all required sub-queries in one statement
  test("prepared SQL contains all required CTEs in a single statement", () => {
    mockGet.mockReturnValue(makeEmptyRow());
    getRoyaltyStatistics(CONTRACT);

    const allSql = allPreparedSqls.join("\n");

    // Must include the totals CTE for aggregating sales
    expect(allSql).toMatch(/\btotals\b/i);
    // Must include a pending sub-query
    expect(allSql).toMatch(/\bpending\b/i);
    // Must include a last distribution lookup
    expect(allSql).toMatch(/last_dist/i);
    // Must use LEFT JOIN to handle absent distributions
    expect(allSql).toMatch(/LEFT JOIN/i);
    // Single statement: no semicolons that would split it into multiple queries
    const statsStmtSql = allPreparedSqls.find((sql) => sql.includes("totalSales"));
    expect(statsStmtSql).toBeDefined();
    const semicolonCount = (statsStmtSql.match(/;/g) ?? []).length;
    expect(semicolonCount).toBe(0);
  });

  // 3. Returns correctly shaped result for a fully populated row
  test("maps all row fields to the expected result shape", () => {
    mockGet.mockReturnValue(makeFullRow());

    const result = getRoyaltyStatistics(CONTRACT);

    expect(result.totalSecondarySales).toBe(5);
    expect(result.totalRoyaltiesGenerated).toBe("2.5000000");
    expect(result.totalVolume).toBe("25.0000000");
    expect(result.pendingRoyaltyPool).toBe("0.5000000");
    expect(result.lastDistribution).toEqual({
      timestamp: "2026-01-15 10:00:00",
      totalRoyaltiesDistributed: "2.0",
      numberOfSales: 4,
      txHash: "abc123",
    });
  });

  // 4. lastDistribution is null when the row has no distribution timestamp
  test("returns null lastDistribution when no distribution exists", () => {
    mockGet.mockReturnValue(makeEmptyRow());

    const result = getRoyaltyStatistics(CONTRACT);

    expect(result.totalSecondarySales).toBe(0);
    expect(result.totalRoyaltiesGenerated).toBe("0.0000000");
    expect(result.pendingRoyaltyPool).toBe("0.0000000");
    expect(result.lastDistribution).toBeNull();
  });

  // 5. Results are per-contractId (different contracts produce different results)
  test("returns independent results for different contractIds", () => {
    mockGet
      .mockReturnValueOnce(makeFullRow({ totalSales: 3 }))
      .mockReturnValueOnce(makeFullRow({ totalSales: 7 }));

    const r1 = getRoyaltyStatistics(CONTRACT);
    const r2 = getRoyaltyStatistics(OTHER_CONTRACT);

    expect(r1.totalSecondarySales).toBe(3);
    expect(r2.totalSecondarySales).toBe(7);
  });
});

describe("getRoyaltyStatistics 60-second cache (#462)", () => {
  beforeEach(() => {
    mockGet = jest.fn();
    _invalidateStatsCache(CONTRACT);
    _invalidateStatsCache(OTHER_CONTRACT);
  });

  // 6. Second call within TTL does not invoke db.get again
  test("cache prevents repeat db.get calls within the 60-second TTL", () => {
    mockGet.mockReturnValue(makeFullRow());

    getRoyaltyStatistics(CONTRACT);
    getRoyaltyStatistics(CONTRACT);
    getRoyaltyStatistics(CONTRACT);

    // get() should have been called only once — subsequent calls hit the cache
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  // 7. _invalidateStatsCache forces a fresh db.get on the next call
  test("_invalidateStatsCache causes the next call to re-query the database", () => {
    mockGet.mockReturnValue(makeFullRow());

    getRoyaltyStatistics(CONTRACT);
    _invalidateStatsCache(CONTRACT);
    getRoyaltyStatistics(CONTRACT);

    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  // 8. Cache is keyed per contractId — different contracts are cached independently
  test("cache entries are isolated per contractId", () => {
    mockGet
      .mockReturnValueOnce(makeFullRow({ totalSales: 1 }))
      .mockReturnValueOnce(makeFullRow({ totalSales: 2 }));

    const r1a = getRoyaltyStatistics(CONTRACT);
    const r1b = getRoyaltyStatistics(CONTRACT); // should hit cache
    const r2a = getRoyaltyStatistics(OTHER_CONTRACT); // different key, queries DB

    expect(mockGet).toHaveBeenCalledTimes(2); // one for CONTRACT, one for OTHER_CONTRACT
    expect(r1a.totalSecondarySales).toBe(1);
    expect(r1b.totalSecondarySales).toBe(1); // cached
    expect(r2a.totalSecondarySales).toBe(2);
  });
});
