import { describe, expect, jest, test } from "@jest/globals";

const invalidateCacheDistributed = jest.fn();
await jest.unstable_mockModule("../src/cache.js", () => ({
  invalidateCacheDistributed,
}));

const { createWarmingCache } = await import("../src/utils.js");
const { invalidateContractCaches } = await import("../src/cache-invalidation.js");

describe("warming cache (#1166)", () => {
  test("loads once and serves the cached value", async () => {
    const cache = createWarmingCache(60_000, 10_000);
    const loadValue = jest.fn().mockResolvedValue("fresh-value");

    await expect(cache.get("contract-1", loadValue)).resolves.toBe("fresh-value");
    await expect(cache.get("contract-1", loadValue)).resolves.toBe("fresh-value");
    expect(loadValue).toHaveBeenCalledTimes(1);
  });

  test("coalesces concurrent initial loads", async () => {
    const cache = createWarmingCache();
    let resolveLoad;
    const loadValue = jest.fn(
      () =>
        new Promise((resolve) => {
          resolveLoad = resolve;
        })
    );

    const firstRead = cache.get("contract-1", loadValue);
    const secondRead = cache.get("contract-1", loadValue);
    await Promise.resolve();
    resolveLoad("shared-value");

    await expect(Promise.all([firstRead, secondRead])).resolves.toEqual([
      "shared-value",
      "shared-value",
    ]);
    expect(loadValue).toHaveBeenCalledTimes(1);
  });
});

describe("secondary royalty cache invalidation (#1168)", () => {
  test("invalidates the secondary royalty pool namespace", () => {
    invalidateCacheDistributed.mockClear();

    invalidateContractCaches("C123", { reason: "secondary-distribute" });

    expect(invalidateCacheDistributed).toHaveBeenCalledWith("secondaryRoyaltyPool:C123", {
      prefix: true,
      reason: "secondary-distribute",
    });
  });
});
