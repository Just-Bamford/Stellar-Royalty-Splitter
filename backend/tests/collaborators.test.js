import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const COLLAB1 = "GA7E6YDRQKJ2JNOG27UPSCQ3FQ6U4X3QQGJKHNGF23T7QCI2FM6E3W2P";
const COLLAB2 = "GBOW474QUGZMHVHF6YDRQKJ2JNOG27UPUCY4FU7E6UDBOKBZJJNWYPSI";

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
  pollHorizonTransaction: jest.fn(),
  isContractInitialized: jest.fn(),
  u32ToScVal: jest.fn((n) => n),
  vecToScVal: jest.fn((v) => v),
  buildTx: jest.fn(),
  bytes32ToScVal: jest.fn((v) => v),
  i128ToScVal: jest.fn((v) => v),
  BatchTransactionBuilder: jest.fn(),
}));

await jest.unstable_mockModule("../src/database/index.js", () => ({
  recordTransaction: jest.fn(() => "tx-789"),
  addAuditLog: jest.fn(),
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 1),
}));

const { default: initialApp } = await import("./app.js");
const { SorobanRpc } = await import("@stellar/stellar-sdk");
const { clearCache } = await import("../src/cache.js");

describe("GET /api/v1/collaborators/:contractId", () => {
  let app;

  beforeEach(async () => {
    // Clear the in-memory cache so each test starts cold (#683)
    clearCache();
    mockSimulate.mockReset();
    mockIsSimError.mockReset();
    mockIsSimError.mockReturnValue(false);
    // Reload the app module to clear the route's internal caches
    jest.resetModules();
    const appModule = await import("./app.js");
    app = appModule.default;
  });

  test("happy path — returns collaborators with basisPoints", async () => {
    const makeEntry = (address, share) => ({
      key: () => address,
      val: () => ({ u32: () => share }),
    });

    mockSimulate.mockResolvedValueOnce({
      result: {
        retval: {
          map: () => ({
            entries: [makeEntry(COLLAB1, 5000), makeEntry(COLLAB2, 5000)],
          }),
        },
      },
    });

    const res = await request(app).get(`/api/v1/collaborators/${CONTRACT}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(2);
    expect(res.body[0]).toMatchObject({ address: COLLAB1, basisPoints: 5000 });
    expect(res.body[1]).toMatchObject({ address: COLLAB2, basisPoints: 5000 });
  });

  test("returns empty array when contract has no collaborators", async () => {
    mockSimulate.mockResolvedValueOnce({ result: { retval: null } });

    const res = await request(app).get(`/api/v1/collaborators/${CONTRACT}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test("400 when RPC simulation returns an error for get_collaborators", async () => {
    mockIsSimError.mockReturnValue(true);
    mockSimulate.mockResolvedValueOnce({ error: "contract not found" });

    const res = await request(app).get(`/api/v1/collaborators/${CONTRACT}`);

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  test("500 when RPC throws unexpectedly", async () => {
    mockSimulate.mockRejectedValueOnce(new Error("network failure"));

    const res = await request(app).get(`/api/v1/collaborators/${CONTRACT}`);

    expect(res.status).toBe(500);
  });
});
