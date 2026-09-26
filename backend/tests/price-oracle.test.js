/**
 * Tests for the XLM/USD price oracle — new scope added for #924 (no
 * price-conversion source existed in this codebase before this change).
 */
import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import { getXlmUsdPrice, resetPriceCache, xlmToUsdCents } from "../src/services/price-oracle.js";

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe("getXlmUsdPrice (#924)", () => {
  beforeEach(() => {
    resetPriceCache();
  });

  test("resolves the rate from a successful response", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, { stellar: { usd: 0.42 } }));

    const result = await getXlmUsdPrice({ fetchImpl, cacheTtlMs: 0 });

    expect(result).toEqual({ ok: true, rate: 0.42, source: "coingecko", fetchedAt: expect.any(String) });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("never throws — resolves a typed failure on a network error", async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error("ECONNRESET"));

    const result = await getXlmUsdPrice({ fetchImpl, cacheTtlMs: 0 });

    expect(result).toEqual({ ok: false, reason: "network_error" });
  });

  test("never throws — resolves a typed failure on a non-2xx response", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(503, {}));

    const result = await getXlmUsdPrice({ fetchImpl, cacheTtlMs: 0 });

    expect(result).toEqual({ ok: false, reason: "upstream_error_503" });
  });

  test("never throws — resolves a typed failure on malformed JSON", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("Unexpected token");
      },
    });

    const result = await getXlmUsdPrice({ fetchImpl, cacheTtlMs: 0 });

    expect(result).toEqual({ ok: false, reason: "invalid_response" });
  });

  test("rejects a missing or non-numeric price", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, { stellar: {} }));
    const result = await getXlmUsdPrice({ fetchImpl, cacheTtlMs: 0 });
    expect(result).toEqual({ ok: false, reason: "invalid_price" });
  });

  test("rejects a zero or negative price", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, { stellar: { usd: 0 } }));
    const result = await getXlmUsdPrice({ fetchImpl, cacheTtlMs: 0 });
    expect(result).toEqual({ ok: false, reason: "invalid_price" });
  });

  test("resolves a typed failure when no fetch implementation is available", async () => {
    // Passing `undefined` would fall through to the real global fetch (a valid
    // default-parameter behavior in this Node runtime, which does have fetch),
    // so simulate an environment with no fetch by passing a non-function value.
    const result = await getXlmUsdPrice({ fetchImpl: null, cacheTtlMs: 0 });
    expect(result).toEqual({ ok: false, reason: "fetch_unavailable" });
  });

  test("reuses a cached rate within the TTL instead of calling fetch again", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, { stellar: { usd: 0.5 } }));

    const first = await getXlmUsdPrice({ fetchImpl, cacheTtlMs: 60_000 });
    const second = await getXlmUsdPrice({ fetchImpl, cacheTtlMs: 60_000 });

    expect(first).toEqual({ ok: true, rate: 0.5, source: "coingecko", fetchedAt: expect.any(String) });
    expect(second).toEqual({ ok: true, rate: 0.5, source: "cache", fetchedAt: expect.any(String) });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("bypassCache forces a fresh fetch even with a warm cache", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { stellar: { usd: 0.5 } }))
      .mockResolvedValueOnce(jsonResponse(200, { stellar: { usd: 0.6 } }));

    await getXlmUsdPrice({ fetchImpl, cacheTtlMs: 60_000 });
    const second = await getXlmUsdPrice({ fetchImpl, cacheTtlMs: 60_000, bypassCache: true });

    expect(second.rate).toBe(0.6);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("xlmToUsdCents (#924)", () => {
  test("converts the exact amount to the correct USD cents — the issue's named E2E scenario", () => {
    // 100 XLM at $0.42/XLM = $42.00 = 4200 cents.
    expect(xlmToUsdCents(100, 0.42)).toBe(4200);
  });

  test("rounds to the nearest cent", () => {
    expect(xlmToUsdCents(1, 0.12345)).toBe(12); // 12.345 cents -> 12
    expect(xlmToUsdCents(1, 0.126)).toBe(13); // 12.6 cents -> 13
  });

  test("accepts a numeric string amount", () => {
    expect(xlmToUsdCents("100", 0.42)).toBe(4200);
  });

  test("handles a zero amount", () => {
    expect(xlmToUsdCents(0, 0.42)).toBe(0);
  });

  test("throws on a negative amount", () => {
    expect(() => xlmToUsdCents(-5, 0.42)).toThrow();
  });

  test("throws on a non-finite amount", () => {
    expect(() => xlmToUsdCents(Infinity, 0.42)).toThrow();
    expect(() => xlmToUsdCents(NaN, 0.42)).toThrow();
  });

  test("throws on a negative rate", () => {
    expect(() => xlmToUsdCents(10, -0.1)).toThrow();
  });
});
