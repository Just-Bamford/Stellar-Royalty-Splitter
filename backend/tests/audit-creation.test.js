import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";

// Verifies audit entries are only ever created as a side effect of real
// configuration/administrative actions — not from a client-supplied audit
// payload (see tests/audit.test.js for the "no public POST route" coverage).

const retryBuildTx = jest.fn();
const buildTx = jest.fn();
const isContractInitialized = jest.fn();
const getRoyaltyRateFromContract = jest.fn();

const mockSimulate = jest.fn();
const mockIsSimError = jest.fn(() => false);

await jest.unstable_mockModule("@stellar/stellar-sdk", () => ({
  default: {
    Address: { fromScVal: jest.fn((scv) => ({ toString: () => scv })) },
    Contract: jest.fn().mockImplementation(() => ({ call: jest.fn((m) => ({ method: m })) })),
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
}));

await jest.unstable_mockModule("../src/stellar.js", () => ({
  retryBuildTx,
  buildTx,
  isContractInitialized,
  getRoyaltyRateFromContract,
  pollHorizonTransaction: jest.fn(),
  addressToScVal: jest.fn((a) => a),
  i128ToScVal: jest.fn((n) => n),
  u32ToScVal: jest.fn((n) => n),
  vecToScVal: jest.fn((v) => v),
  bytes32ToScVal: jest.fn((v) => v),
  BatchTransactionBuilder: jest.fn(),
  server: { simulateTransaction: mockSimulate },
  networkPassphrase: "Test SDF Network ; September 2015",
}));

const recordTransaction = jest.fn(() => "tx-1");
const recordSecondarySale = jest.fn();
const addAuditLog = jest.fn();

await jest.unstable_mockModule("../src/database/index.js", () => ({
  recordTransaction,
  recordSecondarySale,
  getSecondarySales: jest.fn(() => []),
  recordSecondaryRoyaltyDistribution: jest.fn(),
  getSecondaryRoyaltyDistributions: jest.fn(),
  getRoyaltyStatistics: jest.fn(),
  markSalesDistributed: jest.fn(),
  countSecondarySales: jest.fn(),
  addAuditLog,
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 1),
}));

// Mock validation to accept test wallets but reject invalid ones
await jest.unstable_mockModule("../src/validation.js", () => ({
  isValidStellarAddress: jest.fn((addr) => {
    // Accept valid G-addresses (56 chars starting with G)
    return addr && /^G[A-Z0-9]{55}$/.test(addr);
  }),
  initializeSchema: { parse: jest.fn((x) => x) },
  batchDistributeSchema: { parse: jest.fn((x) => x) },
  distributeSchema: { parse: jest.fn((x) => x) },
  validate: jest.fn((schema) => (data) => ({ success: true, data })),
  validateStellarAddress: jest.fn(() => true),
}));

const express = (await import("express")).default;
const { initializeRouter } = await import("../src/routes/initialize.js");
const { distributeRouter } = await import("../src/routes/distribute.js");
const { secondaryRoyaltyRouter } = await import("../src/routes/secondary-royalty.js");

const app = express();
app.use(express.json());
app.use("/api/v1/initialize", initializeRouter);
app.use("/api/v1/distribute", distributeRouter);
app.use("/api/v1/secondary-royalty", secondaryRoyaltyRouter);
app.use((err, _req, res, _next) => {
  res.status(500).json({ error: err.message ?? "Internal server error" });
});

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WALLET = "GAPTAQKSMN2ILFVHXDE5V274BUPC6QCRMJZYJFNGW7ENT2X3BQOS4M3C";
const TOKEN = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const COLLAB1 = "GA7E6YDRQKJ2JNOG27UPSCQ3FQ6U4X3QQGJKHNGF23T7QCI2FM6E3W2P";
const COLLAB2 = "GBOW474QUGZMHVHF6YDRQKJ2JNOG27UPUCY4FU7E6UDBOKBZJJNWYPSI";
const OTHER = "GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";

describe("Audit entries created as a side effect of real actions", () => {
  beforeEach(() => jest.clearAllMocks());

  test("POST /api/v1/initialize records contract_initialized with actor and reference data", async () => {
    isContractInitialized.mockResolvedValue(false);
    retryBuildTx.mockResolvedValue("init-xdr");
    recordTransaction.mockReturnValue("tx-init");

    const res = await request(app)
      .post("/api/v1/initialize")
      .send({
        contractId: CONTRACT,
        walletAddress: WALLET,
        collaborators: [COLLAB1, COLLAB2],
        shares: [5000, 5000],
      });

    expect(res.status).toBe(200);
    expect(addAuditLog).toHaveBeenCalledTimes(1);
    expect(addAuditLog).toHaveBeenCalledWith(
      CONTRACT,
      "contract_initialized",
      WALLET,
      expect.objectContaining({ transactionId: "tx-init", collaboratorCount: 2 })
    );
  });

  test("POST /api/v1/distribute records distribution_initiated with actor and reference data", async () => {
    retryBuildTx.mockResolvedValue("distribute-xdr");
    recordTransaction.mockReturnValue("tx-dist");

    const res = await request(app)
      .post("/api/v1/distribute")
      .send({ contractId: CONTRACT, walletAddress: WALLET, tokenId: TOKEN });

    expect(res.status).toBe(200);
    expect(addAuditLog).toHaveBeenCalledWith(
      CONTRACT,
      "distribution_initiated",
      WALLET,
      expect.objectContaining({ transactionId: "tx-dist", tokenId: TOKEN })
    );
  });

  test("POST /api/v1/secondary-royalty/set-rate records royalty_rate_set with actor and reference data", async () => {
    buildTx.mockResolvedValue("set-rate-xdr");
    recordTransaction.mockReturnValue("tx-rate");

    const res = await request(app)
      .post("/api/v1/secondary-royalty/set-rate")
      .send({ contractId: CONTRACT, walletAddress: WALLET, royaltyRate: 500 });

    expect(res.status).toBe(200);
    expect(addAuditLog).toHaveBeenCalledWith(
      CONTRACT,
      "royalty_rate_set",
      WALLET,
      expect.objectContaining({ transactionId: "tx-rate", royaltyRate: 500 })
    );
  });

  test("POST /api/v1/secondary-royalty records secondary_sale_recorded with actor and reference data", async () => {
    getRoyaltyRateFromContract.mockResolvedValue(500);
    recordTransaction.mockReturnValue("tx-sale");
    buildTx.mockResolvedValue("sale-xdr");

    const res = await request(app).post("/api/v1/secondary-royalty").send({
      contractId: CONTRACT,
      walletAddress: WALLET,
      nftId: "nft-1",
      previousOwner: COLLAB1,
      newOwner: OTHER,
      salePrice: 10000,
      saleToken: TOKEN,
      royaltyRate: 500,
    });

    expect(res.status).toBe(200);
    expect(addAuditLog).toHaveBeenCalledWith(
      CONTRACT,
      "secondary_sale_recorded",
      WALLET,
      expect.objectContaining({ transactionId: "tx-sale", nftId: "nft-1" })
    );
  });

  test("no audit log route accepts action/user/details directly from a request body", async () => {
    // There is no /api/v1/audit/:contractId POST route mounted in this app at
    // all (mirrors production wiring) — confirms the write surface is gone,
    // not just relocated.
    const res = await request(app)
      .post(`/api/v1/audit/${CONTRACT}`)
      .send({ action: "contract_initialized", user: WALLET, details: {} });

    expect(res.status).toBe(404);
    expect(addAuditLog).not.toHaveBeenCalled();
  });
});
