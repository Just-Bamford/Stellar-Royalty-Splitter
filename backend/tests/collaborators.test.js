import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const COLLAB1  = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const COLLAB2  = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

const mockSimulate = jest.fn();
const mockIsSimError = jest.fn(() => false);
const mockLookupCollaborators = jest.fn(() => []);

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
  getNetworkLabel: jest.fn(() => "Testnet"),
  u32ToScVal: jest.fn((n) => n),
  vecToScVal: jest.fn((v) => v),
  bytesN32HexToScVal: jest.fn((h) => h),
  getNetworkLabel: jest.fn(() => "Testnet"),
}));

await jest.unstable_mockModule("../src/database/index.js", () => ({
  recordTransaction: jest.fn(() => "tx-789"),
  addAuditLog: jest.fn(),
  lookupCollaborators: mockLookupCollaborators,
  recordNonceIfNew: jest.fn(() => true),
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 1),
}));

const { default: app } = await import("./app.js");
const { invalidateCollaboratorsCache } = await import("../src/routes/collaborators.js");
const { SorobanRpc } = await import("@stellar/stellar-sdk");
const { _resetCollaboratorsCache } = await import("../src/collaborators-cache.js");

describe("GET /api/v1/collaborators/:contractId", () => {
  beforeEach(() => {
    _resetCollaboratorsCache();
    mockSimulate.mockReset();
    mockIsSimError.mockReset();
    mockIsSimError.mockReturnValue(false);
    invalidateCollaboratorsCache(CONTRACT);
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

describe("GET /api/v1/collaborators/lookup", () => {
  beforeEach(() => {
    mockSimulate.mockReset();
    mockLookupCollaborators.mockReset();
    mockLookupCollaborators.mockReturnValue([]);
  });

  test("returns empty suggestions when there is no collaborator history", async () => {
    const res = await request(app).get("/api/v1/collaborators/lookup");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ suggestions: [] });
  });

  test("returns history suggestions from the lookup store", async () => {
    mockLookupCollaborators.mockReturnValueOnce([
      {
        address: COLLAB1,
        label: "GBBBBBBB…BBBBBB",
        contractId: CONTRACT,
        lastSeen: "2026-01-01T00:00:00.000Z",
        sources: ["initialize_history"],
      },
    ]);

    const res = await request(app).get("/api/v1/collaborators/lookup");

    expect(res.status).toBe(200);
    expect(res.body.suggestions).toHaveLength(1);
    expect(res.body.suggestions[0].address).toBe(COLLAB1);
  });

  test("forwards query text and limit to support debounced autocomplete", async () => {
    await request(app).get("/api/v1/collaborators/lookup?q=GBBBB&limit=5");

    expect(mockLookupCollaborators).toHaveBeenCalledWith("GBBBB", "5");
  });

  test("does not run Soroban simulation for autocomplete lookup", async () => {
    await request(app).get("/api/v1/collaborators/lookup?q=G");

    expect(mockSimulate).not.toHaveBeenCalled();
  });
});
