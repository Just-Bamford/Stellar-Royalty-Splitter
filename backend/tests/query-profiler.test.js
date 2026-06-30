import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";

const warn = jest.fn();

await jest.unstable_mockModule("../src/logger.js", () => ({
  default: {
    warn,
  },
}));

const {
  getQueryProfilerMetrics,
  instrumentDatabase,
  profileQueryExecution,
  resetQueryProfilerMetrics,
} = await import("../src/query-profiler.js");

describe("query profiler", () => {
  const originalThreshold = process.env.SLOW_QUERY_THRESHOLD_MS;

  beforeEach(() => {
    process.env.SLOW_QUERY_THRESHOLD_MS = "0";
    warn.mockClear();
    resetQueryProfilerMetrics();
  });

  afterEach(() => {
    if (originalThreshold === undefined) {
      delete process.env.SLOW_QUERY_THRESHOLD_MS;
    } else {
      process.env.SLOW_QUERY_THRESHOLD_MS = originalThreshold;
    }
  });

  test("profiles direct query execution and logs slow samples", () => {
    const result = profileQueryExecution(
      "SELECT * FROM transactions GROUP BY contractId",
      "all",
      () => ["row"]
    );

    expect(result).toEqual(["row"]);

    const metrics = getQueryProfilerMetrics();
    expect(metrics.totalQueries).toBe(1);
    expect(metrics.slowQueries).toBe(1);
    expect(metrics.operations.all.count).toBe(1);
    expect(metrics.slowQuerySamples[0]).toMatchObject({
      sql: "SELECT * FROM transactions GROUP BY contractId",
      operation: "all",
      thresholdMs: 0,
    });
    expect(metrics.slowQuerySamples[0].recommendations.join(" ")).toMatch(/GROUP BY/);
    expect(warn).toHaveBeenCalledWith(
      "Slow database query detected",
      expect.objectContaining({ operation: "all" })
    );
  });

  test("instruments prepared statement get, all, and run calls", () => {
    const statement = {
      get: jest.fn(() => ({ id: 1 })),
      all: jest.fn(() => [{ id: 1 }]),
      run: jest.fn(() => ({ changes: 1 })),
    };
    const database = {
      prepare: jest.fn(() => statement),
    };

    instrumentDatabase(database);

    const prepared = database.prepare("SELECT * FROM audit_log WHERE contractId = ?");
    expect(prepared.get("contract")).toEqual({ id: 1 });
    expect(prepared.all("contract")).toEqual([{ id: 1 }]);
    expect(prepared.run("contract")).toEqual({ changes: 1 });

    const metrics = getQueryProfilerMetrics();
    expect(metrics.totalQueries).toBe(3);
    expect(metrics.operations.get.count).toBe(1);
    expect(metrics.operations.all.count).toBe(1);
    expect(metrics.operations.run.count).toBe(1);
  });

  test("resets profiler metrics", () => {
    profileQueryExecution("SELECT 1", "get", () => 1);
    resetQueryProfilerMetrics();

    expect(getQueryProfilerMetrics()).toMatchObject({
      totalQueries: 0,
      slowQueries: 0,
      slowQuerySamples: [],
    });
  });
});
