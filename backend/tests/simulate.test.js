import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";

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
}));

await jest.unstable_mockModule("../src/stellar.js", () => ({
  addressToScVal: jest.fn((address) => address),
  bytesN32HexToScVal: jest.fn((h) => h),
  isContractInitialized: jest.fn(),
  networkPassphrase: "Test SDF Network ; September 2015",
  retryBuildTx: jest.fn(),
  bytesN32HexToScVal: jest.fn((h) => h),
  getNetworkLabel: jest.fn(() => "Testnet"),
  server: {
    simulateTransaction,
  },
  u32ToScVal: jest.fn((n) => n),
  vecToScVal: jest.fn((v) => v),
  bytesN32HexToScVal: jest.fn((h) => h),
  getNetworkLabel: jest.fn(() => "Testnet"),
}));

await jest.unstable_mockModule("../src/database/index.js", () => ({
  addAuditLog: jest.fn(),
  getMigrationVersion: jest.fn(() => 1),
  initializeDatabase: jest.fn(),
  lookupCollaborators: jest.fn(() => []),
  recordTransaction: jest.fn(() => "tx-456"),
  recordNonceIfNew: jest.fn(() => true),
}));

const { default: app } = await import("./app.js");

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TOKEN = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

const validBody = { contractId: CONTRACT, walletAddress: WALLET, tokenId: TOKEN };

describe("POST /api/v1/simulate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
          data: ["GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC", 400n],
        },
      ],
    });

    const res = await request(app).post("/api/v1/simulate").send(validBody);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      fee: 34567,
      recipientAmounts: [
        { address: WALLET, amount: "600" },
        {
          address: "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
          amount: "400",
        },
      ],
      contractError: null,
    });
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
    expect(res.body).toEqual({
      fee: 100,
      recipientAmounts: [],
      contractError: "HostError: Error(Contract, #1)",
    });
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
