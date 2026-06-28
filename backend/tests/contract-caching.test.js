/**
 * RPC response caching tests (#422).
 *
 * Mounts collaboratorsRouter / contractRouter directly (not via tests/app.js,
 * which also pulls in initializeRouter and its unrelated, pre-existing mock
 * requirements) so this suite is isolated to the caching behavior itself.
 */
import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import express from "express";
import request from "supertest";

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
  getNetworkLabel: jest.fn(() => "Testnet"),
  addressToScVal: jest.fn((a) => a),
  isContractInitialized: jest.fn(),
  getConfiguredContractId: jest.fn(() => null),
  getContractVersionFromContract: jest.fn(),
}));

const {
  collaboratorsRouter,
  _resetCollaboratorsCache,
  invalidateCollaboratorsCache,
} = await import("../src/routes/collaborators.js");
const { resetMetrics, getMetricsSnapshot } = await import("../src/metrics.js");

const app = express();
app.use("/api/v1/collaborators", collaboratorsRouter);

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const COLLAB1 = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function mockShareMapResult() {
  return {
    result: {
      retval: {
        map: () => ({
          entries: [
            {
              key: () => COLLAB1,
              val: () => ({ u32: () => 10000 }),
            },
          ],
        }),
      },
    },
  };
}

describe("Collaborators cache (#422)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsSimError.mockReturnValue(false);
    mockSimulate.mockResolvedValue(mockShareMapResult());
    _resetCollaboratorsCache();
    resetMetrics();
  });

  test("second request within TTL is served from cache — simulateTransaction called once", async () => {
    const first = await request(app).get(`/api/v1/collaborators/${CONTRACT}`);
    const second = await request(app).get(`/api/v1/collaborators/${CONTRACT}`);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(mockSimulate).toHaveBeenCalledTimes(1);
  });

  test("records a cache miss then a cache hit in metrics", async () => {
    await request(app).get(`/api/v1/collaborators/${CONTRACT}`);
    await request(app).get(`/api/v1/collaborators/${CONTRACT}`);

    const snapshot = getMetricsSnapshot();
    expect(snapshot.cacheStats.collaborators).toEqual({ hits: 1, misses: 1 });
  });

  test("invalidateCollaboratorsCache busts the cache and triggers a fresh simulation", async () => {
    await request(app).get(`/api/v1/collaborators/${CONTRACT}`);
    invalidateCollaboratorsCache(CONTRACT);
    await request(app).get(`/api/v1/collaborators/${CONTRACT}`);

    expect(mockSimulate).toHaveBeenCalledTimes(2);
  });
});
