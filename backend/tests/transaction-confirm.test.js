import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";

const pollHorizonTransaction = jest.fn();

await jest.unstable_mockModule("../src/stellar.js", () => ({
  pollHorizonTransaction,
  server: {},
  networkPassphrase: "Test SDF Network ; September 2015",
}));

const getTransactionDetails = jest.fn();
const getTransactionById = jest.fn();
const updateTransactionHash = jest.fn();
const updateTransactionStatus = jest.fn();

await jest.unstable_mockModule("../src/database/index.js", () => ({
  getTransactionHistory: jest.fn(),
  getTransactionCount: jest.fn(),
  getTransactionDetails,
  getTransactionById,
  getAuditLog: jest.fn(),
  addAuditLog: jest.fn(),
  updateTransactionStatus,
  updateTransactionHash,
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 3),
}));

const deliverDistributeWebhooks = jest.fn();

await jest.unstable_mockModule("../src/webhook-delivery.js", () => ({
  deliverDistributeWebhooks,
}));

const { default: historyRouter } = await import("../src/routes/history.js");

import express from "express";

const app = express();
app.use(express.json());
app.use("/api/v1", historyRouter);

const TX_HASH = "a".repeat(64);

describe("POST /api/v1/transaction/confirm/:txHash", () => {
  beforeEach(() => jest.clearAllMocks());

  test("confirms an existing pending transaction after Horizon polling", async () => {
    getTransactionDetails
      .mockReturnValueOnce({
        id: 1,
        txHash: TX_HASH,
        contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        type: "distribute",
        status: "pending",
        payouts: [],
      })
      .mockReturnValueOnce({
        id: 1,
        txHash: TX_HASH,
        contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        type: "distribute",
        status: "confirmed",
        payouts: [],
      });

    pollHorizonTransaction.mockResolvedValue({
      status: "confirmed",
      ledger: 12345,
      createdAt: "2026-05-31T12:00:00.000Z",
    });

    const res = await request(app)
      .post(`/api/v1/transaction/confirm/${TX_HASH}`)
      .send({ blockTime: "2026-05-31T12:00:00.000Z" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      status: "confirmed",
      ledger: 12345,
    });
    expect(updateTransactionStatus).toHaveBeenCalledWith(
      TX_HASH,
      "confirmed",
      "2026-05-31T12:00:00.000Z",
      null,
    );
    expect(deliverDistributeWebhooks).toHaveBeenCalled();
  });

  test("links transactionId to txHash when row has no hash yet", async () => {
    getTransactionDetails
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({
        id: 7,
        txHash: TX_HASH,
        contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        type: "distribute",
        status: "pending",
        payouts: [],
      })
      .mockReturnValueOnce({
        id: 7,
        txHash: TX_HASH,
        contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        type: "distribute",
        status: "confirmed",
        payouts: [],
      });

    getTransactionById.mockReturnValue({
      id: 7,
      status: "pending",
      txHash: null,
    });

    pollHorizonTransaction.mockResolvedValue({
      status: "confirmed",
      ledger: 99,
      createdAt: "2026-05-31T12:00:00.000Z",
    });

    const res = await request(app)
      .post(`/api/v1/transaction/confirm/${TX_HASH}`)
      .send({ transactionId: 7 });

    expect(res.status).toBe(200);
    expect(updateTransactionHash).toHaveBeenCalledWith(7, TX_HASH);
  });

  test("400 for invalid hash format", async () => {
    const res = await request(app)
      .post("/api/v1/transaction/confirm/not-a-hash")
      .send({});

    expect(res.status).toBe(400);
  });

  test("504 when Horizon polling times out", async () => {
    getTransactionDetails.mockReturnValue({
      id: 1,
      txHash: TX_HASH,
      status: "pending",
      type: "initialize",
    });

    pollHorizonTransaction.mockRejectedValue({
      status: 504,
      message: "Transaction not confirmed within 60000ms",
    });

    const res = await request(app)
      .post(`/api/v1/transaction/confirm/${TX_HASH}`)
      .send({});

    expect(res.status).toBe(504);
  });
});
