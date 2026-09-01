// Integration tests for POST /api/v1/initialize – covering happy path, errors, payload limits, and RPC failures
import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import express from "express";
import request from "supertest";
import {
  INITIALIZE_COLLABORATORS_PAYLOAD_LIMIT_BYTES,
  INITIALIZE_PAYLOAD_LIMIT_BYTES,
} from "../src/validation.js";
import { notFoundHandler, errorHandler } from "../src/error-response.js";

// Mock modules used by the route
const retryBuildTx = jest.fn();
const isContractInitialized = jest.fn();
await jest.unstable_mockModule("../src/stellar.js", () => ({
  retryBuildTx,
  isContractInitialized,
  addressToScVal: jest.fn((a) => a),
  u32ToScVal: jest.fn((n) => n),
  vecToScVal: jest.fn((v) => v),
  server: {},
  networkPassphrase: "Test SDF Network ; September 2015",
}));

const recordTransaction = jest.fn(() => "tx-123");
const addAuditLog = jest.fn();
await jest.unstable_mockModule("../src/database/index.js", () => ({
  recordTransaction,
  addAuditLog,
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 1),
}));

const { initializeRouter } = await import("../src/routes/initialize.js");

const app = express();
app.use(express.json({ limit: "10kb" }));
app.use("/api/v1/initialize", initializeRouter);
app.use(notFoundHandler);
app.use(errorHandler);

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WALLET = "GAPTAQKSMN2ILFVHXDE5V274BUPC6QCRMJZYJFNGW7ENT2X3BQOS4M3C";
const COLLAB1 = "GA7E6YDRQKJ2JNOG27UPSCQ3FQ6U4X3QQGJKHNGF23T7QCI2FM6E3W2P";
const COLLAB2 = "GBOW474QUGZMHVHF6YDRQKJ2JNOG27UPUCY4FU7E6UDBOKBZJJNWYPSI";

const validBody = {
  contractId: CONTRACT,
  walletAddress: WALLET,
  collaborators: [COLLAB1, COLLAB2],
  shares: [5000, 5000],
};

describe("POST /api/v1/initialize – integration", () => {
  beforeEach(() => jest.clearAllMocks());

  test("happy path – returns xdr and transactionId", async () => {
    isContractInitialized.mockResolvedValue(false);
    retryBuildTx.mockResolvedValue("unsigned-xdr-string");
    const res = await request(app).post("/api/v1/initialize").send(validBody);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ xdr: "unsigned-xdr-string", transactionId: "tx-123" });
  });

  test("409 when contract is already initialized", async () => {
    isContractInitialized.mockResolvedValue(true);
    const res = await request(app).post("/api/v1/initialize").send(validBody);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already initialized/i);
  });

  test("400 when shares total is not 10000", async () => {
    const res = await request(app)
      .post("/api/v1/initialize")
      .send({ ...validBody, shares: [3000, 3000] });
    expect(res.status).toBe(400);
    const details = JSON.stringify(res.body);
    expect(details).toMatch(/6000/);
    expect(details).toMatch(/10000/);
  });

  test("400 when collaborators array is empty", async () => {
    const res = await request(app)
      .post("/api/v1/initialize")
      .send({ ...validBody, collaborators: [], shares: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/collaborators array must be non-empty/i);
  });

  test("413 when initialize payload is too large", async () => {
    const res = await request(app)
      .post("/api/v1/initialize")
      .send({ ...validBody, padding: "x".repeat(INITIALIZE_PAYLOAD_LIMIT_BYTES) });
    expect(res.status).toBe(413);
    expect(res.body.error).toBe("Payload too large");
    expect(isContractInitialized).not.toHaveBeenCalled();
    expect(retryBuildTx).not.toHaveBeenCalled();
    expect(recordTransaction).not.toHaveBeenCalled();
  });

  test("413 when collaborators payload is too large", async () => {
    const oversizedCollaborator = `G${"A".repeat(INITIALIZE_COLLABORATORS_PAYLOAD_LIMIT_BYTES)}`;
    const res = await request(app)
      .post("/api/v1/initialize")
      .send({
        ...validBody,
        collaborators: [oversizedCollaborator],
        shares: [10000],
      });
    expect(res.status).toBe(413);
    expect(res.body.error).toBe("Collaborators payload too large");
    expect(isContractInitialized).not.toHaveBeenCalled();
    expect(retryBuildTx).not.toHaveBeenCalled();
    expect(recordTransaction).not.toHaveBeenCalled();
  });

  test("503 when Stellar RPC is unavailable", async () => {
    isContractInitialized.mockResolvedValue(false);
    retryBuildTx.mockRejectedValue({
      status: 503,
      message: "Stellar RPC is currently unavailable. Please try again later.",
    });
    const res = await request(app).post("/api/v1/initialize").send(validBody);
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/unavailable/i);
  });
});
