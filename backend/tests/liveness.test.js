import { jest, describe, test, expect, afterEach } from "@jest/globals";
import request from "supertest";

const checkHorizonConnectivity = jest.fn();
const getNetworkLabel = jest.fn(() => "Testnet");
const getMigrationVersion = jest.fn(() => 14);

await jest.unstable_mockModule("../src/stellar.js", () => ({
  checkHorizonConnectivity,
  getNetworkLabel,
  server: {},
  networkPassphrase: "Test SDF Network ; September 2015",
}));

await jest.unstable_mockModule("../src/database/index.js", () => ({
  getMigrationVersion,
}));

const express = (await import("express")).default;
const { livenessRouter } = await import("../src/routes/liveness.js");

const app = express();
app.use(livenessRouter);

describe("GET /health", () => {
  afterEach(() => jest.clearAllMocks());

  test("responds 200 without touching the database or Horizon", async () => {
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", network: "Testnet" });
    expect(typeof res.body.uptime).toBe("number");
    expect(checkHorizonConnectivity).not.toHaveBeenCalled();
    expect(getMigrationVersion).not.toHaveBeenCalled();
  });

  test("never includes secrets, API keys, or env vars in the payload", async () => {
    const res = await request(app).get("/health");

    const payload = JSON.stringify(res.body).toLowerCase();
    expect(payload).not.toMatch(/key|secret|token|password/);
  });
});

describe("GET /ready", () => {
  afterEach(() => jest.clearAllMocks());

  test("returns 200 and ready when all dependencies are healthy", async () => {
    getMigrationVersion.mockReturnValue(14);
    checkHorizonConnectivity.mockResolvedValue({ connected: true, url: "https://horizon-testnet.stellar.org" });

    const res = await request(app).get("/ready");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ready",
      dependencies: { database: true, horizon: true },
    });
  });

  test("returns 503 when Horizon is unreachable", async () => {
    getMigrationVersion.mockReturnValue(14);
    checkHorizonConnectivity.mockResolvedValue({ connected: false, url: "https://horizon-testnet.stellar.org" });

    const res = await request(app).get("/ready");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("not_ready");
    expect(res.body.dependencies).toEqual({ database: true, horizon: false });
  });

  test("returns 503 when the database check throws", async () => {
    getMigrationVersion.mockImplementation(() => {
      throw new Error("database is locked");
    });
    checkHorizonConnectivity.mockResolvedValue({ connected: true, url: "https://horizon-testnet.stellar.org" });

    const res = await request(app).get("/ready");

    expect(res.status).toBe(503);
    expect(res.body.dependencies.database).toBe(false);
  });

  test("returns 503 when Horizon connectivity check throws", async () => {
    getMigrationVersion.mockReturnValue(14);
    checkHorizonConnectivity.mockRejectedValue(new Error("network error"));

    const res = await request(app).get("/ready");

    expect(res.status).toBe(503);
    expect(res.body.dependencies.horizon).toBe(false);
  });

  test("never includes secrets, API keys, or env vars in the payload", async () => {
    getMigrationVersion.mockReturnValue(14);
    checkHorizonConnectivity.mockResolvedValue({ connected: true, url: "https://horizon-testnet.stellar.org" });

    const res = await request(app).get("/ready");

    const payload = JSON.stringify(res.body).toLowerCase();
    expect(payload).not.toMatch(/key|secret|token|password/);
  });
});
