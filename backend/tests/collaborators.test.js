import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const COLLAB1  = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const COLLAB2  = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

const mockSimulate = jest.fn();
const mockIsSimError = jest.fn(() => false);

await jest.unstable_mockModule("@stellar/stellar-sdk", () => ({
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

await jest.unstable_mockModule("../src/database.js", () => ({
  recordTransaction: jest.fn(() => "tx-789"),
  addAuditLog: jest.fn(),
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 1),
}));

const { default: app } = await import("./app.js");
const { SorobanRpc } = await import("@stellar/stellar-sdk");

describe("GET /api/v1/collaborators/:contractId", () => {
  beforeEach(() => {
    mockSimulate.mockReset();
    mockIsSimError.mockReset();
    mockIsSimError.mockReturnValue(false);
  });

  test("happy path — returns collaborators with basisPoints", async () => {
    mockSimulate
      .mockResolvedValueOnce({ result: { retval: { vec: () => [COLLAB1, COLLAB2] } } })
      .mockResolvedValueOnce({ result: { retval: { bool: () => true } } })
      .mockResolvedValueOnce({ result: { retval: { u32: () => 5000 } } })
      .mockResolvedValueOnce({ result: { retval: { bool: () => true } } })
      .mockResolvedValueOnce({ result: { retval: { u32: () => 5000 } } });

    const res = await request(app).get(`/api/v1/collaborators/${CONTRACT}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(2);
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
