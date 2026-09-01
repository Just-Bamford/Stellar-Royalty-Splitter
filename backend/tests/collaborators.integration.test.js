// Integration tests for GET /api/v1/collaborators/:contractId route, focusing on caching behavior
import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const COLLAB1 = "GA7E6YDRQKJ2JNOG27UPSCQ3FQ6U4X3QQGJKHNGF23T7QCI2FM6E3W2P";
const COLLAB2 = "GBOW474QUGZMHVHF6YDRQKJ2JNOG27UPUCY4FU7E6UDBOKBZJJNWYPSI";

// Mock Stellar SDK and related modules
const mockSimulate = jest.fn();
const mockIsSimError = jest.fn(() => false);

await jest.unstable_mockModule("@stellar/stellar-sdk", () => ({
  default: {
    Address: { fromScVal: jest.fn((scv) => ({ toString: () => scv })) },
    Contract: jest.fn().mockImplementation(() => ({
      call: jest.fn((method) => ({ method })),
    })),
    SorobanRpc: {
      Server: jest.fn().mockImplementation(() => ({ simulateTransaction: mockSimulate })),
      Api: { isSimulationError: mockIsSimError },
    },
    TransactionBuilder: jest.fn().mockImplementation(() => ({
      addOperation: jest.fn().mockReturnThis(),
      setTimeout: jest.fn().mockReturnThis(),
      build: jest.fn().mockReturnValue({}),
    })),
    BASE_FEE: "100",
    Account: jest.fn(),
  },
  Address: { fromScVal: jest.fn((scv) => ({ toString: () => scv })) },
  Contract: jest.fn().mockImplementation(() => ({
    call: jest.fn((method) => ({ method })),
  })),
  SorobanRpc: {
    Server: jest.fn().mockImplementation(() => ({ simulateTransaction: mockSimulate })),
    Api: { isSimulationError: mockIsSimError },
  },
  TransactionBuilder: jest.fn().mockImplementation(() => ({
    addOperation: jest.fn().mockReturnThis(),
    setTimeout: jest.fn().mockReturnThis(),
    build: jest.fn().mockReturnValue({}),
  })),
  BASE_FEE: "100",
  Account: jest.fn(),
}));

await jest.unstable_mockModule("../src/stellar.js", () => ({
  server: { simulateTransaction: mockSimulate },
  networkPassphrase: "Test SDF Network ; September 2015",
  addressToScVal: jest.fn((a) => a),
  retryBuildTx: jest.fn(),
  isContractInitialized: jest.fn(),
  u32ToScVal: jest.fn((n) => n),
  vecToScVal: jest.fn((v) => v),
}));

await jest.unstable_mockModule("../src/database/index.js", () => ({
  recordTransaction: jest.fn(() => "tx-789"),
  addAuditLog: jest.fn(),
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 1),
}));

const { default: app } = await import("./app.js");
const { clearCache } = await import("../src/cache.js");

describe("GET /api/v1/collaborators/:contractId – integration (caching)", () => {
  beforeEach(() => {
    clearCache();
    mockSimulate.mockReset();
    mockIsSimError.mockReset();
    mockIsSimError.mockReturnValue(false);
  });

  test("first request fetches from RPC and caches result", async () => {
    const makeEntry = (address, share) => ({
      key: () => address,
      val: () => ({ u32: () => share }),
    });
    mockSimulate.mockResolvedValueOnce({
      result: { retval: { map: () => ({ entries: [makeEntry(COLLAB1, 5000), makeEntry(COLLAB2, 5000)] }) } },
    });

    const res = await request(app).get(`/api/v1/collaborators/${CONTRACT}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { address: COLLAB1, basisPoints: 5000 },
      { address: COLLAB2, basisPoints: 5000 },
    ]);
    expect(mockSimulate).toHaveBeenCalledTimes(1);
  });

  test("second request hits cache and does not call RPC", async () => {
    // Prime the cache with first request
    const makeEntry = (address, share) => ({
      key: () => address,
      val: () => ({ u32: () => share }),
    });
    mockSimulate.mockResolvedValueOnce({
      result: { retval: { map: () => ({ entries: [makeEntry(COLLAB1, 5000), makeEntry(COLLAB2, 5000)] }) } },
    });
    await request(app).get(`/api/v1/collaborators/${CONTRACT}`);
    expect(mockSimulate).toHaveBeenCalledTimes(1);

    // Second request should use cache
    mockSimulate.mockReset(); // ensure no new calls are made
    const res2 = await request(app).get(`/api/v1/collaborators/${CONTRACT}`);
    expect(res2.status).toBe(200);
    expect(res2.body).toEqual([
      { address: COLLAB1, basisPoints: 5000 },
      { address: COLLAB2, basisPoints: 5000 },
    ]);
    expect(mockSimulate).not.toHaveBeenCalled();
  });
});
