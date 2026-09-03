/**
 * Integration tests for POST /api/v1/batch-distribute (#759).
 */
import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import {
  VALID_CONTRACT_ID as CONTRACT_A,
  VALID_TOKEN_ID as TOKEN,
  VALID_WALLET_A as WALLET,
} from "./test-helpers.js";

const CONTRACT_B = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const CONTRACT_C = "CDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";

const buildMock = jest.fn();

class MockBatchTransactionBuilder {
  constructor(callerAddress) {
    this.callerAddress = callerAddress;
    this.ops = [];
  }
  add(op) {
    this.ops.push(op);
    return this;
  }
  build() {
    return buildMock(this.ops);
  }
}

await jest.unstable_mockModule("../src/stellar.js", () => ({
  addressToScVal: jest.fn((a) => a),
  BatchTransactionBuilder: MockBatchTransactionBuilder,
  pollHorizonTransaction: jest.fn(),
  buildTx: jest.fn(),
  retryBuildTx: jest.fn(),
  isContractInitialized: jest.fn(),
  bytes32ToScVal: jest.fn((v) => v),
  i128ToScVal: jest.fn((v) => v),
  u32ToScVal: jest.fn((n) => n),
  vecToScVal: jest.fn((v) => v),
  server: {},
  networkPassphrase: "Test SDF Network ; September 2015",
}));

let transactionCounter = 0;
const recordTransaction = jest.fn(() => {
  transactionCounter += 1;
  return `tx-batch-${transactionCounter}`;
});
const addAuditLog = jest.fn();

await jest.unstable_mockModule("../src/database/index.js", () => ({
  recordTransaction,
  addAuditLog,
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 1),
}));

// Mock validation with ALL schema exports
await jest.unstable_mockModule("../src/validation.js", () => ({
  isValidStellarAddress: jest.fn((addr) => addr && /^G[A-Z0-9]{55}$/.test(addr)),
  // All schemas
  initializeSchema: { parse: jest.fn((x) => x) },
  amountSchema: { parse: jest.fn((x) => x) },
  distributeSchema: { parse: jest.fn((x) => x) },
  batchDistributeSchema: { parse: jest.fn((x) => x) },
  setRoyaltyRateSchema: { parse: jest.fn((x) => x) },
  setSecondaryPoolLimitSchema: { parse: jest.fn((x) => x) },
  recordSecondarySaleSchema: { parse: jest.fn((x) => x) },
  distributeSecondarySchema: { parse: jest.fn((x) => x) },
  emailDigestSubscribeSchema: { parse: jest.fn((x) => x) },
  emailDigestPreferencesSchema: { parse: jest.fn((x) => x) },
  webhookRegisterSchema: { parse: jest.fn((x) => x) },
  transactionConfirmSchema: { parse: jest.fn((x) => x) },
  disputeSubmitSchema: { parse: jest.fn((x) => x) },
  disputeContributorCommentSchema: { parse: jest.fn((x) => x) },
  disputeAdminReviewSchema: { parse: jest.fn((x) => x) },
  disputeAdminCommentSchema: { parse: jest.fn((x) => x) },
  referralGenerateLinkSchema: { parse: jest.fn((x) => x) },
  referralRegisterSchema: { parse: jest.fn((x) => x) },
  referralActivateSchema: { parse: jest.fn((x) => x) },
  referralAwardBonusSchema: { parse: jest.fn((x) => x) },
  paginationSchema: { parse: jest.fn((x) => x) },
  analyticsQuerySchema: { parse: jest.fn((x) => x) },
  // Functions
  validate: jest.fn((schema) => (data) => ({ success: true, data })),
  validateStellarAddress: jest.fn(() => true),
  validateInitializePayloadSize: jest.fn((req, res, next) => next()),
  validateContractIdMiddleware: jest.fn((req, res, next) => next()),
  parsePagination: jest.fn((query) => ({ limit: 50, offset: 0 })),
  parseCursorPagination: jest.fn((query) => ({ limit: 50, cursor: null })),
  // Constants
  MAX_BATCH_OPERATIONS: 50,
  MAX_COLLABORATORS: 10,
}));

// Mock rate limiters to pass through in tests
await jest.unstable_mockModule("../src/middleware/tieredRateLimit.js", () => ({
  tieredLimiters: [(_req, _res, next) => next(), (_req, _res, next) => next()],
  rateLimitMetrics: { contractHits: 0, walletHits: 0, ipHits: 0 },
}));

const { default: app } = await import("./app.js");

describe("POST /api/v1/batch-distribute — integration", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.setTimeout(120000); // Increase timeout for all batch-distribute tests
    transactionCounter = 0;
  });

  test("happy path — builds an XDR per operation and reports success", async () => {
    buildMock.mockResolvedValue([
      { ok: true, xdr: "XDR_A" },
      { ok: true, xdr: "XDR_B" },
    ]);

    const res = await request(app)
      .post("/api/v1/batch-distribute")
      .send({
        walletAddress: WALLET,
        operations: [
          { contractId: CONTRACT_A, tokenId: TOKEN, amount: "1000" },
          { contractId: CONTRACT_B, tokenId: TOKEN, amount: "2000" },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.totalOperations).toBe(2);
    expect(res.body.succeeded).toBe(2);
    expect(res.body.failed).toBe(0);
    expect(res.body.totalAmount).toBe("3000");
    expect(res.body.results).toHaveLength(2);
    expect(res.body.results[0]).toMatchObject({ contractId: CONTRACT_A, xdr: "XDR_A" });
    expect(res.body.results[1]).toMatchObject({ contractId: CONTRACT_B, xdr: "XDR_B" });
    expect(recordTransaction).toHaveBeenCalledTimes(2);
    expect(addAuditLog).toHaveBeenCalledTimes(2);
  });

  test("reports partial failure without failing the whole batch", async () => {
    buildMock.mockResolvedValue([
      { ok: true, xdr: "XDR_A" },
      { ok: false, error: { message: "simulation failed" } },
    ]);

    const res = await request(app)
      .post("/api/v1/batch-distribute")
      .send({
        walletAddress: WALLET,
        operations: [
          { contractId: CONTRACT_A, tokenId: TOKEN },
          { contractId: CONTRACT_B, tokenId: TOKEN },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.succeeded).toBe(1);
    expect(res.body.failed).toBe(1);
    expect(res.body.results[1]).toMatchObject({
      contractId: CONTRACT_B,
      error: "simulation failed",
    });
    // The failing operation doesn't stop the audit log for the successful one.
    expect(addAuditLog).toHaveBeenCalledTimes(1);
  });

  test("rejects a batch with duplicate contractIds before doing any RPC work", async () => {
    const res = await request(app)
      .post("/api/v1/batch-distribute")
      .send({
        walletAddress: WALLET,
        operations: [
          { contractId: CONTRACT_A, tokenId: TOKEN },
          { contractId: CONTRACT_A, tokenId: TOKEN },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/duplicate/i);
    expect(buildMock).not.toHaveBeenCalled();
    expect(recordTransaction).not.toHaveBeenCalled();
  });

  test("rejects a batch exceeding the maximum operation count", async () => {
    const operations = Array.from({ length: 51 }, (_, i) => ({
      contractId: [CONTRACT_A, CONTRACT_B, CONTRACT_C][i % 3],
      tokenId: TOKEN,
    }));

    const res = await request(app)
      .post("/api/v1/batch-distribute")
      .send({ walletAddress: WALLET, operations });

    expect(res.status).toBe(400);
    expect(buildMock).not.toHaveBeenCalled();
  });

  test("rejects an empty operations array", async () => {
    const res = await request(app)
      .post("/api/v1/batch-distribute")
      .send({ walletAddress: WALLET, operations: [] });

    expect(res.status).toBe(400);
  });
});
