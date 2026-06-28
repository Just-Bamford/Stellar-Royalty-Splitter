import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import request from "supertest";

const checkHorizonConnectivity = jest.fn();
const checkContractDeploymentStatus = jest.fn();
const getConfiguredContractId = jest.fn();
const getNetworkLabel = jest.fn(() => "Testnet");
const checkAllHorizonEndpoints = jest.fn(() => []);
const checkAllRpcEndpoints = jest.fn(() => []);
const getCurrentHorizonUrl = jest.fn(() => "https://horizon-testnet.stellar.org");
const getCurrentRpcUrl = jest.fn(() => "https://soroban-testnet.stellar.org");
const getContractAdmin = jest.fn(() => "GADMIN");

await jest.unstable_mockModule("../src/stellar.js", () => ({
  checkHorizonConnectivity,
  checkContractDeploymentStatus,
  getConfiguredContractId,
  getNetworkLabel,
  checkAllHorizonEndpoints,
  checkAllRpcEndpoints,
  getCurrentHorizonUrl,
  getCurrentRpcUrl,
  getContractAdmin,
  server: {},
  networkPassphrase: "Test SDF Network ; September 2015",
}));

await jest.unstable_mockModule("../src/database/index.js", () => ({
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 2),
}));

await jest.unstable_mockModule("../src/cache.js", () => ({
  getCacheManager: jest.fn(() => ({
    verifyAdminConsistency: jest.fn(async (fetchLiveAdmin) => ({
      consistent: true,
      cachedAdmin: "GADMIN",
      liveAdmin: await fetchLiveAdmin(),
      elapsedMs: 1,
    })),
    invalidateAdmin: jest.fn(),
  })),
}));

const { clearHealthCache } = await import("../src/routes/health.js");

const express = (await import("express")).default;
const { healthRouter } = await import("../src/routes/health.js");

const app = express();
app.use("/api/v1/health", healthRouter);

describe("GET /api/v1/health", () => {
  beforeEach(() => {
    clearHealthCache();
    getConfiguredContractId.mockReturnValue("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    checkHorizonConnectivity.mockResolvedValue({
      connected: true,
      url: "https://horizon-testnet.stellar.org",
    });
    checkContractDeploymentStatus.mockResolvedValue({
      configured: true,
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      deployed: true,
      initialized: true,
      status: "initialized",
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test("returns network, horizon, contract, and db version", async () => {
    const res = await request(app).get("/api/v1/health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      dbVersion: 2,
      network: "Testnet",
      horizon: { connected: true, url: expect.any(String) },
      contract: {
        configured: true,
        deployed: true,
        initialized: true,
        status: "initialized",
      },
    });
  });

  test("ok is false when Horizon is unreachable", async () => {
    checkHorizonConnectivity.mockResolvedValue({
      connected: false,
      url: "https://horizon-testnet.stellar.org",
    });

    const res = await request(app).get("/api/v1/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.horizon.connected).toBe(false);
  });

  test("reports not_configured when no contract ID is set", async () => {
    getConfiguredContractId.mockReturnValue(null);
    checkContractDeploymentStatus.mockResolvedValue({
      configured: false,
      contractId: null,
      deployed: false,
      initialized: false,
      status: "not_configured",
    });

    const res = await request(app).get("/api/v1/health");
    expect(res.body.contract.status).toBe("not_configured");
    expect(res.body.ok).toBe(true);
  });

  test("caches responses within TTL", async () => {
    await request(app).get("/api/v1/health");
    await request(app).get("/api/v1/health");

    expect(checkHorizonConnectivity).toHaveBeenCalledTimes(1);
    expect(checkContractDeploymentStatus).toHaveBeenCalledTimes(1);
  });
});
