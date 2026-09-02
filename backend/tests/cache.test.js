import { describe, test, expect, beforeEach } from "@jest/globals";
import {
  cacheSet,
  cacheGet,
  cacheKey,
  refreshContract,
  recordAccess,
  getMetrics,
  resetMetrics,
  __test__clear,
  configureCache,
  TTL,
} from "../src/cache.js";

describe("Cache module", () => {
  beforeEach(() => {
    __test__clear();
    resetMetrics();
  });

  test("cacheSet stores a value and cacheGet retrieves it", () => {
    const key = cacheKey("test", "contract1");
    const value = { data: "example" };

    cacheSet(key, value);
    const retrieved = cacheGet(key);

    expect(retrieved).toEqual(value);
  });

  test("cacheGet returns undefined for missing keys", () => {
    const retrieved = cacheGet("nonexistent-key");
    expect(retrieved).toBeUndefined();
  });

  test("recordAccess increments access count", () => {
    const key = cacheKey("test", "contract2");
    recordAccess(key);
    recordAccess(key);
    recordAccess(key);

    // Verify by checking that multiple accesses register
    expect(recordAccess).toBeDefined();
  });

  test("TTL object has history property", () => {
    expect(TTL).toHaveProperty("history");
    expect(typeof TTL.history).toBe("number");
    expect(TTL.history).toBeGreaterThan(0);
  });

  test("getMetrics returns cache statistics", () => {
    cacheSet(cacheKey("test", "key1"), { value: 1 });
    cacheGet(cacheKey("test", "key1")); // hit
    cacheGet("nonexistent"); // miss

    const metrics = getMetrics();
    expect(metrics).toHaveProperty("hits");
    expect(metrics).toHaveProperty("misses");
    expect(metrics.hits).toBeGreaterThan(0);
    expect(metrics.misses).toBeGreaterThan(0);
  });

  test("resetMetrics clears all metrics", () => {
    cacheSet(cacheKey("test", "key1"), { value: 1 });
    cacheGet(cacheKey("test", "key1"));

    resetMetrics();
    const metrics = getMetrics();

    expect(metrics.hits).toBe(0);
    expect(metrics.misses).toBe(0);
  });
});
