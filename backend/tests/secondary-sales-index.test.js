/**
 * Tests for secondary_sales composite index (issue #460).
 *
 * Verifies that:
 *  - Queries against secondary_sales use contractId as the leading WHERE predicate
 *    (matching the (contractId, distributed, timestamp DESC) index prefix)
 *  - The undistributedOnly flag adds the distributed = 0 predicate that the
 *    index covers
 *  - Results are ordered by timestamp DESC, matching the index sort direction
 */

import { jest, describe, test, expect, beforeEach } from "@jest/globals";

const prepareMock = jest.fn();
const countWriteMock = jest.fn();

await jest.unstable_mockModule("../src/database/core.js", () => ({
  db: {
    prepare: prepareMock,
    exec: jest.fn(),
    pragma: jest.fn(),
    transaction: (fn) => fn,
  },
  countWrite: countWriteMock,
  computeAuditEntryHash: jest.fn(),
}));

const { getSecondarySales, countSecondarySales } = await import(
  "../src/database/secondary-royalties.js"
);

const CONTRACT = "C" + "A".repeat(55);

function lastPreparedSql() {
  const calls = prepareMock.mock.calls;
  return calls[calls.length - 1][0];
}

describe("secondary_sales composite index query shape (issue #460)", () => {
  beforeEach(() => {
    prepareMock.mockReturnValue({
      run: jest.fn(),
      get: jest.fn(() => ({ total: 0 })),
      all: jest.fn(() => []),
    });
    prepareMock.mockClear();
  });

  test("undistributedOnly=true adds distributed=0 filter for index seek", () => {
    getSecondarySales(CONTRACT, 10, 0, null, true);
    expect(lastPreparedSql()).toContain("distributed = 0");
  });

  test("undistributedOnly=false omits distributed filter (all-sales path)", () => {
    getSecondarySales(CONTRACT, 10, 0, null, false);
    expect(lastPreparedSql()).not.toContain("distributed = 0");
  });

  test("contractId is the leading WHERE predicate matching the index prefix", () => {
    getSecondarySales(CONTRACT, 10, 0, null, true);
    const sql = lastPreparedSql();
    const contractIdIdx = sql.indexOf("contractId = ?");
    const distributedIdx = sql.indexOf("distributed = 0");
    expect(contractIdIdx).toBeGreaterThanOrEqual(0);
    expect(distributedIdx).toBeGreaterThanOrEqual(0);
    // contractId = ? (index prefix) must appear before distributed = 0 in the WHERE clause
    expect(contractIdIdx).toBeLessThan(distributedIdx);
  });

  test("query uses ORDER BY timestamp DESC matching the index sort direction", () => {
    getSecondarySales(CONTRACT, 10, 0, null, true);
    expect(lastPreparedSql()).toContain("ORDER BY timestamp DESC");
  });

  test("nftId filter combined with undistributedOnly still includes distributed=0", () => {
    getSecondarySales(CONTRACT, 50, 0, "nft-42", true);
    const sql = lastPreparedSql();
    expect(sql).toContain("distributed = 0");
    expect(sql).toContain("nftId = ?");
  });

  test("date-range filters combined with undistributedOnly preserve all predicates", () => {
    getSecondarySales(CONTRACT, 10, 0, null, true, "2024-01-01", "2024-12-31");
    const sql = lastPreparedSql();
    expect(sql).toContain("distributed = 0");
    expect(sql).toContain("timestamp >=");
    expect(sql).toContain("timestamp <=");
  });

  test("countSecondarySales uses contractId WHERE predicate", () => {
    countSecondarySales(CONTRACT);
    expect(lastPreparedSql()).toContain("contractId = ?");
  });
});
