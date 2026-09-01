/**
 * Tests for BatchTransactionBuilder (#759) — batches multiple contract
 * invocations for one caller into a single getAccount/fee-estimation RPC
 * round trip instead of one per operation.
 */
import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";

function mockStellarSdk({ getAccount, prepareTransaction }) {
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
          return { kind: "op", contractId: this.id, method, args };
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
        constructor(account, opts) {
          this.account = account;
          this.opts = opts;
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
          return { account: this.account, ops: this.ops };
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
}

beforeEach(() => {
  jest.resetModules();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("BatchTransactionBuilder", () => {
  test("fetches the account and fee only once for a multi-operation batch", async () => {
    const getAccount = jest.fn(async () => ({
      accountId: () => "GCALLER",
      sequenceNumber: () => "100",
    }));
    const prepareTransaction = jest.fn(async (tx) => ({
      toXDR: () => `XDR(${tx.account.sequenceNumber()})`,
    }));
    mockStellarSdk({ getAccount, prepareTransaction });
    global.fetch = jest.fn(async () => ({ ok: false, status: 500 })); // forces BASE_FEE fallback

    const stellar = await import("../src/stellar.js");
    stellar._resetFeeCache();
    stellar._resetAccountBuildLocks();

    const builder = new stellar.BatchTransactionBuilder("GCALLER");
    builder.add({ contractId: "CONTRACT_A", method: "distribute", args: [] });
    builder.add({ contractId: "CONTRACT_B", method: "distribute", args: [] });
    builder.add({ contractId: "CONTRACT_C", method: "distribute", args: [] });

    const results = await builder.build();

    expect(getAccount).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  test("assigns consecutive, non-colliding sequence numbers across the batch", async () => {
    const getAccount = jest.fn(async () => ({
      accountId: () => "GCALLER",
      sequenceNumber: () => "100",
    }));
    const prepareTransaction = jest.fn(async (tx) => ({
      toXDR: () => `XDR(${tx.account.sequenceNumber()})`,
    }));
    mockStellarSdk({ getAccount, prepareTransaction });
    global.fetch = jest.fn(async () => ({ ok: false, status: 500 }));

    const stellar = await import("../src/stellar.js");
    stellar._resetFeeCache();
    stellar._resetAccountBuildLocks();

    const builder = new stellar.BatchTransactionBuilder("GCALLER");
    builder.add({ contractId: "CONTRACT_A", method: "distribute", args: [] });
    builder.add({ contractId: "CONTRACT_B", method: "distribute", args: [] });
    builder.add({ contractId: "CONTRACT_C", method: "distribute", args: [] });

    const results = await builder.build();
    const xdrs = results.map((r) => r.xdr);

    // No two operations reuse the same sequence number.
    expect(new Set(xdrs).size).toBe(xdrs.length);
    expect(xdrs).toEqual(["XDR(100)", "XDR(101)", "XDR(102)"]);
  });

  test("returns a partial-failure result set when one operation fails to build", async () => {
    const getAccount = jest.fn(async () => ({
      accountId: () => "GCALLER",
      sequenceNumber: () => "100",
    }));
    let call = 0;
    const prepareTransaction = jest.fn(async (tx) => {
      call += 1;
      if (call === 2) {
        throw new Error("simulation failed for CONTRACT_B");
      }
      return { toXDR: () => `XDR(${tx.account.sequenceNumber()})` };
    });
    mockStellarSdk({ getAccount, prepareTransaction });
    global.fetch = jest.fn(async () => ({ ok: false, status: 500 }));

    const stellar = await import("../src/stellar.js");
    stellar._resetFeeCache();
    stellar._resetAccountBuildLocks();

    const builder = new stellar.BatchTransactionBuilder("GCALLER");
    builder.add({ contractId: "CONTRACT_A", method: "distribute", args: [] });
    builder.add({ contractId: "CONTRACT_B", method: "distribute", args: [] });
    builder.add({ contractId: "CONTRACT_C", method: "distribute", args: [] });

    const results = await builder.build();

    expect(results).toHaveLength(3);
    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(false);
    expect(results[2].ok).toBe(true);
    // The failure on operation 2 doesn't block operations 1 and 3 (error recovery).
    expect(results[0].xdr).toBe("XDR(100)");
    expect(results[2].xdr).toBe("XDR(102)");
  });

  test("returns an empty array without any RPC calls when no operations were added", async () => {
    const getAccount = jest.fn();
    const prepareTransaction = jest.fn();
    mockStellarSdk({ getAccount, prepareTransaction });
    global.fetch = jest.fn(async () => ({ ok: false, status: 500 }));

    const stellar = await import("../src/stellar.js");
    stellar._resetFeeCache();
    stellar._resetAccountBuildLocks();

    const builder = new stellar.BatchTransactionBuilder("GCALLER");
    const results = await builder.build();

    expect(results).toEqual([]);
    expect(getAccount).not.toHaveBeenCalled();
  });

  test("serializes with a concurrent single buildTx call for the same address (#294)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const getAccount = jest.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      return { accountId: () => "GCALLER", sequenceNumber: () => "100" };
    });
    const prepareTransaction = jest.fn(async (tx) => ({
      toXDR: () => `XDR(${tx.account.sequenceNumber()})`,
    }));
    mockStellarSdk({ getAccount, prepareTransaction });
    global.fetch = jest.fn(async () => ({ ok: false, status: 500 }));

    const stellar = await import("../src/stellar.js");
    stellar._resetFeeCache();
    stellar._resetAccountBuildLocks();

    const builder = new stellar.BatchTransactionBuilder("GCALLER");
    builder.add({ contractId: "CONTRACT_A", method: "distribute", args: [] });
    builder.add({ contractId: "CONTRACT_B", method: "distribute", args: [] });

    await Promise.all([
      builder.build(),
      stellar.buildTx("GCALLER", "CONTRACT_C", "distribute", []),
    ]);

    // The batch build and the concurrent single buildTx never overlap their
    // getAccount calls — same per-address lock as plain buildTx (#294).
    expect(maxInFlight).toBe(1);
  });
});
