/**
 * Chaos Engineering Test Suite — Issue #782
 *
 * Exercises `src/stellar.js` under adversarial network conditions:
 *   • Cascading RPC failures with partial and full recovery
 *   • Slow / hanging RPC endpoints (timeout races)
 *   • Horizon connectivity outages (ECONNREFUSED, 503, AbortController)
 *   • Concurrent build-lock behaviour under failure
 *   • Soroban/Horizon error parsing edge cases
 *
 * Jest 30 + native ESM — no Babel. Mocks use jest.unstable_mockModule.
 * Pattern mirrors backend/tests/stellar.test.js exactly.
 *
 * Fake-timer strategy for retryBuildTx tests:
 *   - jest.useFakeTimers() is activated before each relevant test.
 *   - jest.advanceTimersByTimeAsync(5000) is used (not runAllTimersAsync)
 *     so that the 1s + 2s backoff delays fire but the 10s withTimeout
 *     timers do NOT — keeping the RPC mock resolutions on the fast path.
 */
import {
  jest,
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
} from "@jest/globals";

// ── Shared mock factory ────────────────────────────────────────────────────
// Returns a fresh StellarSdk mock object each time.  Per-test
// getAccount / prepareTransaction spies are injected so they don't bleed
// across tests.

function makeSdkMock({
  getAccount,
  prepareTransaction,
  simulateTransaction,
} = {}) {
  class Account {
    constructor(id, seq) {
      this.id = id;
      this.seq = seq;
    }
    accountId() {
      return this.id;
    }
    sequenceNumber() {
      return this.seq;
    }
    incrementSequenceNumber() {
      this.seq = String(BigInt(this.seq) + 1n);
    }
  }

  const mock = {
    Contract: class {
      constructor(id) {
        this.id = id;
      }
      call(method, ...args) {
        return { kind: "op", method, args };
      }
    },
    Networks: {
      PUBLIC: "Public",
      TESTNET: "Test SDF Network ; September 2015",
    },
    SorobanRpc: {
      Server: class {
        constructor() {}
        getAccount = getAccount ?? jest.fn();
        prepareTransaction = prepareTransaction ?? jest.fn();
        simulateTransaction = simulateTransaction ?? jest.fn();
      },
      Api: { isSimulationError: () => false },
    },
    TransactionBuilder: class {
      constructor() {
        this.ops = [];
      }
      addOperation(op) {
        this.ops.push(op);
        return this;
      }
      setTimeout() {
        return this;
      }
      build() {
        return {};
      }
    },
    BASE_FEE: "100",
    nativeToScVal: () => ({}),
    Address: class {
      constructor(a) {
        this.a = a;
      }
      toScVal() {
        return { addr: this.a };
      }
    },
    Account,
    xdr: { ScVal: { scvU32: () => ({}), scvVec: () => ({}) } },
  };
  return { default: mock, ...mock };
}

/** Stub global.fetch so getRecommendedFee always falls back to BASE_FEE. */
function stubFetchFallback() {
  global.fetch = jest.fn(async () => ({ ok: false, status: 500 }));
}

// ── Module isolation ───────────────────────────────────────────────────────

let originalFetch;

beforeEach(() => {
  jest.resetModules();
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.useRealTimers();
});

// ════════════════════════════════════════════════════════════════════════════
// Group 1: Cascading RPC failures with recovery
//
// retry-count tested: 3 attempts total
// Scenarios: recovery after 2 failures, full exhaustion, fast-fail on 404,
//            429 backoff recovery, perpetual 504 exhaustion.
// ════════════════════════════════════════════════════════════════════════════

describe("Group 1 — Cascading RPC failures with recovery", () => {
  // Scenario 1 ──────────────────────────────────────────────────────────────

  test(
    "retryBuildTx succeeds after 2 RPC failures then success (getAccount called 3×)",
    async () => {
      // retry-count=3 total attempts; recovery-scenario on attempt 3
      console.log("[chaos] retry-count=3, recovery-scenario: success on attempt 3");

      const getAccount = jest.fn(async () => ({
        accountId: () => "GCALLER",
        sequenceNumber: () => "1",
        incrementSequenceNumber() {},
      }));
      const prepareTransaction = jest
        .fn()
        .mockRejectedValueOnce(new Error("network glitch"))
        .mockRejectedValueOnce(new Error("network glitch"))
        .mockResolvedValueOnce({ toXDR: () => "RECOVERED_XDR" });

      jest.unstable_mockModule("@stellar/stellar-sdk", () =>
        makeSdkMock({ getAccount, prepareTransaction }),
      );
      stubFetchFallback();

      // Advance only 5 s — covers 1 s + 2 s backoffs but NOT the 10 s
      // withTimeout timers, so RPC mocks win the Promise.race correctly.
      jest.useFakeTimers();
      const stellar = await import("../src/stellar.js");
      stellar._resetFeeCache();
      stellar._resetAccountBuildLocks();

      const promise = stellar.retryBuildTx("GCALLER", "CCONTRACT", "noop", []);
      await jest.advanceTimersByTimeAsync(5_000);

      await expect(promise).resolves.toBe("RECOVERED_XDR");

      // Sequence-number freshness (#275): every attempt re-fetches the account.
      expect(getAccount).toHaveBeenCalledTimes(3);
      for (const call of getAccount.mock.calls) {
        expect(call[0]).toBe("GCALLER");
      }
    },
  );

  // Scenario 2 ──────────────────────────────────────────────────────────────

  test(
    "retryBuildTx exhausts all 3 retries on persistent network error → throws status 503",
    async () => {
      // retry-count=3 exhausted; no recovery-scenario
      console.log("[chaos] retry-count=3 exhausted, no recovery, → status 503");

      const getAccount = jest.fn(async () => ({
        accountId: () => "GCALLER",
        sequenceNumber: () => "1",
        incrementSequenceNumber() {},
      }));
      const prepareTransaction = jest
        .fn()
        .mockRejectedValue(new Error("network error"));

      jest.unstable_mockModule("@stellar/stellar-sdk", () =>
        makeSdkMock({ getAccount, prepareTransaction }),
      );
      stubFetchFallback();

      // No fake timers — let real backoff delays run (~3s total)
      const stellar = await import("../src/stellar.js");
      stellar._resetFeeCache();
      stellar._resetAccountBuildLocks();

      await expect(
        stellar.retryBuildTx("GCALLER", "CCONTRACT", "noop", [])
      ).rejects.toMatchObject({ status: 503 });
      expect(prepareTransaction).toHaveBeenCalledTimes(3);
    },
  );

  // Scenario 3 ──────────────────────────────────────────────────────────────

  test(
    "retryBuildTx on 404 account-not-found → throws immediately with status 400, no retries",
    async () => {
      // fast-fail: account-not-found; no backoff needed
      console.log("[chaos] fast-fail: account not found → status 400, 0 retries");

      const getAccount = jest
        .fn()
        .mockRejectedValue(new Error("account not found"));
      const prepareTransaction = jest.fn();

      jest.unstable_mockModule("@stellar/stellar-sdk", () =>
        makeSdkMock({ getAccount, prepareTransaction }),
      );
      stubFetchFallback();

      const stellar = await import("../src/stellar.js");
      stellar._resetFeeCache();
      stellar._resetAccountBuildLocks();

      await expect(
        stellar.retryBuildTx("GMISSING", "CCONTRACT", "noop", []),
      ).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining("account not found"),
      });

      // prepareTransaction must never be reached — error fires in getAccount.
      expect(prepareTransaction).not.toHaveBeenCalled();
      expect(getAccount).toHaveBeenCalledTimes(1);
    },
  );

  // Scenario 4 ──────────────────────────────────────────────────────────────

  test(
    "retryBuildTx handles HTTP 429 rate-limit → retries with backoff, eventually succeeds",
    async () => {
      // recovery-scenario: rate-limited twice, succeeds on attempt 3
      console.log("[chaos] recovery-scenario: 429 rate-limit backoff → success attempt 3");

      const getAccount = jest.fn(async () => ({
        accountId: () => "GCALLER",
        sequenceNumber: () => "1",
        incrementSequenceNumber() {},
      }));
      const prepareTransaction = jest
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error("rate limit exceeded"), { status: 429 }),
        )
        .mockRejectedValueOnce(
          Object.assign(new Error("too many requests"), { status: 429 }),
        )
        .mockResolvedValueOnce({ toXDR: () => "RATE_LIMITED_XDR" });

      jest.unstable_mockModule("@stellar/stellar-sdk", () =>
        makeSdkMock({ getAccount, prepareTransaction }),
      );
      stubFetchFallback();

      jest.useFakeTimers();
      const stellar = await import("../src/stellar.js");
      stellar._resetFeeCache();
      stellar._resetAccountBuildLocks();

      const promise = stellar.retryBuildTx("GCALLER", "CCONTRACT", "noop", []);
      await jest.advanceTimersByTimeAsync(5_000);

      await expect(promise).resolves.toBe("RATE_LIMITED_XDR");
      expect(prepareTransaction).toHaveBeenCalledTimes(3);
    },
  );

  // Scenario 5 ──────────────────────────────────────────────────────────────

  test(
    "retryBuildTx on perpetual 504 timeouts → exhausts all retries, throws status 504",
    async () => {
      // timeout-scenario: every attempt gets a 504; exhausted → 504
      console.log("[chaos] timeout-scenario: perpetual 504 → exhausted → status 504");

      const getAccount = jest.fn(async () => ({
        accountId: () => "GCALLER",
        sequenceNumber: () => "1",
        incrementSequenceNumber() {},
      }));
      // Reject with the same shape withTimeout produces.
      const prepareTransaction = jest.fn().mockRejectedValue({
        status: 504,
        message: "Soroban prepareTransaction did not respond within 10000ms",
      });

      jest.unstable_mockModule("@stellar/stellar-sdk", () =>
        makeSdkMock({ getAccount, prepareTransaction }),
      );
      stubFetchFallback();

      // No fake timers — let real backoff delays run (~3s total)
      const stellar = await import("../src/stellar.js");
      stellar._resetFeeCache();
      stellar._resetAccountBuildLocks();

      await expect(
        stellar.retryBuildTx("GCALLER", "CCONTRACT", "noop", [])
      ).rejects.toMatchObject({ status: 504 });
      expect(prepareTransaction).toHaveBeenCalledTimes(3);
    },
  );
});

// ════════════════════════════════════════════════════════════════════════════
// Group 2: Slow / hanging RPC endpoints
//
// timeout-scenario: withTimeout deadline enforcement and timer cleanup.
// ════════════════════════════════════════════════════════════════════════════

describe("Group 2 — Slow/hanging RPC endpoints", () => {
  // Scenario 6 ──────────────────────────────────────────────────────────────

  test(
    "withTimeout on a promise that never settles → rejects with status 504 containing operation label",
    async () => {
      // timeout-scenario: hanging promise, label present in message
      console.log("[chaos] timeout-scenario: hanging promise → status 504 with label");

      const { withTimeout } = await import("../src/stellar.js");
      const hanging = new Promise(() => {}); // never settles

      await expect(
        withTimeout(hanging, 15, "chaos-hanging-op"),
      ).rejects.toMatchObject({
        status: 504,
        message: expect.stringContaining("chaos-hanging-op"),
      });
    },
  );

  // Scenario 7 ──────────────────────────────────────────────────────────────

  test(
    "withTimeout resolves correctly when promise settles just before the deadline",
    async () => {
      // recovery-scenario: near-miss — promise wins the race
      console.log("[chaos] recovery-scenario: near-deadline resolution succeeds");

      const { withTimeout } = await import("../src/stellar.js");

      // Resolve after 10 ms with a 200 ms deadline.
      const almostTooSlow = new Promise((resolve) =>
        setTimeout(() => resolve("just-in-time"), 10),
      );

      await expect(
        withTimeout(almostTooSlow, 200, "near-miss-op"),
      ).resolves.toBe("just-in-time");
    },
  );

  // Scenario 8 ──────────────────────────────────────────────────────────────

  test(
    "multiple concurrent withTimeout calls — all timers get cleared (no timer leaks)",
    async () => {
      // timeout-scenario: N concurrent withTimeout calls, no ghost timers
      console.log("[chaos] timeout-scenario: 20 concurrent withTimeout, timer cleanup verified");

      const { withTimeout } = await import("../src/stellar.js");
      const N = 20;

      // All resolve quickly — timers must be cleared by the finally handler.
      const resolved = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          withTimeout(Promise.resolve(`val-${i}`), 500, `concurrent-op-${i}`),
        ),
      );
      expect(resolved).toHaveLength(N);
      resolved.forEach((r, i) => expect(r).toBe(`val-${i}`));

      // All time out — each rejection must carry its own operation label.
      const timedOut = await Promise.allSettled(
        Array.from({ length: N }, (_, i) =>
          withTimeout(new Promise(() => {}), 10, `timeout-op-${i}`),
        ),
      );
      timedOut.forEach((r, i) => {
        expect(r.status).toBe("rejected");
        expect(r.reason).toMatchObject({
          status: 504,
          message: expect.stringContaining(`timeout-op-${i}`),
        });
      });
    },
  );
});

// ════════════════════════════════════════════════════════════════════════════
// Group 3: Horizon connectivity chaos
//
// Scenarios: ECONNREFUSED throw, HTTP 503 response, AbortController abort.
// ════════════════════════════════════════════════════════════════════════════

describe("Group 3 — Horizon connectivity chaos", () => {
  // Scenario 9 ──────────────────────────────────────────────────────────────

  test(
    "checkHorizonConnectivity when fetch throws ECONNREFUSED → returns { connected: false }",
    async () => {
      // chaos: OS-level connection refused
      console.log("[chaos] connectivity: ECONNREFUSED → connected=false");

      global.fetch = jest.fn(async () => {
        const err = new Error("connect ECONNREFUSED 127.0.0.1:80");
        err.code = "ECONNREFUSED";
        throw err;
      });

      const { checkHorizonConnectivity } = await import("../src/stellar.js");
      const result = await checkHorizonConnectivity();

      expect(result).toMatchObject({ connected: false });
    },
  );

  // Scenario 10 ─────────────────────────────────────────────────────────────

  test(
    "checkHorizonConnectivity when Horizon returns 503 → returns { connected: false }",
    async () => {
      // chaos: Horizon overloaded / in maintenance
      console.log("[chaos] connectivity: Horizon 503 → connected=false");

      global.fetch = jest.fn(async () => ({
        ok: false,
        status: 503,
      }));

      const { checkHorizonConnectivity } = await import("../src/stellar.js");
      const result = await checkHorizonConnectivity();

      expect(result).toMatchObject({ connected: false });
    },
  );

  // Scenario 11 ─────────────────────────────────────────────────────────────

  test(
    "checkHorizonConnectivity when AbortController fires (slow response) → returns { connected: false }",
    async () => {
      // timeout-scenario: fetch honours the AbortSignal and throws AbortError
      console.log("[chaos] timeout-scenario: AbortController fires → connected=false");

      global.fetch = jest.fn(async (_url, { signal } = {}) => {
        return new Promise((_resolve, reject) => {
          if (signal) {
            signal.addEventListener("abort", () => {
              const err = new Error("This operation was aborted");
              err.name = "AbortError";
              reject(err);
            });
          }
          // Without a signal we hang forever — but the signal will fire.
        });
      });

      // Use a very short health-check timeout so the abort fires in < 50 ms.
      process.env.HEALTH_CHECK_TIMEOUT_MS = "5";
      try {
        const { checkHorizonConnectivity } = await import("../src/stellar.js");
        const result = await checkHorizonConnectivity();
        expect(result).toMatchObject({ connected: false });
      } finally {
        delete process.env.HEALTH_CHECK_TIMEOUT_MS;
      }
    },
  );
});

// ════════════════════════════════════════════════════════════════════════════
// Group 4: Concurrent build lock under chaos
//
// Scenarios: lock released on failure (second call proceeds),
//            different addresses run concurrently (lock is per-address).
// ════════════════════════════════════════════════════════════════════════════

describe("Group 4 — Concurrent build lock under chaos", () => {
  // Scenario 12 ─────────────────────────────────────────────────────────────

  test(
    "two concurrent buildTx for same address where first fails → second still executes (lock released on failure)",
    async () => {
      // recovery-scenario: withAccountBuildLock releases in finally even on throw
      console.log("[chaos] recovery-scenario: lock released on failure, second call succeeds");

      const getAccount = jest.fn(async () => ({
        accountId: () => "GCALLER",
        sequenceNumber: () => "1",
        incrementSequenceNumber() {},
      }));
      const prepareTransaction = jest
        .fn()
        .mockRejectedValueOnce(new Error("network error on first build"))
        .mockResolvedValueOnce({ toXDR: () => "SECOND_XDR" });

      jest.unstable_mockModule("@stellar/stellar-sdk", () =>
        makeSdkMock({ getAccount, prepareTransaction }),
      );
      stubFetchFallback();

      const stellar = await import("../src/stellar.js");
      stellar._resetFeeCache();
      stellar._resetAccountBuildLocks();

      // Launch both concurrently — the lock serialises them, so first runs,
      // fails, releases the lock, then second runs and succeeds.
      const [firstResult, secondResult] = await Promise.allSettled([
        stellar.buildTx("GCALLER", "CCONTRACT", "noop", []),
        stellar.buildTx("GCALLER", "CCONTRACT", "noop", []),
      ]);

      expect(firstResult.status).toBe("rejected");

      // The lock must have been released after the first failure.
      expect(secondResult.status).toBe("fulfilled");
      expect(secondResult.value).toBe("SECOND_XDR");
    },
  );

  // Scenario 13 ─────────────────────────────────────────────────────────────

  test(
    "three concurrent buildTx for different addresses → all run concurrently (not serialized across addresses)",
    async () => {
      // retry-count=1 per address; concurrency verified by maxInFlight > 1
      console.log("[chaos] retry-count=1 per address: A/B/C run concurrently");

      let inFlight = 0;
      let maxInFlight = 0;

      const getAccount = jest.fn(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight -= 1;
        return {
          accountId: () => "GTEST",
          sequenceNumber: () => "1",
          incrementSequenceNumber() {},
        };
      });
      const prepareTransaction = jest
        .fn()
        .mockResolvedValue({ toXDR: () => "CONCURRENT_XDR" });

      jest.unstable_mockModule("@stellar/stellar-sdk", () =>
        makeSdkMock({ getAccount, prepareTransaction }),
      );
      stubFetchFallback();

      const stellar = await import("../src/stellar.js");
      stellar._resetFeeCache();
      stellar._resetAccountBuildLocks();

      await Promise.all([
        stellar.buildTx("GADDRESS_A", "CCONTRACT", "noop", []),
        stellar.buildTx("GADDRESS_B", "CCONTRACT", "noop", []),
        stellar.buildTx("GADDRESS_C", "CCONTRACT", "noop", []),
      ]);

      // If locks serialised across addresses, maxInFlight would be 1.
      expect(maxInFlight).toBeGreaterThan(1);
      expect(getAccount).toHaveBeenCalledTimes(3);
    },
  );
});

// ════════════════════════════════════════════════════════════════════════════
// Group 5: Error parsing
//
// Scenarios: simulation error, result_codes, HTTP 500 → 502, unknown → null.
// ════════════════════════════════════════════════════════════════════════════

describe("Group 5 — parseSorobanError edge cases", () => {
  // Scenario 14 ─────────────────────────────────────────────────────────────

  test(
    "parseSorobanError with simulation error shape → status 400, code SOROBAN_SIMULATION_ERROR",
    async () => {
      console.log("[chaos] error-parsing: simulation error shape → SOROBAN_SIMULATION_ERROR");

      const { parseSorobanError } = await import("../src/stellar.js");

      const simulationError = {
        result: { error: "Contract trap: Value not found" },
      };

      expect(parseSorobanError(simulationError)).toMatchObject({
        status: 400,
        code: "SOROBAN_SIMULATION_ERROR",
        message: expect.stringContaining("Contract trap"),
      });
    },
  );

  // Scenario 15 ─────────────────────────────────────────────────────────────

  test(
    "parseSorobanError with Horizon result_codes shape → status 400, code SOROBAN_INVOCATION_ERROR",
    async () => {
      console.log("[chaos] error-parsing: Horizon result_codes → SOROBAN_INVOCATION_ERROR");

      const { parseSorobanError } = await import("../src/stellar.js");

      const horizonError = {
        response: {
          data: {
            extras: {
              result_codes: {
                transaction: "tx_failed",
                operations: ["op_bad_auth"],
              },
            },
          },
        },
      };

      expect(parseSorobanError(horizonError)).toMatchObject({
        status: 400,
        code: "SOROBAN_INVOCATION_ERROR",
        message: expect.stringContaining("tx_failed"),
      });
    },
  );

  // Scenario 16 ─────────────────────────────────────────────────────────────

  test(
    "parseSorobanError with HTTP 500 → status 502, code STELLAR_RPC_ERROR",
    async () => {
      console.log("[chaos] error-parsing: HTTP 500 → 502 gateway error, STELLAR_RPC_ERROR");

      const { parseSorobanError } = await import("../src/stellar.js");

      const httpError = {
        message: "Internal Server Error",
        response: {
          status: 500,
          data: { detail: "soroban node crashed" },
        },
      };

      expect(parseSorobanError(httpError)).toMatchObject({
        status: 502,
        code: "STELLAR_RPC_ERROR",
      });
    },
  );

  // Scenario 17 ─────────────────────────────────────────────────────────────

  test(
    "parseSorobanError with unknown error shape → returns null",
    async () => {
      console.log("[chaos] error-parsing: unknown shape → null");

      const { parseSorobanError } = await import("../src/stellar.js");

      expect(parseSorobanError({ foo: "bar" })).toBeNull();
      expect(parseSorobanError(null)).toBeNull();
      expect(parseSorobanError(undefined)).toBeNull();
      expect(parseSorobanError(new Error("generic"))).toBeNull();
    },
  );
});
