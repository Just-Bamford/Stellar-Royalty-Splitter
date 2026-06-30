/**
 * Commit-reveal initialize route tests (#403).
 */
import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import express from "express";
import request from "supertest";

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const HASH = "a".repeat(64);

const retryBuildTx = jest.fn().mockResolvedValue("AAAAxdr");
const isContractInitialized = jest.fn().mockResolvedValue(false);

await jest.unstable_mockModule("../src/stellar.js", () => ({
  retryBuildTx,
  isContractInitialized,
  addressToScVal: jest.fn((a) => a),
  u32ToScVal: jest.fn((n) => n),
  vecToScVal: jest.fn((v) => v),
  bytesN32HexToScVal: jest.fn((h) => h),
  getNetworkLabel: jest.fn(() => "Testnet"),
  server: {},
  networkPassphrase: "Test SDF Network ; September 2015",
}));

await jest.unstable_mockModule("../src/database/index.js", () => ({
  recordTransaction: jest.fn(() => 1),
  addAuditLog: jest.fn(),
  lookupCollaborators: jest.fn(() => []),
  recordNonceIfNew: jest.fn(() => true),
}));

const { initializeRouter } = await import("../src/routes/initialize.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/initialize", initializeRouter);
  return app;
}

describe("initialize commit-reveal routes (#403)", () => {
  beforeEach(() => {
    retryBuildTx.mockClear();
    isContractInitialized.mockResolvedValue(false);
  });

  test("POST /commit validates hex hashes", async () => {
    const res = await request(createApp()).post("/api/v1/initialize/commit").send({
      contractId: CONTRACT,
      walletAddress: WALLET,
      collaboratorsHash: "not-hex",
      sharesHash: HASH,
      nonce: HASH,
    });
    expect(res.status).toBe(400);
  });

  test("POST /commit returns xdr on success", async () => {
    const res = await request(createApp()).post("/api/v1/initialize/commit").send({
      contractId: CONTRACT,
      walletAddress: WALLET,
      collaboratorsHash: HASH,
      sharesHash: HASH,
      nonce: HASH,
    });
    expect(res.status).toBe(200);
    expect(res.body.phase).toBe("commit");
    expect(res.body.xdr).toBeDefined();
  });

  test("POST /reveal requires salt", async () => {
    const res = await request(createApp()).post("/api/v1/initialize/reveal").send({
      contractId: CONTRACT,
      walletAddress: WALLET,
      collaborators: [WALLET],
      shares: [10000],
    });
    expect(res.status).toBe(400);
  });

  test("POST /reveal returns xdr on success", async () => {
    const res = await request(createApp()).post("/api/v1/initialize/reveal").send({
      contractId: CONTRACT,
      walletAddress: WALLET,
      collaborators: [WALLET],
      shares: [10000],
      salt: HASH,
    });
    expect(res.status).toBe(200);
    expect(res.body.phase).toBe("reveal");
  });
});
