import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import { db, initializeDatabase } from "../src/database/core.js";
import { getAnalyticsData, _clearAnalyticsCache } from "../src/database/analytics.js";

const CONTRACT = `C${"A".repeat(55)}`;

// #503: guards against regressing the analytics endpoint back to an N+1 pattern.
// The number of DB round-trips must stay constant (it must not scale with the
// number of transactions), and repeated calls inside the TTL must be served
// from cache rather than re-querying.
describe("analytics query (N+1 regression)", () => {
  beforeEach(() => {
    initializeDatabase();
    _clearAnalyticsCache();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("issues a constant, small number of queries regardless of data size", () => {
    const prepareSpy = jest.spyOn(db, "prepare");
    getAnalyticsData(CONTRACT, "2026-01-01", "2026-03-01");
    // summary + trends + topEarners + collaboratorStats = 4 set-based queries.
    expect(prepareSpy).toHaveBeenCalledTimes(4);
  });

  test("a second call within the TTL is served from cache (no extra queries)", () => {
    const prepareSpy = jest.spyOn(db, "prepare");
    getAnalyticsData(CONTRACT, "2026-01-01", "2026-03-01");
    prepareSpy.mockClear();
    getAnalyticsData(CONTRACT, "2026-01-01", "2026-03-01");
    expect(prepareSpy).not.toHaveBeenCalled();
  });

  test("returns the expected aggregate shape", () => {
    const result = getAnalyticsData(CONTRACT, "2026-01-01", "2026-03-01");
    expect(result).toHaveProperty("summary");
    expect(result).toHaveProperty("trends");
    expect(result).toHaveProperty("topEarners");
    expect(result).toHaveProperty("collaboratorStats");
  });
});
