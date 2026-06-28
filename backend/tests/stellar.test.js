/**
 * Tests for the operational hardening added to `src/stellar.js`:
 *   #273 — RPC timeout
 *   #274 — Dynamic fee from Horizon /fee_stats with 30s cache + fallback
 *   #275 — Sequence number refreshed on every retry
 */
import {
  jest,
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
} from "@jest/globals";

beforeEach(() => {
  // Test isolation — clear caches and module mocks between cases.
  jest.resetModules();
});

afterEach(() => {
  jest.useRealTimers();
});

// ── #273 — RPC timeout ─────────────────────────────────────────────────────

describe("withTimeout (#273)", () => {
  test("rejects with a 504-shaped error when the inner promise never settles", async () => {
    const { withTimeout } = await import("../src/stellar.js");
    const slow = new Promise(() => {});
    await expect(withTimeout(slow, 10, "test-op")).rejects.toMatchObject({
      status: 504,
      message: expect.stringContaining("test-op"),
    });
  });

  test("forwards the inner value when it settles before the deadline", async () => {
    const { withTimeout } = await import("../src/stellar.js");
    const fast = Promise.resolve("ok");
    await expect(withTimeout(fast, 100, "test-op")).resolves.toBe("ok");
  });

  test("forwards the inner rejection unchanged when it loses to the timer", async () => {
    const { withTimeout } = await import("../src/stellar.js");
    const boom = Promise.reject(new Error("upstream boom"));
    await expect(
      withTimeout(boom, 100, "test-op"),
    ).rejects.toThrow(/upstream boom/);
  });
});

// ── #274 — Dynamic fee with cache + fallback ───────────────────────────────

describe("getRecommendedFee (#274)", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("returns the median accepted fee from Horizon and caches it", async () => {
    let calls = 0;
    global.fetch = jest.fn(async () => {
      calls += 1;
      return {
        ok: true,
        json: async () => ({
          fee_charged: { p50: "250" },
          last_ledger_base_fee: 100,
        }),
      };
    });

    const stellar = await import("../src/stellar.js");
    stellar._resetFeeCache();
    expect(await stellar.getRecommendedFee()).toBe("250");
    expect(await stellar.getRecommendedFee()).toBe("250");
    expect(calls).toBe(1); // second call served from cache
  });

  test("falls back to last_ledger_base_fee when p50 is missing", async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ last_ledger_base_fee: 150 }),
    }));

    const stellar = await import("../src/stellar.js");
    stellar._resetFeeCache();
    expect(await stellar.getRecommendedFee()).toBe("150");
  });

  test("falls back to BASE_FEE when Horizon responds with a non-2xx", async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 500 }));

    const stellar = await import("../src/stellar.js");
    stellar._resetFeeCache();
    const fee = await stellar.getRecommendedFee();
    // BASE_FEE in the @stellar/stellar-sdk is "100" (stroops).
    expect(fee).toBe("100");
  });

  test("falls back to BASE_FEE when fetch throws", async () => {
    global.fetch = jest.fn(async () => {
      throw new Error("ENOTFOUND");
    });

    const stellar = await import("../src/stellar.js");
    stellar._resetFeeCache();
    const fee = await stellar.getRecommendedFee();
    expect(fee).toBe("100");
  });

  test("cache expires after HORIZON_FEE_CACHE_MS", async () => {
    let calls = 0;
    const responses = ["100", "250"];
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        fee_charged: { p50: responses[Math.min(calls++, responses.length - 1)] },
      }),
    }));

    jest.useFakeTimers();
    const stellar = await import("../src/stellar.js");
    stellar._resetFeeCache();
    expect(await stellar.getRecommendedFee()).toBe("100");

    // Advance past the default 30s cache window.
    jest.setSystemTime(Date.now() + 31_000);
    expect(await stellar.getRecommendedFee()).toBe("250");
  });
});

// ── #275 — Sequence refresh on every retry ────────────────────────────────

describe("retryBuildTx sequence-refresh contract (#275)", () => {
  test("calls server.getAccount on every retry attempt", async () => {
    // We mock the entire stellar module's `server` so we can count
    // getAccount invocations across retries.
    const getAccount = jest.fn(async () => ({
      accountId: () => "GTEST",
      sequenceNumber: () => "1",
    }));
    const prepareTransaction = jest.fn();

    // First two prepareTransaction calls fail with a network error so the
    // retry loop runs through three attempts total.
    prepareTransaction
      .mockRejectedValueOnce(Object.assign(new Error("network glitch"), {}))
      .mockRejectedValueOnce(Object.assign(new Error("network glitch"), {}))
      .mockResolvedValueOnce({ toXDR: () => "MOCK_XDR" });

    jest.unstable_mockModule("@stellar/stellar-sdk", () => {
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
            getAccount = getAccount;
            prepareTransaction = prepareTransaction;
            simulateTransaction = jest.fn();
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
    });

    // Patch fetch so getRecommendedFee resolves quickly to BASE_FEE.
    global.fetch = jest.fn(async () => ({ ok: false, status: 500 }));

    const stellar = await import("../src/stellar.js");
    stellar._resetFeeCache();

    const xdr = await stellar.retryBuildTx(
      "GCALLER",
      "CCONTRACT",
      "noop",
      [],
    );
    expect(xdr).toBe("MOCK_XDR");
    expect(getAccount).toHaveBeenCalledTimes(3);
    // Each call uses the same caller — but a *separate* fetch — which is
    // exactly the freshness guarantee.
    for (const call of getAccount.mock.calls) {
      expect(call[0]).toBe("GCALLER");
    }
  });
});

// ── #294 — Concurrent build lock ────────────────────────────────────────

describe("buildTx concurrent locking (#294)", () => {
  test("serializes getAccount for the same caller address", async () => {
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
      };
    });
    const prepareTransaction = jest.fn(async () => ({ toXDR: () => "MOCK_XDR" }));

    jest.unstable_mockModule("@stellar/stellar-sdk", () => {
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
            getAccount = getAccount;
            prepareTransaction = prepareTransaction;
            simulateTransaction = jest.fn();
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
    });

    global.fetch = jest.fn(async () => ({ ok: false, status: 500 }));

    const stellar = await import("../src/stellar.js");
    stellar._resetFeeCache();
    stellar._resetAccountBuildLocks();

    await Promise.all([
      stellar.buildTx("GCALLER", "CCONTRACT", "noop", []),
      stellar.buildTx("GCALLER", "CCONTRACT", "noop", []),
    ]);

    expect(maxInFlight).toBe(1);
    expect(getAccount).toHaveBeenCalledTimes(2);
  });
});

// ── #297 — Horizon transaction polling ─────────────────────────────────────

describe("pollHorizonTransaction (#297)", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    jest.useFakeTimers();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  test("returns confirmed status when Horizon finds a successful transaction", async () => {
    global.fetch = jest.fn(async () => ({
      status: 200,
      ok: true,
      json: async () => ({
        successful: true,
        ledger: 555,
        created_at: "2026-05-31T12:00:00.000Z",
      }),
    }));

    const { pollHorizonTransaction } = await import("../src/stellar.js");
    const hash = "b".repeat(64);

    await expect(pollHorizonTransaction(hash)).resolves.toMatchObject({
      status: "confirmed",
      ledger: 555,
    });
  });

  test("retries on 404 until the transaction appears", async () => {
    let calls = 0;
    global.fetch = jest.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return { status: 404, ok: false };
      }
      return {
        status: 200,
        ok: true,
        json: async () => ({
          successful: true,
          ledger: 1,
          created_at: "2026-05-31T12:00:00.000Z",
        }),
      };
    });

    const { pollHorizonTransaction } = await import("../src/stellar.js");
    const hash = "c".repeat(64);
    const promise = pollHorizonTransaction(hash);

    await jest.advanceTimersByTimeAsync(2000);
    await expect(promise).resolves.toMatchObject({ status: "confirmed" });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
