import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import express from "express";
import StellarSdk from "@stellar/stellar-sdk";

// Mocking dependencies
const retryBuildTx = jest.fn();
const getContractAdmin = jest.fn();

const stellarSdkMock = {
  Address: { fromScVal: jest.fn((scVal) => ({ toString: () => scVal })) },
  Contract: jest.fn().mockImplementation(() => ({
    call: jest.fn((method) => ({ method })),
  })),
  SorobanRpc: { Api: { isSimulationError: jest.fn(() => false) } },
  TransactionBuilder: jest.fn().mockImplementation(() => ({
    addOperation: jest.fn().mockReturnThis(),
    setTimeout: jest.fn().mockReturnThis(),
    build: jest.fn().mockReturnValue({}),
  })),
  BASE_FEE: "100",
  Account: jest.fn(),
  scValToNative: jest.fn((value) => value),
  Keypair: StellarSdk.Keypair,
};

await jest.unstable_mockModule("@stellar/stellar-sdk", () => ({
  default: stellarSdkMock,
  ...stellarSdkMock,
}));

await jest.unstable_mockModule("../src/stellar.js", () => ({
  retryBuildTx,
  getContractAdmin,
  isContractInitialized: jest.fn(),
  addressToScVal: jest.fn((a) => a),
  u32ToScVal: jest.fn((n) => n),
  vecToScVal: jest.fn((v) => v),
  server: {},
  networkPassphrase: "Test SDF Network ; September 2015",
}));

// Setup mock roles database
const rolesMap = new Map();
const dbGetUserRole = jest.fn((contractId, walletAddress) => {
  const key = `${contractId || "global"}:${walletAddress}`;
  return rolesMap.get(key) || null;
});
const dbAssignUserRole = jest.fn((contractId, walletAddress, role, assignedBy) => {
  const key = `${contractId || "global"}:${walletAddress}`;
  rolesMap.set(key, role);
});

await jest.unstable_mockModule("../src/database/index.js", () => ({
  dbGetUserRole,
  dbAssignUserRole,
  dbHasAnyRoles: jest.fn(() => true),
  recordTransaction: jest.fn(() => 456),
  addAuditLog: jest.fn(),
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 1),
}));

await jest.unstable_mockModule("../src/database/roles.js", () => ({
  dbGetUserRole,
  dbAssignUserRole,
  dbHasAnyRoles: jest.fn(() => true),
}));

// Mock webhooks DB methods
const listDeadLetters = jest.fn(() => []);
await jest.unstable_mockModule("../src/database/webhooks.js", () => ({
  listDeadLetters,
  markDeadLetterRetried: jest.fn(),
}));

// Mock delivery
await jest.unstable_mockModule("../src/webhook-delivery.js", () => ({
  deliverWithRetry: jest.fn().mockResolvedValue({ success: true }),
}));

// Set memory database before importing DB
process.env.DATABASE_PATH = ":memory:";

// Import source modules
const { db } = await import("../src/database/core.js");

// Mock db.prepare
db.prepare = jest.fn().mockImplementation((sql) => {
  return {
    run: jest.fn().mockReturnValue({ lastInsertRowid: 123 }),
    get: jest.fn().mockImplementation((...args) => {
      if (sql.includes("webhook_dead_letters")) {
        return {
          id: args[0] || 123,
          webhookId: 1,
          contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          url: "https://example.com/webhook",
          payload: JSON.stringify({ event: "test" }),
          errorMessage: "Error",
          retryCount: 0,
        };
      }
      return null;
    }),
    all: jest.fn().mockReturnValue([]),
  };
});

const { adminRouter } = await import("../src/routes/admin.js");
const { distributeRouter } = await import("../src/routes/distribute.js");
const { signRequest } = await import("../src/request-signing.js");

// Create express app for testing
const app = express();
app.use(express.json());
app.use("/admin", adminRouter);
app.use("/api/v1/distribute", distributeRouter);
app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ error: err.message || "Internal server error", code: err.code });
});

// Helper variables
const ADMIN_KEYPAIR = StellarSdk.Keypair.random();
const VIEWER_KEYPAIR = StellarSdk.Keypair.random();
const OPERATOR_KEYPAIR = StellarSdk.Keypair.random();
const OTHER_KEYPAIR = StellarSdk.Keypair.random();

const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TOKEN_1 = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const TOKEN_2 = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

describe("RBAC and Batch Distribution Test Suite", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    rolesMap.clear();
    // Populate default roles for test users
    dbAssignUserRole(CONTRACT_ID, ADMIN_KEYPAIR.publicKey(), "admin", "system");
    dbAssignUserRole(CONTRACT_ID, VIEWER_KEYPAIR.publicKey(), "viewer", "system");
    dbAssignUserRole(CONTRACT_ID, OPERATOR_KEYPAIR.publicKey(), "operator", "system");
  });

  // ---------------------------------------------------------------------------
  // RBAC SCENARIOS (8 scenarios)
  // ---------------------------------------------------------------------------

  test("RBAC 1: Admin can set admins (requires Admin role)", async () => {
    retryBuildTx.mockResolvedValue("set-admins-xdr");

    const body = {
      contractId: CONTRACT_ID,
      walletAddress: ADMIN_KEYPAIR.publicKey(),
      admins: [ADMIN_KEYPAIR.publicKey()],
      threshold: 1,
    };

    const { headers } = signRequest({
      method: "POST",
      path: "/admin/set-admins",
      body,
      walletSecret: ADMIN_KEYPAIR.secret(),
    });

    const res = await request(app)
      .post("/admin/set-admins")
      .set(headers)
      .send(body);

    if (res.status !== 200) console.log("RBAC 1 FAILED:", res.status, res.body);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.xdr).toBe("set-admins-xdr");
  });

  test("RBAC 2: Non-admin (viewer / operator / other) cannot set admins", async () => {
    const body = {
      contractId: CONTRACT_ID,
      walletAddress: VIEWER_KEYPAIR.publicKey(),
      admins: [VIEWER_KEYPAIR.publicKey()],
      threshold: 1,
    };

    const { headers } = signRequest({
      method: "POST",
      path: "/admin/set-admins",
      body,
      walletSecret: VIEWER_KEYPAIR.secret(),
    });

    const res = await request(app)
      .post("/admin/set-admins")
      .set(headers)
      .send(body);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("forbidden");
  });

  test("RBAC 3: Admin can assign roles (requires Admin role)", async () => {
    const body = {
      contractId: CONTRACT_ID,
      walletAddress: OTHER_KEYPAIR.publicKey(),
      role: "viewer",
    };

    const { headers } = signRequest({
      method: "POST",
      path: "/admin/assign-role",
      body,
      walletSecret: ADMIN_KEYPAIR.secret(),
    });

    const res = await request(app)
      .post("/admin/assign-role")
      .set(headers)
      .send(body);

    if (res.status !== 200) console.log("RBAC 3 FAILED:", res.status, res.body);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const role = dbGetUserRole(CONTRACT_ID, OTHER_KEYPAIR.publicKey());
    expect(role).toBe("viewer");
  });

  test("RBAC 4: Non-admin cannot assign roles", async () => {
    const body = {
      contractId: CONTRACT_ID,
      walletAddress: OTHER_KEYPAIR.publicKey(),
      role: "viewer",
    };

    const { headers } = signRequest({
      method: "POST",
      path: "/admin/assign-role",
      body,
      walletSecret: OPERATOR_KEYPAIR.secret(),
    });

    const res = await request(app)
      .post("/admin/assign-role")
      .set(headers)
      .send(body);

    if (res.status !== 403) console.log("RBAC 4 FAILED:", res.status, res.body);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("forbidden");
  });

  test("RBAC 5: Operator can retry dead letters, but Viewer cannot", async () => {
    // Try with Viewer
    const { headers: viewerHeaders } = signRequest({
      method: "POST",
      path: "/admin/webhooks/dead-letters/123/retry",
      body: {},
      walletSecret: VIEWER_KEYPAIR.secret(),
    });

    const resViewer = await request(app)
      .post("/admin/webhooks/dead-letters/123/retry")
      .set(viewerHeaders)
      .send({});
    expect(resViewer.status).toBe(403);

    // Try with Operator
    const { headers: operatorHeaders } = signRequest({
      method: "POST",
      path: "/admin/webhooks/dead-letters/123/retry",
      body: {},
      walletSecret: OPERATOR_KEYPAIR.secret(),
    });

    const resOperator = await request(app)
      .post("/admin/webhooks/dead-letters/123/retry")
      .set(operatorHeaders)
      .send({});
    expect(resOperator.status).toBe(200);
  });

  test("RBAC 6: Viewer can list dead letters, but Unauthenticated cannot", async () => {
    const { headers: viewerHeaders } = signRequest({
      method: "GET",
      path: `/admin/webhooks/dead-letters/${CONTRACT_ID}`,
      body: {},
      walletSecret: VIEWER_KEYPAIR.secret(),
    });

    const resViewer = await request(app)
      .get(`/admin/webhooks/dead-letters/${CONTRACT_ID}`)
      .set(viewerHeaders);

    if (resViewer.status !== 200) console.log("RBAC 6 FAILED:", resViewer.status, resViewer.body, "viewerHeaders:", viewerHeaders);

    expect(resViewer.status).toBe(200);

    const resUnauth = await request(app)
      .get(`/admin/webhooks/dead-letters/${CONTRACT_ID}`);
    expect(resUnauth.status).toBe(401);
  });

  test("RBAC 7: On-chain admin fallback works when no role is in DB (bootstrap state)", async () => {
    // Clear all roles
    rolesMap.clear();

    // Mock getContractAdmin to return the OTHER_KEYPAIR as admin
    getContractAdmin.mockResolvedValue(OTHER_KEYPAIR.publicKey());

    const body = {
      contractId: CONTRACT_ID,
      walletAddress: OTHER_KEYPAIR.publicKey(),
      admins: [OTHER_KEYPAIR.publicKey()],
      threshold: 1,
    };

    const { headers } = signRequest({
      method: "POST",
      path: "/admin/set-admins",
      body,
      walletSecret: OTHER_KEYPAIR.secret(),
    });

    const res = await request(app)
      .post("/admin/set-admins")
      .set(headers)
      .send(body);

    if (res.status !== 200) console.log("RBAC 7 FAILED:", res.status, res.body);

    expect(res.status).toBe(200);
  });

  test("RBAC 8: Admin can rotate key using signature and admin role fallback", async () => {
    const ROTATED_KEYPAIR = StellarSdk.Keypair.random();
    // Assign global admin role
    dbAssignUserRole(null, ADMIN_KEYPAIR.publicKey(), "admin", "system");

    const body = {
      secretKey: ROTATED_KEYPAIR.secret(),
    };

    const { headers } = signRequest({
      method: "POST",
      path: "/admin/rotate-key",
      body,
      walletSecret: ADMIN_KEYPAIR.secret(),
    });

    const res = await request(app)
      .post("/admin/rotate-key")
      .set(headers)
      .send(body);

    if (res.status !== 200) console.log("RBAC 8 FAILED:", res.status, res.body);

    expect(res.status).toBe(200);
  });

  // ---------------------------------------------------------------------------
  // BATCH DISTRIBUTION SCENARIOS (4 scenarios)
  // ---------------------------------------------------------------------------

  test("Batch Distribute 1: Successful batch distribution with multiple tokens", async () => {
    retryBuildTx.mockResolvedValue("batch-distribute-xdr");

    const body = {
      contractId: CONTRACT_ID,
      walletAddress: OTHER_KEYPAIR.publicKey(),
      tokenIds: [TOKEN_1, TOKEN_2],
    };

    const res = await request(app)
      .post("/api/v1/distribute/batch")
      .send(body);

    if (res.status !== 200) console.log("Batch Distribute 1 FAILED:", res.status, res.body);

    expect(res.status).toBe(200);
    expect(res.body.xdr).toBe("batch-distribute-xdr");
    expect(retryBuildTx).toHaveBeenCalledWith(
      OTHER_KEYPAIR.publicKey(),
      CONTRACT_ID,
      "batch_distribute",
      expect.any(Array),
      undefined
    );
  });

  test("Batch Distribute 2: Fails with empty token list", async () => {
    const body = {
      contractId: CONTRACT_ID,
      walletAddress: OTHER_KEYPAIR.publicKey(),
      tokenIds: [],
    };

    const res = await request(app)
      .post("/api/v1/distribute/batch")
      .send(body);

    expect(res.status).toBe(400);
  });

  test("Batch Distribute 3: Fails when token list exceeds 10 tokens", async () => {
    const body = {
      contractId: CONTRACT_ID,
      walletAddress: OTHER_KEYPAIR.publicKey(),
      tokenIds: Array(11).fill(TOKEN_1),
    };

    const res = await request(app)
      .post("/api/v1/distribute/batch")
      .send(body);

    expect(res.status).toBe(400);
  });

  test("Batch Distribute 4: Fails when tokenId in array is not a valid contract address", async () => {
    const body = {
      contractId: CONTRACT_ID,
      walletAddress: OTHER_KEYPAIR.publicKey(),
      tokenIds: [TOKEN_1, "not-a-contract"],
    };

    const res = await request(app)
      .post("/api/v1/distribute/batch")
      .send(body);

    expect(res.status).toBe(400);
  });
});
