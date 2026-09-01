import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";

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
  attachRole: (req, _res, next) => { req.role = "admin"; next(); },
  requireRole: () => (req, _res, next) => { req.role = "admin"; next(); },
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
  hold_placed_by: "admin",
  hold_released_at: null,
  hold_released_by: null,
  hold_approved_by: null,
  hold_approved_at: null,
  hold_approval_note: null,
  hold_status: "active",
  ...overrides,
});

describe("Payment Holds - Place Hold", () => {
  test("POST /place places a hold on a transaction", async () => {
    mockPlaceHold.mockReturnValue(mockTransaction());
    const res = await request(app)
      .post("/api/v1/payment-holds/place")
      .send({ transactionId: TX_ID, holdReason: "Dispute pending", placedBy: "admin" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockPlaceHold).toHaveBeenCalledWith(TX_ID, "Dispute pending", null, "admin");
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
  test("POST /release releases a held transaction", async () => {
    mockReleaseHold.mockReturnValue(mockTransaction({ hold_status: "released", hold_released_by: "admin" }));
    const res = await request(app)
      .post("/api/v1/payment-holds/release")
      .send({ transactionId: TX_ID, releasedBy: "admin", approvalNote: "Dispute resolved" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test("POST /release rejects missing transactionId", async () => {
    const res = await request(app)
      .post("/api/v1/payment-holds/release")
      .send({ releasedBy: "admin" });
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
  test("POST /approve-release approves a hold release", async () => {
    mockApproveHoldRelease.mockReturnValue(mockTransaction({ hold_approved_by: "admin2" }));
    const res = await request(app)
      .post("/api/v1/payment-holds/approve-release")
      .send({ transactionId: TX_ID, approvedBy: "admin2", approvalNote: "Approved" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test("POST /approve-release rejects missing transactionId", async () => {
    const res = await request(app)
      .post("/api/v1/payment-holds/approve-release")
      .send({ approvedBy: "admin2" });
    expect(res.status).toBe(400);
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
    mockGetTransactionsPendingHoldRelease.mockReturnValue([mockTransaction({ hold_approved_by: "admin2" })]);
    const res = await request(app).get("/api/v1/payment-holds/pending-release");
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
  });

  test("GET /audit/:transactionId returns audit trail", async () => {
    mockGetHoldAuditTrail.mockReturnValue([
      { id: 1, transactionId: TX_ID, action: "placed", reason: "Dispute", performedBy: "admin" },
    ]);
    const res = await request(app).get(`/api/v1/payment-holds/audit/${TX_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
  });
});

describe("Payment Holds - Hold Lifecycle", () => {
  test("full hold lifecycle: place -> approve -> release", async () => {
    mockPlaceHold.mockReturnValue(mockTransaction());
    mockApproveHoldRelease.mockReturnValue(mockTransaction({ hold_approved_by: "admin2" }));
    mockReleaseHold.mockReturnValue(mockTransaction({ hold_status: "released" }));

    const place = await request(app)
      .post("/api/v1/payment-holds/place")
      .send({ transactionId: TX_ID, holdReason: "Dispute" });
    expect(place.body.data.hold_status).toBe("active");

    const approve = await request(app)
      .post("/api/v1/payment-holds/approve-release")
      .send({ transactionId: TX_ID, approvedBy: "admin2" });
    expect(approve.body.data.hold_approved_by).toBe("admin2");

    const release = await request(app)
      .post("/api/v1/payment-holds/release")
      .send({ transactionId: TX_ID, releasedBy: "admin" });
    expect(release.body.data.hold_status).toBe("released");
  });

  test("reasons and timestamps recorded for all actions", async () => {
    mockPlaceHold.mockReturnValue(mockTransaction({
      hold_reason: "Verification",
      hold_placed_at: "2026-07-26T12:00:00.000Z"
    }));

    const res = await request(app)
      .post("/api/v1/payment-holds/place")
      .send({ transactionId: TX_ID, holdReason: "Verification" });

    expect(res.body.data.hold_reason).toBe("Verification");
    expect(res.body.data.hold_placed_at).toBeDefined();
  });
});
