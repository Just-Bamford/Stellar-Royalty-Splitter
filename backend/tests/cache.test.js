/**
 * Cache tests — covers #511 acceptance criteria:
 *  1. TTL per data type
 *  2. Cache hit / miss and hit ratio > 80% scenario
 *  3. Tag-based (event-driven) invalidation
 *  4. Async background refresh (stale-while-revalidate)
 *  5. Cache warming
 *  6. get-or-fetch deduplication
 */
import { jest, describe, test, expect, beforeEach } from "@jest/globals";

// Use real timers — we'll fake Date.now where needed
beforeEach(async () => {
  const { _resetCache } = await import("../src/cache.js");
  _resetCache();
});

// ── 1. TTL per data type ────────────────────────────────────────────────────

describe("TTL configuration per data type", () => {
  test("CONTRACT_STATE, COLLABORATORS, CONTRACT_INFO, FEE all have positive ms values", async () => {
    const { TTL } = await import("../src/cache.js");
    expect(TTL.CONTRACT_STATE).toBeGreaterThan(0);
    expect(TTL.COLLABORATORS).toBeGreaterThan(0);
    expect(TTL.CONTRACT_INFO).toBeGreaterThan(0);
    expect(TTL.FEE).toBeGreaterThan(0);
  });

  test("entry is fresh while within its TTL", async () => {
    const { cacheSet, cacheGet } = await import("../src/cache.js");
    cacheSet("k", "v", 5_000);
    expect(cacheGet("k")).toBe("v");
  });

  test("entry is expired after its TTL has elapsed", async () => {
    const { cacheSet, cacheGet } = await import("../src/cache.js");
    const pastMs = Date.now() - 10_000;
    // Manually insert a stale entry by setting fetchedAt in the past
    // We do this via cacheSet with a very short TTL and mocking Date.now
    const realNow = Date.now;
    Date.now = () => pastMs;
    cacheSet("stale-key", "old", 1_000); // TTL 1s, set 10s ago
    Date.now = realNow;

    expect(cacheGet("stale-key")).toBeUndefined();
  });
});

// ── 2. Hit ratio tracking ───────────────────────────────────────────────────

describe("Hit ratio monitoring", () => {
  test("hitRatio is 0 with no operations", async () => {
    const { getCacheMetrics } = await import("../src/cache.js");
    expect(getCacheMetrics().hitRatio).toBe(0);
  });

  test("hitRatio reaches > 0.8 after many hits", async () => {
    const { cacheSet, cacheGet, getCacheMetrics } = await import("../src/cache.js");
    cacheSet("key", "value", 60_000);

    // 9 hits
    for (let i = 0; i < 9; i++) cacheGet("key");
    // 1 miss
    cacheGet("missing");

    const { hitRatio, hits, misses } = getCacheMetrics();
    expect(hits).toBe(9);
    expect(misses).toBe(1);
    expect(hitRatio).toBeCloseTo(0.9, 2);
    expect(hitRatio).toBeGreaterThan(0.8);
  });

  test("cache size reflects number of stored entries", async () => {
    const { cacheSet, getCacheMetrics } = await import("../src/cache.js");
    cacheSet("a", 1, 1000);
    cacheSet("b", 2, 1000);
    expect(getCacheMetrics().size).toBe(2);
  });
});

// ── 3. Tag-based (event-driven) invalidation ───────────────────────────────

describe("Tag-based invalidation (smart invalidation)", () => {
  test("cacheInvalidateByTag removes all entries with that tag", async () => {
    const { cacheSet, cacheGet, cacheInvalidateByTag } = await import("../src/cache.js");
    cacheSet("state:A:T1", "s1", 60_000, ["CONTRACT_A"]);
    cacheSet("collab:A", "c1", 60_000, ["CONTRACT_A"]);
    cacheSet("state:B:T1", "s2", 60_000, ["CONTRACT_B"]);

    cacheInvalidateByTag("CONTRACT_A");

    expect(cacheGet("state:A:T1")).toBeUndefined();
    expect(cacheGet("collab:A")).toBeUndefined();
    expect(cacheGet("state:B:T1")).toBe("s2"); // unaffected
  });

  test("emitContractInvalidation event invalidates tagged entries", async () => {
    const { cacheSet, cacheGet, emitContractInvalidation } = await import("../src/cache.js");
    const contractId = "CTEST_INVALIDATION";
    cacheSet(`state:${contractId}`, "stateData", 60_000, [contractId]);
    cacheSet(`collab:${contractId}`, "collabData", 60_000, [contractId]);

    emitContractInvalidation(contractId);

    // Event is synchronous via EventEmitter
    expect(cacheGet(`state:${contractId}`)).toBeUndefined();
    expect(cacheGet(`collab:${contractId}`)).toBeUndefined();
  });

  test("cacheInvalidate removes a single key", async () => {
    const { cacheSet, cacheGet, cacheInvalidate } = await import("../src/cache.js");
    cacheSet("single", "val", 60_000);
    cacheInvalidate("single");
    expect(cacheGet("single")).toBeUndefined();
  });
});

// ── 4. Async background refresh (stale-while-revalidate) ───────────────────

describe("Async background refresh", () => {
  test("returns stale value immediately and refreshes in background", async () => {
    const { cacheGetWithAsyncRefresh, cacheGet, _resetCache } = await import("../src/cache.js");
    _resetCache();

    let fetchCount = 0;
    let resolveFetch;
    const fetchFn = () =>
      new Promise((resolve) => {
        fetchCount++;
        resolveFetch = resolve;
      });

    // Seed a stale entry
    const realNow = Date.now;
    Date.now = () => realNow() - 10_000;
    const { cacheSet } = await import("../src/cache.js");
    cacheSet("refresh-key", "stale-value", 1_000);
    Date.now = realNow;

    // Should return stale immediately and kick off refresh
    const { value, stale } = cacheGetWithAsyncRefresh("refresh-key", fetchFn, 60_000);
    expect(value).toBe("stale-value");
    expect(stale).toBe(true);
    expect(fetchCount).toBe(1);

    // Resolve the background fetch
    resolveFetch("fresh-value");
    await new Promise((r) => setImmediate(r));

    // Cache should now have the fresh value
    expect(cacheGet("refresh-key")).toBe("fresh-value");
  });

  test("cold miss returns undefined value and stale=false", async () => {
    const { cacheGetWithAsyncRefresh } = await import("../src/cache.js");
    const fetchFn = jest.fn().mockResolvedValue("data");
    const { value, stale } = cacheGetWithAsyncRefresh("cold-key", fetchFn, 60_000);
    expect(value).toBeUndefined();
    expect(stale).toBe(false);
  });

  test("does not start duplicate refresh for the same key", async () => {
    const { cacheGetWithAsyncRefresh, _resetCache } = await import("../src/cache.js");
    _resetCache();

    let resolveFirst;
    let fetchCallCount = 0;
    const slowFetch = () =>
      new Promise((res) => {
        fetchCallCount++;
        resolveFirst = res;
      });

    // Seed a stale entry
    const realNow = Date.now;
    Date.now = () => realNow() - 10_000;
    const { cacheSet } = await import("../src/cache.js");
    cacheSet("dup-key", "old", 1_000);
    Date.now = realNow;

    cacheGetWithAsyncRefresh("dup-key", slowFetch, 60_000);
    cacheGetWithAsyncRefresh("dup-key", slowFetch, 60_000); // second call — same key
    expect(fetchCallCount).toBe(1); // only one fetch started

    resolveFirst("new-val");
    await new Promise((r) => setImmediate(r));
  });
});

// ── 5. Cache warming ────────────────────────────────────────────────────────

describe("Cache warming", () => {
  test("warmCache pre-populates registered keys", async () => {
    const { registerWarmingKey, warmCache, cacheGet, _resetCache } = await import("../src/cache.js");
    _resetCache();

    registerWarmingKey("warm-key", async () => "warmed-value", 60_000);
    await warmCache();

    expect(cacheGet("warm-key")).toBe("warmed-value");
  });

  test("warmCache with a specific key only warms that key", async () => {
    const { registerWarmingKey, warmCache, cacheGet, _resetCache } = await import("../src/cache.js");
    _resetCache();

    registerWarmingKey("key-X", async () => "X", 60_000);
    registerWarmingKey("key-Y", async () => "Y", 60_000);

    await warmCache("key-X");
    expect(cacheGet("key-X")).toBe("X");
    expect(cacheGet("key-Y")).toBeUndefined(); // not warmed
  });

  test("warmCache failure is non-fatal", async () => {
    const { registerWarmingKey, warmCache, _resetCache } = await import("../src/cache.js");
    _resetCache();

    registerWarmingKey("bad-key", async () => { throw new Error("fetch failed"); }, 60_000);
    await expect(warmCache()).resolves.toBeUndefined(); // no throw
  });
});

// ── 6. cacheGetOrFetch ──────────────────────────────────────────────────────

describe("cacheGetOrFetch", () => {
  test("calls fetchFn on miss and caches result", async () => {
    const { cacheGetOrFetch, cacheGet } = await import("../src/cache.js");
    const fetchFn = jest.fn().mockResolvedValue("fetched");
    const result = await cacheGetOrFetch("new-key", fetchFn, 60_000);
    expect(result).toBe("fetched");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(cacheGet("new-key")).toBe("fetched");
  });

  test("returns cached value on hit without calling fetchFn", async () => {
    const { cacheSet, cacheGetOrFetch } = await import("../src/cache.js");
    cacheSet("cached-key", "cached-value", 60_000);
    const fetchFn = jest.fn().mockResolvedValue("should-not-be-called");
    const result = await cacheGetOrFetch("cached-key", fetchFn, 60_000);
    expect(result).toBe("cached-value");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
