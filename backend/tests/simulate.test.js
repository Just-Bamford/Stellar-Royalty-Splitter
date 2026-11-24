import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import {
  buildDistributePayload,
  VALID_CONTRACT_ID as CONTRACT,
  VALID_TOKEN_ID as TOKEN,
  VALID_WALLET_A as WALLET,
  VALID_WALLET_C as RECIPIENT,
} from "./test-helpers.js";

const simulateTransaction = jest.fn();
const contractCall = jest.fn((method, ...args) => ({ method, args }));
const addOperation = jest.fn(function addOperationMock(operation) {
  this.operation = operation;
  return this;
});
const setTimeoutMock = jest.fn(function setTimeoutBuilderMock(timeout) {
  this.timeout = timeout;
  return this;
});
const build = jest.fn(function buildMock() {
  return {
    account: this.account,
    operation: this.operation,
    timeout: this.timeout,
  };
});
const isSimulationError = jest.fn((sim) => Boolean(sim?.error));

await jest.unstable_mockModule("@stellar/stellar-sdk", () => ({
  default: {
    Account: jest.fn(function Account(accountId, sequence) {
      this.accountId = accountId;
      this.sequence = sequence;
    }),
    BASE_FEE: "100",
    Contract: jest.fn(function Contract(contractId) {
      this.contractId = contractId;
      this.call = contractCall;
    }),
    SorobanRpc: {
      Api: {
        isSimulationError,
      },
    },
    TransactionBuilder: jest.fn(function TransactionBuilder(account, opts) {
      this.account = account;
      this.opts = opts;
      this.addOperation = addOperation;
      this.setTimeout = setTimeoutMock;
      this.build = build;
    }),
    scValToNative: jest.fn((value) => value),
    StrKey: {
      isValidEd25519PublicKey: jest.fn(
        (key) => typeof key === "string" && key.startsWith("G") && key.length === 56
      ),
    },
  },
  Account: jest.fn(function Account(accountId, sequence) {
    this.accountId = accountId;
    this.sequence = sequence;
  }),
  BASE_FEE: "100",
  Contract: jest.fn(function Contract(contractId) {
    this.contractId = contractId;
    this.call = contractCall;
  }),
  SorobanRpc: {
    Api: {
      isSimulationError,
    },
  },
  TransactionBuilder: jest.fn(function TransactionBuilder(account, opts) {
    this.account = account;
    this.opts = opts;
    this.addOperation = addOperation;
    this.setTimeout = setTimeoutMock;
    this.build = build;
  }),
  scValToNative: jest.fn((value) => value),
  StrKey: {
    isValidEd25519PublicKey: jest.fn(
      (key) => typeof key === "string" && key.startsWith("G") && key.length === 56
    ),
  },
}));

await jest.unstable_mockModule("../src/stellar.js", () => ({
  addressToScVal: jest.fn((address) => address),
  isContractInitialized: jest.fn(),
  networkPassphrase: "Test SDF Network ; September 2015",
  retryBuildTx: jest.fn(),
  buildTx: jest.fn(),
  pollHorizonTransaction: jest.fn(),
  server: {
    simulateTransaction,
  },
  u32ToScVal: jest.fn((n) => n),
  vecToScVal: jest.fn((v) => v),
  bytes32ToScVal: jest.fn((v) => v),
  i128ToScVal: jest.fn((v) => v),
  BatchTransactionBuilder: jest.fn(),
}));

await jest.unstable_mockModule("../src/database/index.js", () => ({
  addAuditLog: jest.fn(),
  getMigrationVersion: jest.fn(() => 1),
  initializeDatabase: jest.fn(),
  recordTransaction: jest.fn(() => "tx-456"),
}));

const {
  invokeIfFunction,
  readEventField,
  getEventPayload,
  nativeToString,
  scValToString,
  scValTupleToNative,
} = await import("../src/routes/simulate.js");

const { default: app } = await import("./app.js");
const { resetMetrics } = await import("../src/metrics.js");

const validBody = buildDistributePayload({
  contractId: CONTRACT,
  walletAddress: WALLET,
  tokenId: TOKEN,
});

describe("POST /api/v1/simulate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetMetrics();
  });

  test("returns simulation fee and recipient amounts from dist events", async () => {
    simulateTransaction.mockResolvedValue({
      minResourceFee: "34567",
      events: [
        {
          type: "contract",
          topics: ["dist"],
          data: [WALLET, 600n],
        },
        {
          type: "contract",
          topics: ["dist"],
          data: [RECIPIENT, 400n],
        },
      ],
    });

    const res = await request(app).post("/api/v1/simulate").send(validBody);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      fee: 34567,
      recipientAmounts: [
        { address: WALLET, amount: "600" },
        {
          address: RECIPIENT,
          amount: "400",
        },
      ],
      contractError: null,
    });
    expect(res.body.feeBreakdown).toBeDefined();
    expect(res.body.perRecipientEffectiveFee).toBeDefined();
    expect(simulateTransaction).toHaveBeenCalledTimes(1);
    expect(contractCall).toHaveBeenCalledWith("distribute", TOKEN);
  });

  test("returns contract errors without broadcasting", async () => {
    simulateTransaction.mockResolvedValue({
      error: "HostError: Error(Contract, #1)",
      minResourceFee: "100",
    });

    const res = await request(app).post("/api/v1/simulate").send(validBody);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      fee: 100,
      recipientAmounts: [],
      contractError: "HostError: Error(Contract, #1)",
    });
    expect(res.body.feeBreakdown).toBeDefined();
    expect(res.body.perRecipientEffectiveFee).toBe(0);
    expect(simulateTransaction).toHaveBeenCalledTimes(1);
  });

  test("400 when tokenId is not a valid contract address", async () => {
    const res = await request(app)
      .post("/api/v1/simulate")
      .send({ ...validBody, tokenId: "not-a-contract" });

    expect(res.status).toBe(400);
    expect(simulateTransaction).not.toHaveBeenCalled();
  });
});

describe("simulate helper functions", () => {
  describe("nativeToString", () => {
    test("converts bigint to string", () => {
      expect(nativeToString(1234567890123456789n)).toBe("1234567890123456789");
    });

    test("returns string unchanged", () => {
      expect(nativeToString("already_a_string")).toBe("already_a_string");
    });

    test("converts number to string", () => {
      expect(nativeToString(42)).toBe("42");
    });

    test("returns null for objects that produce [object Object]", () => {
      expect(nativeToString({ key: "val" })).toBeNull();
    });

    test("returns symbol property if present", () => {
      expect(nativeToString({ symbol: "XLM" })).toBe("XLM");
    });

    test("returns custom toString if not [object Object]", () => {
      expect(nativeToString({ toString: () => "custom_output" })).toBe("custom_output");
    });
  });

  describe("scValToString", () => {
    test("returns null for undefined", () => {
      expect(scValToString(undefined)).toBeNull();
    });

    test("returns null for null", () => {
      expect(scValToString(null)).toBeNull();
    });

    test("converts a real/mock ScVal to string", () => {
      expect(scValToString("scval-string")).toBe("scval-string");
      expect(scValToString(100n)).toBe("100");
      expect(scValToString(50)).toBe("50");
      expect(scValToString({ toString: () => "mocked-scval" })).toBe("mocked-scval");
    });
  });

  describe("scValTupleToNative", () => {
    test("returns array input unchanged", () => {
      const arr = ["item1", "item2", 123];
      expect(scValTupleToNative(arr)).toBe(arr);
    });

    test("wraps non-array input into an array", () => {
      expect(scValTupleToNative("single-value")).toEqual(["single-value"]);
      expect(scValTupleToNative(123n)).toEqual([123n]);
    });
  });

  describe("invokeIfFunction", () => {
    test("invokes function and returns its result", () => {
      expect(invokeIfFunction(() => "evaluated")).toBe("evaluated");
    });

    test("returns literal value if not a function", () => {
      expect(invokeIfFunction("literal")).toBe("literal");
    });
  });

  describe("readEventField", () => {
    test("reads field from event and invokes if function", () => {
      expect(readEventField({ data: () => "dynamic" }, "data")).toBe("dynamic");
      expect(readEventField({ topic: "static" }, "topic")).toBe("static");
    });

    test("returns undefined if event or field is missing", () => {
      expect(readEventField(null, "field")).toBeUndefined();
      expect(readEventField({}, "missing")).toBeUndefined();
    });
  });

  describe("getEventPayload", () => {
    test("returns invoked event.event if present", () => {
      expect(getEventPayload({ event: () => "payload" })).toBe("payload");
    });

    test("returns event.value if event.event is missing", () => {
      expect(getEventPayload({ value: "fallback_val" })).toBe("fallback_val");
    });

    test("falls back to event itself if neither event nor value exists", () => {
      expect(getEventPayload("direct_event")).toBe("direct_event");
    });
  });
});
