import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import request from "supertest";
import express from "express";

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TOKEN = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const ADMIN = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const COLLAB1 = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const COLLAB2 = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

const simulateTransaction = jest.fn();
const getConfiguredContractId = jest.fn();
const getNetworkLabel = jest.fn(() => "Testnet");

await jest.unstable_mockModule("@stellar/stellar-sdk", () => ({
  default: {
    Address: {
      fromScVal: jest.fn((scVal) => ({ toString: () => scVal })),
    },
    Contract: jest.fn().mockImplementation(() => ({
      call: jest.fn((method, ...args) => ({ method, args })),
    })),
    SorobanRpc: {
      Api: { isSimulationError: jest.fn((sim) => Boolean(sim.error)) },
    },
    TransactionBuilder: jest.fn().mockImplementation(() => {
      let operation;
      return {
        addOperation: jest.fn((op) => {
          operation = op;
          return {
            setTimeout: jest.fn(() => ({
              build: jest.fn(() => ({ operation })),
            })),
          };
        }),
      };
    }),
    BASE_FEE: "100",
    Account: jest.fn(),
  },
  Address: {
    fromScVal: jest.fn((scVal) => ({ toString: () => scVal })),
  },
  Contract: jest.fn().mockImplementation(() => ({
    call: jest.fn((method, ...args) => ({ method, args })),
  })),
  SorobanRpc: {
    Api: { isSimulationError: jest.fn((sim) => Boolean(sim.error)) },
  },
  TransactionBuilder: jest.fn().mockImplementation(() => {
    let operation;
    return {
      addOperation: jest.fn((op) => {
        operation = op;
        return {
          setTimeout: jest.fn(() => ({
            build: jest.fn(() => ({ operation })),
          })),
        };
      }),
    };
  }),
  BASE_FEE: "100",
  Account: jest.fn(),
}));

await jest.unstable_mockModule("../src/stellar.js", () => ({
  server: { simulateTransaction },
  networkPassphrase: "Test SDF Network ; September 2015",
  addressToScVal: jest.fn((address) => address),
  getConfiguredContractId,
  getNetworkLabel,
  isContractInitialized: jest.fn(),
  getContractVersionFromContract: jest.fn(),
}));

const { contractRouter, _resetContractStateCache } = await import("../src/routes/contract.js");

const app = express();
app.use("/api/v1/contract", contractRouter);
app.use((err, _req, res, _next) => {
  res.status(500).json({ error: err.message ?? "Internal server error" });
});

function shareEntry(address, basisPoints) {
  return {
    key: () => address,
    val: () => ({ u32: () => basisPoints }),
  };
}

describe("contract state routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetContractStateCache();
    getConfiguredContractId.mockReturnValue(CONTRACT);
    process.env.ROYALTY_TOKEN_ID = TOKEN;
    simulateTransaction.mockImplementation(({ operation }) => {
      const responses = {
        get_admin: { result: { retval: ADMIN } },
        get_royalty_rate: { result: { retval: { u32: () => 750 } } },
        get_all_shares: {
          result: {
            retval: {
              map: () => ({
                entries: [shareEntry(COLLAB1, 6000), shareEntry(COLLAB2, 4000)],
              }),
            },
          },
        },
        get_balance: {
          result: {
            retval: {
              i128: () => ({ hi: () => 0, lo: () => 12345 }),
            },
          },
        },
      };
      return Promise.resolve(responses[operation.method]);
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("returns configured contract info", async () => {
    const res = await request(app).get("/api/v1/contract/info");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      contractId: CONTRACT,
      adminAddress: ADMIN,
      royaltyRate: 750,
      balance: "12345",
      tokenId: TOKEN,
      network: "Testnet",
      recipients: [
        { address: COLLAB1, basisPoints: 6000 },
        { address: COLLAB2, basisPoints: 4000 },
      ],
    });
  });

  test("returns current contract state with network information", async () => {
    const res = await request(app).get("/api/v1/contract/state");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      contractId: CONTRACT,
      adminAddress: ADMIN,
      royaltyRate: 750,
      balance: "12345",
      tokenId: TOKEN,
      network: "Testnet",
      networkPassphrase: "Test SDF Network ; September 2015",
      recipients: [
        { address: COLLAB1, basisPoints: 6000 },
        { address: COLLAB2, basisPoints: 4000 },
      ],
    });
  });

  test("caches contract state for 30 seconds", async () => {
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(1_000);

    const first = await request(app).get("/api/v1/contract/state");
    expect(first.status).toBe(200);
    expect(simulateTransaction).toHaveBeenCalledTimes(4);
    expect(first.body.cacheStatus).toBe("live");
    expect(first.body.cacheTtlMs).toBe(30_000);
    expect(first.body.fetchedAt).toBe(new Date(1_000).toISOString());

    nowSpy.mockReturnValue(30_999);
    const cached = await request(app).get("/api/v1/contract/state");
    expect(cached.status).toBe(200);
    expect(simulateTransaction).toHaveBeenCalledTimes(4);
    expect(cached.body.cacheStatus).toBe("cached");
    expect(cached.body.fetchedAt).toBe(new Date(1_000).toISOString());

    nowSpy.mockReturnValue(31_001);
    const refreshed = await request(app).get("/api/v1/contract/state");
    expect(refreshed.status).toBe(200);
    expect(simulateTransaction).toHaveBeenCalledTimes(8);
    expect(refreshed.body.cacheStatus).toBe("live");
    expect(refreshed.body.fetchedAt).toBe(new Date(31_001).toISOString());
  });

  test("bypasses cached contract state when cache=false", async () => {
    jest.spyOn(Date, "now").mockReturnValue(2_000);

    const first = await request(app).get("/api/v1/contract/state");
    expect(first.status).toBe(200);
    expect(simulateTransaction).toHaveBeenCalledTimes(4);

    const refreshed = await request(app).get("/api/v1/contract/state?cache=false");
    expect(refreshed.status).toBe(200);
    expect(simulateTransaction).toHaveBeenCalledTimes(8);
    expect(refreshed.body.cacheStatus).toBe("live");
  });

  test("400 when no contract ID is configured or provided", async () => {
    getConfiguredContractId.mockReturnValue(null);

    const res = await request(app).get("/api/v1/contract/info");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/contractId/i);
  });
});
