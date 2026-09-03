/**
 * Integration tests for RPC retry with stellar.js operations.
 * Simulates real transient failures in getAccount and fee fetching.
 */

import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import { withRetry, retryConfig } from "../src/rpc-retry.js";

describe("RPC Retry Integration with Stellar Operations", () => {
  // Mock Horizon/Soroban responses
  const mockAccount = {
    id: "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    sequence: "123",
    subentry_count: 5,
  };

  const mockFeeStats = {
    fee_charged: { p50: "1000" },
    last_ledger_base_fee: "800",
  };

  describe("getAccount operation retry", () => {
    test("retries on network timeout and succeeds", async () => {
      let attempts = 0;
      const operation = jest.fn(async () => {
        attempts++;
        if (attempts === 1) {
          throw { status: 504, message: "Soroban getAccount did not respond within 10000ms" };
        }
        return mockAccount;
      });

      const result = await withRetry(operation, {
        operationType: "getAccount",
        details: { address: "GXXX..." },
      });

      expect(result).toEqual(mockAccount);
      expect(attempts).toBe(2);
    });

    test("retries on rate limit and succeeds", async () => {
      let attempts = 0;
      const operation = jest.fn(async () => {
        attempts++;
        if (attempts <= 2) {
          throw { response: { status: 429 } };
        }
        return mockAccount;
      });

      const result = await withRetry(operation, {
        operationType: "getAccount",
      });

      expect(result).toEqual(mockAccount);
      expect(attempts).toBe(3);
    });

    test("does not retry on account not found", async () => {
      const operation = jest.fn(async () => {
        throw {
          response: {
            status: 400,
            data: { detail: "account not found" },
          },
          message: "Account not found on Stellar network",
        };
      });

      await expect(withRetry(operation, { operationType: "getAccount" })).rejects.toMatchObject({
        message: expect.stringContaining("Account not found"),
      });

      expect(operation).toHaveBeenCalledTimes(1);
    });

    test("does not retry on 400 bad request", async () => {
      const operation = jest.fn(async () => {
        throw { response: { status: 400, data: { error: "Invalid address format" } } };
      });

      await expect(withRetry(operation, { operationType: "getAccount" })).rejects.toMatchObject({
        response: expect.objectContaining({ status: 400 }),
      });

      expect(operation).toHaveBeenCalledTimes(1);
    });
  });

  describe("getFeeStats operation retry", () => {
    test("retries on service unavailable and succeeds", async () => {
      let attempts = 0;
      const operation = jest.fn(async () => {
        attempts++;
        if (attempts === 1) {
          throw { response: { status: 503 } };
        }
        return mockFeeStats;
      });

      const result = await withRetry(operation, {
        operationType: "getFeeStats",
        maxRetries: 2,
      });

      expect(result).toEqual(mockFeeStats);
      expect(attempts).toBe(2);
    });

    test("falls back gracefully after exhausting retries", async () => {
      const operation = jest.fn(async () => {
        throw { response: { status: 503, statusText: "Service Unavailable" } };
      });

      await expect(
        withRetry(operation, { operationType: "getFeeStats", maxRetries: 2 })
      ).rejects.toMatchObject({
        response: expect.objectContaining({ status: 503 }),
      });

      expect(operation).toHaveBeenCalledTimes(2);
    });

    test("retries on network error", async () => {
      let attempts = 0;
      const operation = jest.fn(async () => {
        attempts++;
        if (attempts === 1) {
          throw { code: "ECONNREFUSED", message: "Connection refused" };
        }
        return mockFeeStats;
      });

      const result = await withRetry(operation, {
        operationType: "getFeeStats",
      });

      expect(result).toEqual(mockFeeStats);
    });
  });

  describe("prepareTransaction operation retry", () => {
    test("retries on simulation transient error (429)", async () => {
      const mockTx = { xdr: "ABCD1234..." };
      let attempts = 0;
      const operation = jest.fn(async () => {
        attempts++;
        if (attempts === 1) {
          throw { response: { status: 429 } };
        }
        return mockTx;
      });

      const result = await withRetry(operation, {
        operationType: "prepareTransaction",
      });

      expect(result).toEqual(mockTx);
      expect(attempts).toBe(2);
    });

    test("does not retry on simulation error", async () => {
      const operation = jest.fn(async () => {
        throw {
          status: 400,
          message: "Contract simulation failed: contract returned error",
        };
      });

      await expect(
        withRetry(operation, { operationType: "prepareTransaction" })
      ).rejects.toMatchObject({
        message: expect.stringContaining("simulation"),
      });

      expect(operation).toHaveBeenCalledTimes(1);
    });
  });

  describe("submitTransaction operation (should never retry)", () => {
    test("immediately rejects on any error without retry", async () => {
      const operation = jest.fn(async () => {
        throw { response: { status: 503 } };
      });

      await expect(
        withRetry(operation, { operationType: "submitTransaction" })
      ).rejects.toMatchObject({
        response: expect.objectContaining({ status: 503 }),
      });

      expect(operation).toHaveBeenCalledTimes(1);
    });

    test("warns when attempting to retry submit", async () => {
      const { default: logger } = await import("../src/logger.js");
      const warnSpy = jest.spyOn(logger, "warn").mockImplementation();
      const operation = jest.fn();

      try {
        await withRetry(operation, { operationType: "submit" });
      } catch (e) {
        // Expected to fail
      }

      expect(warnSpy).toHaveBeenCalled();
      const callArgs = warnSpy.mock.calls[0];
      expect(callArgs[0]).toContain("should never be automatically retried");

      warnSpy.mockRestore();
    });
  });

  describe("Cascading transient failures", () => {
    test("recovers after multiple transient failures", async () => {
      let attempts = 0;
      const operation = jest.fn(async () => {
        attempts++;
        if (attempts === 1) throw { response: { status: 503 } };
        if (attempts === 2) throw { code: "ETIMEDOUT" };
        if (attempts === 3) throw { status: 504 };
        return mockAccount;
      });

      const result = await withRetry(operation, {
        operationType: "getAccount",
        maxRetries: 5,
      });

      expect(result).toEqual(mockAccount);
      expect(attempts).toBe(4);
    });

    test("stops on first permanent error despite prior transient failures", async () => {
      let attempts = 0;
      const operation = jest.fn(async () => {
        attempts++;
        if (attempts === 1) throw { response: { status: 503 } };
        if (attempts === 2) throw { response: { status: 400 } };
        return mockAccount;
      });

      await expect(withRetry(operation, { operationType: "getAccount" })).rejects.toMatchObject({
        response: expect.objectContaining({ status: 400 }),
      });

      expect(attempts).toBe(2);
    });
  });

  describe("Backoff timing", () => {
    test("applies increasing backoff with each retry", async () => {
      const timings = [];
      let attempts = 0;
      const operation = jest.fn(async () => {
        attempts++;
        timings.push(Date.now());
        if (attempts <= 2) {
          throw { response: { status: 503 } };
        }
        return mockAccount;
      });

      await withRetry(operation, {
        operationType: "getAccount",
        baseBackoffMs: 100,
        maxRetries: 3,
      });

      // timings[1] - timings[0] should be >= 100ms (first backoff)
      // timings[2] - timings[1] should be >= 200ms (second backoff, exponential)
      const firstBackoff = timings[1] - timings[0];
      const secondBackoff = timings[2] - timings[1];

      expect(firstBackoff).toBeGreaterThanOrEqual(90);
      expect(secondBackoff).toBeGreaterThanOrEqual(180);
      expect(secondBackoff).toBeGreaterThan(firstBackoff);
    });
  });

  describe("Error categorization", () => {
    test("correctly identifies transient vs permanent errors", async () => {
      const transientErrors = [
        { response: { status: 429 } },
        { response: { status: 503 } },
        { response: { status: 504 } },
        { response: { status: 408 } },
        { code: "ECONNREFUSED" },
        { message: "timeout" },
      ];

      const permanentErrors = [
        { response: { status: 400 } },
        { response: { status: 401 } },
        { response: { status: 403 } },
        { message: "Contract simulation failed" },
        { message: "Account not found" },
      ];

      for (const error of transientErrors) {
        let retried = false;
        const operation = jest.fn(async () => {
          if (!retried) {
            retried = true;
            throw error;
          }
          return mockAccount;
        });

        const result = await withRetry(operation, {
          operationType: "getAccount",
        });

        expect(result).toEqual(mockAccount);
        expect(retried).toBe(true);
      }

      for (const error of permanentErrors) {
        const operation = jest.fn(async () => {
          throw error;
        });

        await expect(withRetry(operation, { operationType: "getAccount" })).rejects.toBeDefined();

        expect(operation).toHaveBeenCalledTimes(1);
      }
    });
  });
});
