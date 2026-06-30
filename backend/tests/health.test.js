import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import request from "supertest";

const checkHorizonConnectivity = jest.fn();
const checkContractDeploymentStatus = jest.fn();
const checkAllHorizonEndpoints = jest.fn();
const checkAllRpcEndpoints = jest.fn();
const getCurrentHorizonUrl = jest.fn(() => "https://horizon-testnet.stellar.org");
const getCurrentRpcUrl = jest.fn(() => "https://soroban-testnet.stellar.org");
const getContractAdmin = jest.fn(() => "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
const getConfiguredContractId = jest.fn();
const getNetworkLabel = jest.fn(() => "Testnet");
const verifyAdminConsistency = jest.fn();
const invalidateAdmin = jest.fn();

await jest.unstable_mockModule("../src/stellar.js", () => ({
  checkHorizonConnectivity,
  checkContractDeploymentStatus,
  checkAllHorizonEndpoints,
  checkAllRpcEndpoints,
  getCurrentHorizonUrl,
  getCurrentRpcUrl,
  getContractAdmin,
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

await jest.unstable_mockModule("../src/cache.js", () => ({
  getCacheManager: jest.fn(() => ({
    verifyAdminConsistency,
    invalidateAdmin,
  })),
}));

await jest.unstable_mockModule("../src/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

await jest.unstable_mockModule("../src/database/index.js", () => ({
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 2),
  getQueryProfilerMetrics: jest.fn(() => ({
    enabled: true,
    thresholdMs: 100,
    totalQueries: 3,
    slowQueries: 1,
    averageDurationMs: 42,
    maxDurationMs: 128,
    operations: {
      all: {
        count: 1,
        slowCount: 1,
        averageDurationMs: 128,
        maxDurationMs: 128,
      },
    },
    slowQuerySamples: [
      {
        sql: "SELECT * FROM transactions",
        operation: "all",
        durationMs: 128,
        thresholdMs: 100,
        observedAt: "2026-01-01T00:00:00.000Z",
        recommendations: ["Run EXPLAIN QUERY PLAN for this statement."],
      },
    ],
  })),
}));

await jest.unstable_mockModule("../src/cache.js", () => ({
  getCacheManager: jest.fn(() => ({
    verifyAdminConsistency: jest.fn(async (fetchLiveAdmin) => ({
      consistent: true,
      cachedAdmin: "GADMIN",
      liveAdmin: await fetchLiveAdmin(),
      elapsedMs: 5,
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
    checkAllHorizonEndpoints.mockResolvedValue([
      { url: "https://horizon-testnet.stellar.org", connected: true },
    ]);
    checkAllRpcEndpoints.mockResolvedValue([
      { url: "https://soroban-testnet.stellar.org", connected: true },
    ]);
    verifyAdminConsistency.mockResolvedValue({
      liveAdmin: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      cachedAdmin: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      consistent: true,
      elapsedMs: 5,
    });
    invalidateAdmin.mockResolvedValue(true);
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
      queryProfiler: {
        enabled: true,
        thresholdMs: 100,
        totalQueries: 3,
        slowQueries: 1,
      },
      horizon: { connected: true, url: expect.any(String) },
      rpc: {
        current: "https://soroban-testnet.stellar.org",
        endpoints: [{ url: "https://soroban-testnet.stellar.org", connected: true }],
      },
      horizons: [{ url: "https://horizon-testnet.stellar.org", connected: true }],
      currentHorizon: "https://horizon-testnet.stellar.org",
      admin: {
        consistent: true,
        checkLatencyMs: 5,
      },
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

  test("returns query performance metrics", async () => {
    const res = await request(app).get("/api/v1/health/query-performance");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      enabled: true,
      thresholdMs: 100,
      totalQueries: 3,
      slowQueries: 1,
      operations: {
        all: {
          count: 1,
          slowCount: 1,
        },
      },
    });
    expect(res.body.slowQuerySamples[0]).toMatchObject({
      sql: "SELECT * FROM transactions",
      operation: "all",
      durationMs: 128,
    });
  });
});
