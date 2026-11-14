import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";

const ADMIN_WALLET_1 = "GADMIN1WALLETADDRESS234567234567234567234567234567234567";
const ADMIN_WALLET_2 = "GADMIN2WALLETADDRESS234567234567234567234567234567234567";
let currentAuthUser = { id: 1, walletAddress: ADMIN_WALLET_1, role: "admin" };

const mockPlaceHold = jest.fn();
const mockReleaseHold = jest.fn();
const mockApproveHoldRelease = jest.fn();
const mockGetTransactionWithHold = jest.fn();
const mockGetHeldTransactions = jest.fn();
const mockGetAllHeldTransactions = jest.fn();
const mockGetTransactionsPendingHoldRelease = jest.fn();
const mockGetHoldAuditTrail = jest.fn();
const mockAddAuditLog = jest.fn();

await jest.unstable_mockModule("../src/database/payment-holds.js", () => ({
  placeHold: mockPlaceHold,
  releaseHold: mockReleaseHold,
  approveHoldRelease: mockApproveHoldRelease,
  getTransactionWithHold: mockGetTransactionWithHold,
  getHeldTransactions: mockGetHeldTransactions,
  getAllHeldTransactions: mockGetAllHeldTransactions,
  getTransactionsPendingHoldRelease: mockGetTransactionsPendingHoldRelease,
  getHoldAuditTrail: mockGetHoldAuditTrail,
}));

await jest.unstable_mockModule("../src/database/audit.js", () => ({
  addAuditLog: mockAddAuditLog,
}));

await jest.unstable_mockModule("../src/database/index.js", () => ({
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 10),
}));

await jest.unstable_mockModule("../src/middleware/rbac.js", () => ({
  attachRole: (req, _res, next) => {
    req.user = currentAuthUser;
    req.role = currentAuthUser?.role ?? "admin";
    next();
  },
  requireRole: () => (req, _res, next) => {
    req.user = currentAuthUser;
    req.role = currentAuthUser?.role ?? "admin";
    next();
  },
}));

import express from "express";
const { paymentHoldsRouter } = await import("../src/routes/payment-holds.js");

const app = express();
app.use(express.json());
app.use("/api/v1/payment-holds", paymentHoldsRouter);

app.use((err, _req, res, _next) => {
  res.status(500).json({ error: err.message ?? "Internal server error" });
});

const CONTRACT_ID = "CAFQE4X7R7X7R7X7R7X7R7X7R7X7R7X7R7X7R7X7R7X7R7X7R7X7R7";
const TX_ID = 42;

const mockTransaction = (overrides = {}) => ({
  id: TX_ID,
  contractId: CONTRACT_ID,
  type: "distribute",
  status: "hold",
  hold_reason: "Dispute pending",
  hold_until: null,
  hold_placed_at: "2026-07-26T12:00:00.000Z",
  hold_placed_by: ADMIN_WALLET_1,
  hold_released_at: null,
  hold_released_by: null,
  hold_approved_by: null,
  hold_approved_at: null,
  hold_approval_note: null,
  hold_status: "active",
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  currentAuthUser = { id: 1, walletAddress: ADMIN_WALLET_1, role: "admin" };
});

describe("Payment Holds - Place Hold", () => {
  test("POST /place places a hold using the authenticated admin wallet address", async () => {
    mockPlaceHold.mockReturnValue(mockTransaction());
    const res = await request(app)
      .post("/api/v1/payment-holds/place")
      .send({ transactionId: TX_ID, holdReason: "Dispute pending" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockPlaceHold).toHaveBeenCalledWith(TX_ID, "Dispute pending", null, ADMIN_WALLET_1);
    expect(mockAddAuditLog).toHaveBeenCalledWith(
      CONTRACT_ID,
      "payment_hold_placed",
      ADMIN_WALLET_1,
      expect.any(String)
    );
  });

  test("POST /place rejects missing transactionId", async () => {
    const res = await request(app)
      .post("/api/v1/payment-holds/place")
      .send({ holdReason: "Dispute" });
    expect(res.status).toBe(400);
  });

  test("POST /place rejects missing holdReason", async () => {
    const res = await request(app)
      .post("/api/v1/payment-holds/place")
      .send({ transactionId: TX_ID });
    expect(res.status).toBe(400);
  });

  test("POST /place returns 404 for non-existent transaction", async () => {
    mockPlaceHold.mockReturnValue(null);
    const res = await request(app)
      .post("/api/v1/payment-holds/place")
      .send({ transactionId: 999, holdReason: "Testing" });
    expect(res.status).toBe(404);
  });

  test("POST /place records hold reason and timestamp", async () => {
    const mockResult = mockTransaction({ hold_reason: "Funds verification required" });
    mockPlaceHold.mockReturnValue(mockResult);
    const res = await request(app)
      .post("/api/v1/payment-holds/place")
      .send({ transactionId: TX_ID, holdReason: "Funds verification required" });
    expect(res.body.data.hold_reason).toBe("Funds verification required");
    expect(res.body.data.hold_placed_at).toBeDefined();
  });
});

describe("Payment Holds - Release Hold", () => {
  test("POST /release releases a held transaction using the authenticated admin wallet address", async () => {
    mockReleaseHold.mockReturnValue(
      mockTransaction({ hold_status: "released", hold_released_by: ADMIN_WALLET_1 })
    );
    const res = await request(app)
      .post("/api/v1/payment-holds/release")
      .send({ transactionId: TX_ID, approvalNote: "Dispute resolved" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockReleaseHold).toHaveBeenCalledWith(TX_ID, ADMIN_WALLET_1, "Dispute resolved");
    expect(mockAddAuditLog).toHaveBeenCalledWith(
      CONTRACT_ID,
      "payment_hold_released",
      ADMIN_WALLET_1,
      expect.any(String)
    );
  });

  test("POST /release rejects missing transactionId", async () => {
    const res = await request(app)
      .post("/api/v1/payment-holds/release")
      .send({ approvalNote: "Dispute resolved" });
    expect(res.status).toBe(400);
  });

  test("POST /release returns 404 when transaction not on hold", async () => {
    mockReleaseHold.mockReturnValue(null);
    const res = await request(app)
      .post("/api/v1/payment-holds/release")
      .send({ transactionId: 999 });
    expect(res.status).toBe(404);
  });
});

describe("Payment Holds - Approval Workflow", () => {
  test("POST /approve-release approves a hold release using the authenticated admin wallet address", async () => {
    currentAuthUser = { id: 2, walletAddress: ADMIN_WALLET_2, role: "admin" };
    mockApproveHoldRelease.mockReturnValue(mockTransaction({ hold_approved_by: ADMIN_WALLET_2 }));
    const res = await request(app)
      .post("/api/v1/payment-holds/approve-release")
      .send({ transactionId: TX_ID, approvalNote: "Approved" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockApproveHoldRelease).toHaveBeenCalledWith(TX_ID, ADMIN_WALLET_2, "Approved");
    expect(mockAddAuditLog).toHaveBeenCalledWith(
      CONTRACT_ID,
      "hold_release_approved",
      ADMIN_WALLET_2,
      expect.any(String)
    );
  });

  test("POST /approve-release rejects missing transactionId", async () => {
    const res = await request(app)
      .post("/api/v1/payment-holds/approve-release")
      .send({ approvalNote: "Approved" });
    expect(res.status).toBe(400);
  });
});

describe("Payment Holds - Auth Actor & Audit Integrity (#1325)", () => {
  test("ignores spoofed placedBy, releasedBy, and approvedBy fields in request body", async () => {
    mockPlaceHold.mockReturnValue(mockTransaction({ hold_placed_by: ADMIN_WALLET_1 }));
    mockApproveHoldRelease.mockReturnValue(mockTransaction({ hold_approved_by: ADMIN_WALLET_1 }));
    mockReleaseHold.mockReturnValue(
      mockTransaction({ hold_status: "released", hold_released_by: ADMIN_WALLET_1 })
    );

    const spoofedWallet = "GSPOOFEDOTHERADMINWALLET23456723456723456723456723456723";

    await request(app)
      .post("/api/v1/payment-holds/place")
      .send({ transactionId: TX_ID, holdReason: "Fraud review", placedBy: spoofedWallet });
    expect(mockPlaceHold).toHaveBeenCalledWith(TX_ID, "Fraud review", null, ADMIN_WALLET_1);
    expect(mockAddAuditLog).toHaveBeenCalledWith(
      CONTRACT_ID,
      "payment_hold_placed",
      ADMIN_WALLET_1,
      expect.any(String)
    );

    await request(app)
      .post("/api/v1/payment-holds/approve-release")
      .send({ transactionId: TX_ID, approvedBy: spoofedWallet, approvalNote: "Reviewed" });
    expect(mockApproveHoldRelease).toHaveBeenCalledWith(TX_ID, ADMIN_WALLET_1, "Reviewed");
    expect(mockAddAuditLog).toHaveBeenCalledWith(
      CONTRACT_ID,
      "hold_release_approved",
      ADMIN_WALLET_1,
      expect.any(String)
    );

    await request(app)
      .post("/api/v1/payment-holds/release")
      .send({ transactionId: TX_ID, releasedBy: spoofedWallet, approvalNote: "Cleared" });
    expect(mockReleaseHold).toHaveBeenCalledWith(TX_ID, ADMIN_WALLET_1, "Cleared");
    expect(mockAddAuditLog).toHaveBeenCalledWith(
      CONTRACT_ID,
      "payment_hold_released",
      ADMIN_WALLET_1,
      expect.any(String)
    );
  });

  test("falls back to req.user.id when walletAddress is absent and 'unknown' when req.user is null", async () => {
    currentAuthUser = { id: 77, role: "admin" };
    mockReleaseHold.mockReturnValue(
      mockTransaction({ hold_status: "released", hold_released_by: "77" })
    );

    await request(app).post("/api/v1/payment-holds/release").send({ transactionId: TX_ID });
    expect(mockReleaseHold).toHaveBeenCalledWith(TX_ID, "77", null);
    expect(mockAddAuditLog).toHaveBeenCalledWith(
      CONTRACT_ID,
      "payment_hold_released",
      "77",
      expect.any(String)
    );

    currentAuthUser = null;
    mockReleaseHold.mockReturnValue(
      mockTransaction({ hold_status: "released", hold_released_by: "unknown" })
    );

    await request(app).post("/api/v1/payment-holds/release").send({ transactionId: TX_ID });
    expect(mockReleaseHold).toHaveBeenCalledWith(TX_ID, "unknown", null);
    expect(mockAddAuditLog).toHaveBeenCalledWith(
      CONTRACT_ID,
      "payment_hold_released",
      "unknown",
      expect.any(String)
    );
  });
});

describe("Payment Holds - Query", () => {
  test("GET /transaction/:transactionId returns hold details", async () => {
    mockGetTransactionWithHold.mockReturnValue(mockTransaction());
    mockGetHoldAuditTrail.mockReturnValue([]);
    const res = await request(app).get(`/api/v1/payment-holds/transaction/${TX_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(TX_ID);
    expect(res.body.data.auditTrail).toEqual([]);
  });

  test("GET /transaction/:transactionId returns 404 for non-existent", async () => {
    mockGetTransactionWithHold.mockReturnValue(null);
    const res = await request(app).get("/api/v1/payment-holds/transaction/999");
    expect(res.status).toBe(404);
  });

  test("GET /contract/:contractId returns held transactions", async () => {
    mockGetHeldTransactions.mockReturnValue([mockTransaction()]);
    const res = await request(app).get(`/api/v1/payment-holds/contract/${CONTRACT_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
  });

  test("GET /all returns all held transactions", async () => {
    mockGetAllHeldTransactions.mockReturnValue([mockTransaction()]);
    const res = await request(app).get("/api/v1/payment-holds/all");
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
  });

  test("GET /pending-release returns transactions pending release", async () => {
    mockGetTransactionsPendingHoldRelease.mockReturnValue([
      mockTransaction({ hold_approved_by: ADMIN_WALLET_2 }),
    ]);
    const res = await request(app).get("/api/v1/payment-holds/pending-release");
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
  });

  test("GET /audit/:transactionId returns audit trail", async () => {
    mockGetHoldAuditTrail.mockReturnValue([
      {
        id: 1,
        transactionId: TX_ID,
        action: "placed",
        reason: "Dispute",
        performedBy: ADMIN_WALLET_1,
      },
    ]);
    const res = await request(app).get(`/api/v1/payment-holds/audit/${TX_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].performedBy).toBe(ADMIN_WALLET_1);
  });
});

describe("Payment Holds - Hold Lifecycle", () => {
  test("full hold lifecycle: place -> approve -> release records real admin wallets", async () => {
    mockPlaceHold.mockReturnValue(mockTransaction({ hold_placed_by: ADMIN_WALLET_1 }));
    mockApproveHoldRelease.mockReturnValue(mockTransaction({ hold_approved_by: ADMIN_WALLET_2 }));
    mockReleaseHold.mockReturnValue(
      mockTransaction({ hold_status: "released", hold_released_by: ADMIN_WALLET_1 })
    );

    const place = await request(app)
      .post("/api/v1/payment-holds/place")
      .send({ transactionId: TX_ID, holdReason: "Dispute" });
    expect(place.body.data.hold_status).toBe("active");
    expect(place.body.data.hold_placed_by).toBe(ADMIN_WALLET_1);

    currentAuthUser = { id: 2, walletAddress: ADMIN_WALLET_2, role: "admin" };
    const approve = await request(app)
      .post("/api/v1/payment-holds/approve-release")
      .send({ transactionId: TX_ID });
    expect(approve.body.data.hold_approved_by).toBe(ADMIN_WALLET_2);

    currentAuthUser = { id: 1, walletAddress: ADMIN_WALLET_1, role: "admin" };
    const release = await request(app)
      .post("/api/v1/payment-holds/release")
      .send({ transactionId: TX_ID });
    expect(release.body.data.hold_status).toBe("released");
    expect(release.body.data.hold_released_by).toBe(ADMIN_WALLET_1);
  });

  test("reasons and timestamps recorded for all actions", async () => {
    mockPlaceHold.mockReturnValue(
      mockTransaction({
        hold_reason: "Verification",
        hold_placed_at: "2026-07-26T12:00:00.000Z",
      })
    );

    const res = await request(app)
      .post("/api/v1/payment-holds/place")
      .send({ transactionId: TX_ID, holdReason: "Verification" });

    expect(res.body.data.hold_reason).toBe("Verification");
    expect(res.body.data.hold_placed_at).toBeDefined();
  });
});
