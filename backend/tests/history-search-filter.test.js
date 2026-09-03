/**
 * Tests for history search and filter behaviour (#675).
 * Covers recipient-address search, date-range filtering, combined filters,
 * empty-state responses, and filter reset (no-filter) behaviour.
 */

import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import express from "express";
import request from "supertest";

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WALLET_A = "GAPTAQKSMN2ILFVHXDE5V274BUPC6QCRMJZYJFNGW7ENT2X3BQOS4M3C";
const WALLET_B = "GA7E6YDRQKJ2JNOG27UPSCQ3FQ6U4X3QQGJKHNGF23T7QCI2FM6E3W2P";

const getTransactionHistory = jest.fn();
const getTransactionCount = jest.fn();

await jest.unstable_mockModule("../src/database/index.js", () => ({
  getTransactionHistory,
  getTransactionCount,
  getTransactionHistoryCursor: jest.fn(),
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

await jest.unstable_mockModule("../src/cache.js", () => ({
  cacheSet: jest.fn(),
  cacheGet: jest.fn(),
  cacheKey: jest.fn(),
  TTL: { history: 60000 },
}));

const historyRouter = (await import("../src/routes/history.js")).default;

const app = express();
app.use(express.json());
app.use("/api/v1", historyRouter);

function makeRows(n, overrides = {}) {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    txHash: `hash${i + 1}`,
    contractId: CONTRACT,
    type: "distribute",
    initiatorAddress: WALLET_A,
    requestedAmount: null,
    tokenId: null,
    timestamp: new Date(Date.now() - i * 86400000).toISOString(),
    blockTime: null,
    status: "confirmed",
    errorMessage: null,
    retry_count: 0,
    last_retry_time: null,
    payoutCount: 2,
    ...overrides,
  }));
}

describe("GET /api/v1/history/:contractId — recipient address search (#675)", () => {
  beforeEach(() => jest.clearAllMocks());

  test("passes recipient filter to DB when provided", async () => {
    getTransactionHistory.mockReturnValue(makeRows(2));
    getTransactionCount.mockReturnValue(2);

    const res = await request(app).get(`/api/v1/history/${CONTRACT}?recipient=${WALLET_B}`);

    expect(res.status).toBe(200);
    expect(getTransactionHistory).toHaveBeenCalledWith(
      CONTRACT,
      expect.any(Number),
      expect.any(Number),
      expect.objectContaining({ recipient: WALLET_B })
    );
  });

  test("returns empty data array when no records match recipient", async () => {
    getTransactionHistory.mockReturnValue([]);
    getTransactionCount.mockReturnValue(0);

    const res = await request(app).get(`/api/v1/history/${CONTRACT}?recipient=GNOBODY`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.pagination.total).toBe(0);
  });

  test("omits recipient filter when not provided", async () => {
    getTransactionHistory.mockReturnValue([]);
    getTransactionCount.mockReturnValue(0);

    await request(app).get(`/api/v1/history/${CONTRACT}`);

    const call = getTransactionHistory.mock.calls[0];
    expect(call[3]).not.toHaveProperty("recipient");
  });
});

describe("GET /api/v1/history/:contractId — date range filtering (#675)", () => {
  beforeEach(() => jest.clearAllMocks());

  test("passes startDate filter to DB when provided", async () => {
    getTransactionHistory.mockReturnValue(makeRows(3));
    getTransactionCount.mockReturnValue(3);

    const res = await request(app).get(`/api/v1/history/${CONTRACT}?startDate=2024-01-01`);

    expect(res.status).toBe(200);
    expect(getTransactionHistory).toHaveBeenCalledWith(
      CONTRACT,
      expect.any(Number),
      expect.any(Number),
      expect.objectContaining({ startDate: "2024-01-01" })
    );
  });

  test("passes endDate filter to DB when provided", async () => {
    getTransactionHistory.mockReturnValue(makeRows(1));
    getTransactionCount.mockReturnValue(1);

    const res = await request(app).get(`/api/v1/history/${CONTRACT}?endDate=2024-12-31`);

    expect(res.status).toBe(200);
    expect(getTransactionHistory).toHaveBeenCalledWith(
      CONTRACT,
      expect.any(Number),
      expect.any(Number),
      expect.objectContaining({ endDate: "2024-12-31" })
    );
  });

  test("passes both startDate and endDate to DB", async () => {
    getTransactionHistory.mockReturnValue(makeRows(2));
    getTransactionCount.mockReturnValue(2);

    const res = await request(app).get(
      `/api/v1/history/${CONTRACT}?startDate=2024-01-01&endDate=2024-06-30`
    );

    expect(res.status).toBe(200);
    expect(getTransactionHistory).toHaveBeenCalledWith(
      CONTRACT,
      expect.any(Number),
      expect.any(Number),
      expect.objectContaining({ startDate: "2024-01-01", endDate: "2024-06-30" })
    );
  });

  test("returns 400 for an invalid startDate", async () => {
    const res = await request(app).get(`/api/v1/history/${CONTRACT}?startDate=not-a-date`);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/startDate/i);
  });

  test("returns 400 for an invalid endDate", async () => {
    const res = await request(app).get(`/api/v1/history/${CONTRACT}?endDate=bad-date`);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/endDate/i);
  });
});

describe("GET /api/v1/history/:contractId — combined filters (#675)", () => {
  beforeEach(() => jest.clearAllMocks());

  test("passes type + recipient + date range together to DB", async () => {
    getTransactionHistory.mockReturnValue(makeRows(1));
    getTransactionCount.mockReturnValue(1);

    const res = await request(app).get(
      `/api/v1/history/${CONTRACT}?type=distribute&recipient=${WALLET_A}&startDate=2024-01-01&endDate=2024-12-31`
    );

    expect(res.status).toBe(200);
    expect(getTransactionHistory).toHaveBeenCalledWith(
      CONTRACT,
      expect.any(Number),
      expect.any(Number),
      {
        type: "distribute",
        recipient: WALLET_A,
        startDate: "2024-01-01",
        endDate: "2024-12-31",
      }
    );
  });

  test("returns empty data when no records match combined filters", async () => {
    getTransactionHistory.mockReturnValue([]);
    getTransactionCount.mockReturnValue(0);

    const res = await request(app).get(
      `/api/v1/history/${CONTRACT}?type=initialize&recipient=${WALLET_B}`
    );

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.pagination.total).toBe(0);
    expect(res.body.pagination.hasNextPage).toBe(false);
    expect(res.body.pagination.hasPrevPage).toBe(false);
  });
});

describe("GET /api/v1/history/:contractId — filter reset / no filters (#675)", () => {
  beforeEach(() => jest.clearAllMocks());

  test("passes empty filter object when no query params given", async () => {
    getTransactionHistory.mockReturnValue(makeRows(5));
    getTransactionCount.mockReturnValue(5);

    const res = await request(app).get(`/api/v1/history/${CONTRACT}`);

    expect(res.status).toBe(200);
    expect(getTransactionHistory).toHaveBeenCalledWith(
      CONTRACT,
      expect.any(Number),
      expect.any(Number),
      {}
    );
  });

  test("pagination meta is correct after applying filters that reduce results", async () => {
    getTransactionHistory.mockReturnValue(makeRows(2));
    getTransactionCount.mockReturnValue(2);

    const res = await request(app).get(
      `/api/v1/history/${CONTRACT}?recipient=${WALLET_B}&limit=10&offset=0`
    );

    expect(res.status).toBe(200);
    expect(res.body.pagination.total).toBe(2);
    expect(res.body.pagination.hasNextPage).toBe(false);
    expect(res.body.pagination.hasPrevPage).toBe(false);
  });
});
