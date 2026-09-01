import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import express from "express";
import request from "supertest";

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WALLET = "GAPTAQKSMN2ILFVHXDE5V274BUPC6QCRMJZYJFNGW7ENT2X3BQOS4M3C";

const getTransactionHistory = jest.fn();
const getTransactionCount = jest.fn();

await jest.unstable_mockModule("../src/database/index.js", () => ({
  getTransactionHistory,
  getTransactionCount,
  getTransactionDetails: jest.fn(),
  getTransactionById: jest.fn(),
  getAuditLog: jest.fn(),
  addAuditLog: jest.fn(),
  countAuditLog: jest.fn(),
  updateTransactionStatus: jest.fn(),
  updateTransactionHash: jest.fn(),
  archiveContractEvents: jest.fn(),
  getArchivePolicy: jest.fn(),
  getArchivedEventCount: jest.fn(),
  getArchivedEvents: jest.fn(),
  updateArchivePolicy: jest.fn(),
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 1),
}));

await jest.unstable_mockModule("../src/stellar.js", () => ({
  pollHorizonTransaction: jest.fn(),
}));

await jest.unstable_mockModule("../src/webhook-delivery.js", () => ({
  deliverDistributeWebhooks: jest.fn(),
}));

const historyRouter = (await import("../src/routes/history.js")).default;
const { clearCache } = await import("../src/cache.js");

const app = express();
app.use(express.json());
app.use("/api/v1", historyRouter);

function makeRows(n, type = "distribute") {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    txHash: `hash${i + 1}`,
    contractId: CONTRACT,
    type,
    initiatorAddress: WALLET,
    requestedAmount: null,
    tokenId: null,
    timestamp: new Date(Date.now() - i * 1000).toISOString(),
    blockTime: null,
    status: "confirmed",
    errorMessage: null,
    retry_count: 0,
    last_retry_time: null,
    payoutCount: 2,
  }));
}

describe("GET /api/v1/history/:contractId — pagination", () => {
  beforeEach(() => {
    clearCache();
    jest.clearAllMocks();
  });

  test("first page: hasNextPage=true, hasPrevPage=false when more records exist", async () => {
    getTransactionHistory.mockReturnValue(makeRows(10));
    getTransactionCount.mockReturnValue(25);

    const res = await request(app)
      .get(`/api/v1/history/${CONTRACT}?limit=10&offset=0`);

    expect(res.status).toBe(200);
    expect(res.body.pagination.hasNextPage).toBe(true);
    expect(res.body.pagination.hasPrevPage).toBe(false);
    expect(res.body.pagination.total).toBe(25);
  });

  test("middle page: hasNextPage=true, hasPrevPage=true", async () => {
    getTransactionHistory.mockReturnValue(makeRows(10));
    getTransactionCount.mockReturnValue(25);

    const res = await request(app)
      .get(`/api/v1/history/${CONTRACT}?limit=10&offset=10`);

    expect(res.status).toBe(200);
    expect(res.body.pagination.hasNextPage).toBe(true);
    expect(res.body.pagination.hasPrevPage).toBe(true);
  });

  test("final page: hasNextPage=false, hasPrevPage=true", async () => {
    getTransactionHistory.mockReturnValue(makeRows(5));
    getTransactionCount.mockReturnValue(25);

    const res = await request(app)
      .get(`/api/v1/history/${CONTRACT}?limit=10&offset=20`);

    expect(res.status).toBe(200);
    expect(res.body.pagination.hasNextPage).toBe(false);
    expect(res.body.pagination.hasPrevPage).toBe(true);
  });

  test("single page of results: hasNextPage=false, hasPrevPage=false", async () => {
    getTransactionHistory.mockReturnValue(makeRows(3));
    getTransactionCount.mockReturnValue(3);

    const res = await request(app)
      .get(`/api/v1/history/${CONTRACT}?limit=50&offset=0`);

    expect(res.status).toBe(200);
    expect(res.body.pagination.hasNextPage).toBe(false);
    expect(res.body.pagination.hasPrevPage).toBe(false);
  });

  test("empty result set: hasNextPage=false, hasPrevPage=false", async () => {
    getTransactionHistory.mockReturnValue([]);
    getTransactionCount.mockReturnValue(0);

    const res = await request(app)
      .get(`/api/v1/history/${CONTRACT}?limit=50&offset=0`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.pagination.hasNextPage).toBe(false);
    expect(res.body.pagination.hasPrevPage).toBe(false);
  });

  test("returns 400 for non-numeric limit", async () => {
    const res = await request(app)
      .get(`/api/v1/history/${CONTRACT}?limit=abc`);
    expect(res.status).toBe(400);
  });

  test("returns 400 for non-numeric offset", async () => {
    const res = await request(app)
      .get(`/api/v1/history/${CONTRACT}?offset=xyz`);
    expect(res.status).toBe(400);
  });
});

describe("GET /api/v1/history/:contractId — type filter", () => {
  beforeEach(() => {
    clearCache();
    jest.clearAllMocks();
  });

  test("filters by type=distribute and passes filter to DB", async () => {
    getTransactionHistory.mockReturnValue(makeRows(2, "distribute"));
    getTransactionCount.mockReturnValue(2);

    const res = await request(app)
      .get(`/api/v1/history/${CONTRACT}?type=distribute`);

    expect(res.status).toBe(200);
    expect(getTransactionHistory).toHaveBeenCalledWith(
      CONTRACT,
      expect.any(Number),
      expect.any(Number),
      { type: "distribute" }
    );
  });

  test("filters by type=initialize and passes filter to DB", async () => {
    getTransactionHistory.mockReturnValue(makeRows(1, "initialize"));
    getTransactionCount.mockReturnValue(1);

    const res = await request(app)
      .get(`/api/v1/history/${CONTRACT}?type=initialize`);

    expect(res.status).toBe(200);
    expect(getTransactionHistory).toHaveBeenCalledWith(
      CONTRACT,
      expect.any(Number),
      expect.any(Number),
      { type: "initialize" }
    );
  });

  test("returns 400 for invalid type value", async () => {
    const res = await request(app)
      .get(`/api/v1/history/${CONTRACT}?type=unknown`);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/distribute.*initialize|initialize.*distribute/);
  });

  test("omits type filter when not provided", async () => {
    getTransactionHistory.mockReturnValue([]);
    getTransactionCount.mockReturnValue(0);

    const res = await request(app)
      .get(`/api/v1/history/${CONTRACT}`);

    expect(res.status).toBe(200);
    expect(getTransactionHistory).toHaveBeenCalledWith(
      CONTRACT,
      expect.any(Number),
      expect.any(Number),
      {}
    );
  });
});
