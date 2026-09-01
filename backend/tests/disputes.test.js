/**
 * Tests for the dispute resolution routes — closes #607.
 *
 * Covers: submit, list, get, contributor comment, admin list/filter,
 *         admin status update, admin comment, status notifications,
 *         and validation / auth error paths.
 */
import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";

// ─── Mock database helpers ────────────────────────────────────────────────────

const mockCreateDispute = jest.fn();
const mockGetDisputeByTicketId = jest.fn();
const mockGetDisputesByWallet = jest.fn();
const mockCountDisputesByWallet = jest.fn();
const mockGetAllDisputes = jest.fn();
const mockCountAllDisputes = jest.fn();
const mockUpdateDisputeStatus = jest.fn();
const mockAddDisputeComment = jest.fn();

await jest.unstable_mockModule("../src/database/disputes.js", () => ({
  createDispute: mockCreateDispute,
  getDisputeByTicketId: mockGetDisputeByTicketId,
  getDisputesByWallet: mockGetDisputesByWallet,
  countDisputesByWallet: mockCountDisputesByWallet,
  getAllDisputes: mockGetAllDisputes,
  countAllDisputes: mockCountAllDisputes,
  updateDisputeStatus: mockUpdateDisputeStatus,
  addDisputeComment: mockAddDisputeComment,
  getDisputeComments: jest.fn(() => []),
}));

await jest.unstable_mockModule("../src/database/index.js", () => ({
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 8),
}));

// ─── Mock email helpers ───────────────────────────────────────────────────────

const mockSendEmail = jest.fn(() => ({ sent: true }));
const mockIsEmailConfigured = jest.fn(() => false);

await jest.unstable_mockModule("../src/email/email-service.js", () => ({
  sendEmail: mockSendEmail,
  isEmailConfigured: mockIsEmailConfigured,
}));

// Mock email-digest subscriber lookup used for contributor notifications
await jest.unstable_mockModule("../src/database/email-digest.js", () => ({
  getSubscriberByWallet: jest.fn(() => null),
}));

// ─── Build minimal Express app ────────────────────────────────────────────────

import express from "express";
const { disputesRouter } = await import("../src/routes/disputes.js");

const app = express();
app.use(express.json());
app.use("/api/v1/disputes", disputesRouter);
app.use((err, _req, res, _next) => {
  res.status(500).json({ error: err.message ?? "Internal server error" });
});

// ─── Test data ────────────────────────────────────────────────────────────────

const WALLET  = "GA7E6YDRQKJ2JNOG27UPSCQ3FQ6U4X3QQGJKHNGF23T7QCI2FM6E3W2P";
const WALLET2 = "GBOW474QUGZMHVHF6YDRQKJ2JNOG27UPUCY4FU7E6UDBOKBZJJNWYPSI";
const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TICKET_ID = "DSP-A3F2C019";
const ADMIN_TOKEN = "test-admin-token";
const TIMESTAMP = "2026-07-26T10:00:00.000Z";

const baseDispute = (overrides = {}) => ({
  id: 1,
  ticketId: TICKET_ID,
  walletAddress: WALLET,
  contractId: CONTRACT,
  category: "wrong_amount",
  description: "I received less than expected for the last distribution.",
  status: "open",
  adminNote: null,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
  comments: [],
  ...overrides,
});

const baseComment = (overrides = {}) => ({
  id: 1,
  disputeId: 1,
  author: "admin",
  message: "We are looking into this.",
  createdAt: TIMESTAMP,
  ...overrides,
});

// ─── POST /api/v1/disputes ────────────────────────────────────────────────────

describe("POST /api/v1/disputes", () => {
  beforeEach(() => jest.clearAllMocks());

  test("creates a dispute and returns 201 with ticket data", async () => {
    mockCreateDispute.mockReturnValue(baseDispute());

    const res = await request(app)
      .post("/api/v1/disputes")
      .send({
        walletAddress: WALLET,
        contractId: CONTRACT,
        category: "wrong_amount",
        description: "I received less than expected for the last distribution.",
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.ticketId).toBe(TICKET_ID);
    expect(res.body.data.status).toBe("open");
    expect(mockCreateDispute).toHaveBeenCalledWith({
      walletAddress: WALLET,
      contractId: CONTRACT,
      category: "wrong_amount",
      description: "I received less than expected for the last distribution.",
    });
  });

  test("accepts missing_payment category", async () => {
    mockCreateDispute.mockReturnValue(baseDispute({ category: "missing_payment" }));

    const res = await request(app)
      .post("/api/v1/disputes")
      .send({
        walletAddress: WALLET,
        category: "missing_payment",
        description: "Payment never arrived in my wallet.",
      });

    expect(res.status).toBe(201);
    expect(mockCreateDispute).toHaveBeenCalled();
  });

  test("accepts other category without contractId", async () => {
    mockCreateDispute.mockReturnValue(baseDispute({ category: "other", contractId: null }));

    const res = await request(app)
      .post("/api/v1/disputes")
      .send({ walletAddress: WALLET, category: "other", description: "General concern here." });

    expect(res.status).toBe(201);
  });

  test("400 when walletAddress is missing", async () => {
    const res = await request(app)
      .post("/api/v1/disputes")
      .send({ category: "other", description: "Some issue with my payment." });

    expect(res.status).toBe(400);
    expect(mockCreateDispute).not.toHaveBeenCalled();
  });

  test("400 when category is invalid", async () => {
    const res = await request(app)
      .post("/api/v1/disputes")
      .send({ walletAddress: WALLET, category: "bogus", description: "Some description here." });

    expect(res.status).toBe(400);
    expect(mockCreateDispute).not.toHaveBeenCalled();
  });

  test("400 when description is too short", async () => {
    const res = await request(app)
      .post("/api/v1/disputes")
      .send({ walletAddress: WALLET, category: "other", description: "short" });

    expect(res.status).toBe(400);
    expect(mockCreateDispute).not.toHaveBeenCalled();
  });

  test("400 when contractId has invalid format", async () => {
    const res = await request(app)
      .post("/api/v1/disputes")
      .send({
        walletAddress: WALLET,
        contractId: "not-a-contract-id",
        category: "wrong_amount",
        description: "Amount looks incorrect to me here.",
      });

    expect(res.status).toBe(400);
    expect(mockCreateDispute).not.toHaveBeenCalled();
  });
});

// ─── GET /api/v1/disputes ─────────────────────────────────────────────────────

describe("GET /api/v1/disputes", () => {
  beforeEach(() => jest.clearAllMocks());

  test("returns list of disputes for a wallet", async () => {
    mockGetDisputesByWallet.mockReturnValue([baseDispute()]);
    mockCountDisputesByWallet.mockReturnValue(1);

    const res = await request(app)
      .get(`/api/v1/disputes?walletAddress=${WALLET}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.pagination.total).toBe(1);
    expect(mockGetDisputesByWallet).toHaveBeenCalledWith(WALLET, { limit: 50, offset: 0 });
  });

  test("returns empty list when wallet has no disputes", async () => {
    mockGetDisputesByWallet.mockReturnValue([]);
    mockCountDisputesByWallet.mockReturnValue(0);

    const res = await request(app)
      .get(`/api/v1/disputes?walletAddress=${WALLET}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.pagination.total).toBe(0);
  });

  test("400 when walletAddress is missing", async () => {
    const res = await request(app).get("/api/v1/disputes");

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("missing_wallet_address");
    expect(mockGetDisputesByWallet).not.toHaveBeenCalled();
  });

  test("400 when walletAddress is malformed", async () => {
    const res = await request(app).get("/api/v1/disputes?walletAddress=not-valid");

    expect(res.status).toBe(400);
    expect(mockGetDisputesByWallet).not.toHaveBeenCalled();
  });

  test("respects limit and offset query params", async () => {
    mockGetDisputesByWallet.mockReturnValue([]);
    mockCountDisputesByWallet.mockReturnValue(0);

    const res = await request(app)
      .get(`/api/v1/disputes?walletAddress=${WALLET}&limit=10&offset=20`);

    expect(res.status).toBe(200);
    expect(mockGetDisputesByWallet).toHaveBeenCalledWith(WALLET, { limit: 10, offset: 20 });
  });
});

// ─── GET /api/v1/disputes/:ticketId ──────────────────────────────────────────

describe("GET /api/v1/disputes/:ticketId", () => {
  beforeEach(() => jest.clearAllMocks());

  test("returns a dispute with its comments", async () => {
    mockGetDisputeByTicketId.mockReturnValue(
      baseDispute({ comments: [baseComment({ author: "contributor" })] })
    );

    const res = await request(app).get(`/api/v1/disputes/${TICKET_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.data.ticketId).toBe(TICKET_ID);
    expect(res.body.data.comments).toHaveLength(1);
    expect(mockGetDisputeByTicketId).toHaveBeenCalledWith(TICKET_ID);
  });

  test("404 when ticket does not exist", async () => {
    mockGetDisputeByTicketId.mockReturnValue(null);

    const res = await request(app).get("/api/v1/disputes/DSP-UNKNOWN1");

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("dispute_not_found");
  });
});

// ─── POST /api/v1/disputes/:ticketId/comments (contributor) ──────────────────

describe("POST /api/v1/disputes/:ticketId/comments (contributor)", () => {
  beforeEach(() => jest.clearAllMocks());

  test("contributor adds a comment to their own dispute", async () => {
    mockGetDisputeByTicketId.mockReturnValue(baseDispute({ status: "under_review" }));
    mockAddDisputeComment.mockReturnValue(baseComment({ author: "contributor", message: "Still waiting." }));

    const res = await request(app)
      .post(`/api/v1/disputes/${TICKET_ID}/comments`)
      .send({ walletAddress: WALLET, message: "Still waiting." });

    expect(res.status).toBe(201);
    expect(res.body.data.author).toBe("contributor");
    expect(mockAddDisputeComment).toHaveBeenCalledWith(1, "contributor", "Still waiting.");
  });

  test("403 when wallet does not own the dispute", async () => {
    mockGetDisputeByTicketId.mockReturnValue(baseDispute());

    const res = await request(app)
      .post(`/api/v1/disputes/${TICKET_ID}/comments`)
      .send({ walletAddress: WALLET2, message: "Someone else commenting." });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("forbidden");
    expect(mockAddDisputeComment).not.toHaveBeenCalled();
  });

  test("409 when dispute is resolved", async () => {
    mockGetDisputeByTicketId.mockReturnValue(baseDispute({ status: "resolved" }));

    const res = await request(app)
      .post(`/api/v1/disputes/${TICKET_ID}/comments`)
      .send({ walletAddress: WALLET, message: "Trying to reopen this." });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("dispute_closed");
    expect(mockAddDisputeComment).not.toHaveBeenCalled();
  });

  test("409 when dispute is closed", async () => {
    mockGetDisputeByTicketId.mockReturnValue(baseDispute({ status: "closed" }));

    const res = await request(app)
      .post(`/api/v1/disputes/${TICKET_ID}/comments`)
      .send({ walletAddress: WALLET, message: "Trying to comment anyway." });

    expect(res.status).toBe(409);
    expect(mockAddDisputeComment).not.toHaveBeenCalled();
  });

  test("404 when ticket does not exist", async () => {
    mockGetDisputeByTicketId.mockReturnValue(null);

    const res = await request(app)
      .post("/api/v1/disputes/DSP-MISSING1/comments")
      .send({ walletAddress: WALLET, message: "Hello there comment." });

    expect(res.status).toBe(404);
    expect(mockAddDisputeComment).not.toHaveBeenCalled();
  });

  test("400 when message is empty", async () => {
    const res = await request(app)
      .post(`/api/v1/disputes/${TICKET_ID}/comments`)
      .send({ walletAddress: WALLET, message: "" });

    expect(res.status).toBe(400);
    expect(mockAddDisputeComment).not.toHaveBeenCalled();
  });

  test("400 when walletAddress is missing from body", async () => {
    const res = await request(app)
      .post(`/api/v1/disputes/${TICKET_ID}/comments`)
      .send({ message: "No wallet provided." });

    expect(res.status).toBe(400);
    expect(mockAddDisputeComment).not.toHaveBeenCalled();
  });
});

// ─── GET /api/v1/disputes/admin/all ──────────────────────────────────────────

describe("GET /api/v1/disputes/admin/all", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ADMIN_ROTATE_TOKEN = ADMIN_TOKEN;
  });

  test("admin lists all disputes", async () => {
    mockGetAllDisputes.mockReturnValue([baseDispute(), baseDispute({ id: 2, ticketId: "DSP-B1C2D3E4" })]);
    mockCountAllDisputes.mockReturnValue(2);

    const res = await request(app)
      .get("/api/v1/disputes/admin/all")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.pagination.total).toBe(2);
    expect(mockGetAllDisputes).toHaveBeenCalledWith({ limit: 50, offset: 0 });
  });

  test("admin filters disputes by status", async () => {
    mockGetAllDisputes.mockReturnValue([baseDispute({ status: "under_review" })]);
    mockCountAllDisputes.mockReturnValue(1);

    const res = await request(app)
      .get("/api/v1/disputes/admin/all?status=under_review")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(mockGetAllDisputes).toHaveBeenCalledWith({ status: "under_review", limit: 50, offset: 0 });
  });

  test("400 when status filter is invalid", async () => {
    const res = await request(app)
      .get("/api/v1/disputes/admin/all?status=invalid")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_status");
  });

  test("401 without admin token", async () => {
    const res = await request(app).get("/api/v1/disputes/admin/all");

    expect(res.status).toBe(401);
    expect(mockGetAllDisputes).not.toHaveBeenCalled();
  });

  test("401 with wrong admin token", async () => {
    const res = await request(app)
      .get("/api/v1/disputes/admin/all")
      .set("Authorization", "Bearer wrong-token");

    expect(res.status).toBe(401);
  });
});

// ─── PATCH /api/v1/disputes/admin/:ticketId/status ───────────────────────────

describe("PATCH /api/v1/disputes/admin/:ticketId/status", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ADMIN_ROTATE_TOKEN = ADMIN_TOKEN;
  });

  test("admin moves dispute to under_review", async () => {
    mockGetDisputeByTicketId.mockReturnValue(baseDispute());
    mockUpdateDisputeStatus.mockReturnValue(baseDispute({ status: "under_review" }));

    const res = await request(app)
      .patch(`/api/v1/disputes/admin/${TICKET_ID}/status`)
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ status: "under_review" });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("under_review");
    expect(mockUpdateDisputeStatus).toHaveBeenCalledWith(1, "under_review", undefined);
  });

  test("admin resolves dispute with a note", async () => {
    mockGetDisputeByTicketId.mockReturnValue(baseDispute({ status: "under_review" }));
    mockUpdateDisputeStatus.mockReturnValue(
      baseDispute({ status: "resolved", adminNote: "Confirmed and corrected." })
    );

    const res = await request(app)
      .patch(`/api/v1/disputes/admin/${TICKET_ID}/status`)
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ status: "resolved", adminNote: "Confirmed and corrected." });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("resolved");
    expect(res.body.data.adminNote).toBe("Confirmed and corrected.");
    expect(mockUpdateDisputeStatus).toHaveBeenCalledWith(1, "resolved", "Confirmed and corrected.");
  });

  test("admin closes a dispute", async () => {
    mockGetDisputeByTicketId.mockReturnValue(baseDispute({ status: "resolved" }));
    mockUpdateDisputeStatus.mockReturnValue(baseDispute({ status: "closed" }));

    const res = await request(app)
      .patch(`/api/v1/disputes/admin/${TICKET_ID}/status`)
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ status: "closed" });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("closed");
  });

  test("404 when ticket does not exist", async () => {
    mockGetDisputeByTicketId.mockReturnValue(null);

    const res = await request(app)
      .patch("/api/v1/disputes/admin/DSP-MISSING1/status")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ status: "resolved" });

    expect(res.status).toBe(404);
    expect(mockUpdateDisputeStatus).not.toHaveBeenCalled();
  });

  test("400 when status is invalid", async () => {
    const res = await request(app)
      .patch(`/api/v1/disputes/admin/${TICKET_ID}/status`)
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ status: "in_progress" });

    expect(res.status).toBe(400);
    expect(mockUpdateDisputeStatus).not.toHaveBeenCalled();
  });

  test("400 when status is missing from body", async () => {
    const res = await request(app)
      .patch(`/api/v1/disputes/admin/${TICKET_ID}/status`)
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ adminNote: "Note without status." });

    expect(res.status).toBe(400);
    expect(mockUpdateDisputeStatus).not.toHaveBeenCalled();
  });

  test("401 without token", async () => {
    const res = await request(app)
      .patch(`/api/v1/disputes/admin/${TICKET_ID}/status`)
      .send({ status: "resolved" });

    expect(res.status).toBe(401);
    expect(mockUpdateDisputeStatus).not.toHaveBeenCalled();
  });
});

// ─── POST /api/v1/disputes/admin/:ticketId/comments ──────────────────────────

describe("POST /api/v1/disputes/admin/:ticketId/comments", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ADMIN_ROTATE_TOKEN = ADMIN_TOKEN;
  });

  test("admin posts a comment on a dispute", async () => {
    mockGetDisputeByTicketId.mockReturnValue(baseDispute({ status: "under_review" }));
    mockAddDisputeComment.mockReturnValue(baseComment());

    const res = await request(app)
      .post(`/api/v1/disputes/admin/${TICKET_ID}/comments`)
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ message: "We are looking into this." });

    expect(res.status).toBe(201);
    expect(res.body.data.author).toBe("admin");
    expect(mockAddDisputeComment).toHaveBeenCalledWith(1, "admin", "We are looking into this.");
  });

  test("404 when ticket does not exist", async () => {
    mockGetDisputeByTicketId.mockReturnValue(null);

    const res = await request(app)
      .post("/api/v1/disputes/admin/DSP-MISSING1/comments")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ message: "Admin looking into it." });

    expect(res.status).toBe(404);
    expect(mockAddDisputeComment).not.toHaveBeenCalled();
  });

  test("400 when message is empty", async () => {
    const res = await request(app)
      .post(`/api/v1/disputes/admin/${TICKET_ID}/comments`)
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ message: "" });

    expect(res.status).toBe(400);
    expect(mockAddDisputeComment).not.toHaveBeenCalled();
  });

  test("401 without admin token", async () => {
    const res = await request(app)
      .post(`/api/v1/disputes/admin/${TICKET_ID}/comments`)
      .send({ message: "Unauthorized attempt." });

    expect(res.status).toBe(401);
    expect(mockAddDisputeComment).not.toHaveBeenCalled();
  });
});

// ─── Email notification integration ──────────────────────────────────────────

describe("Email notifications on status update", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ADMIN_ROTATE_TOKEN = ADMIN_TOKEN;
  });

  test("does not attempt email when SMTP is not configured", async () => {
    mockIsEmailConfigured.mockReturnValue(false);
    mockGetDisputeByTicketId.mockReturnValue(baseDispute());
    mockUpdateDisputeStatus.mockReturnValue(baseDispute({ status: "resolved" }));

    await request(app)
      .patch(`/api/v1/disputes/admin/${TICKET_ID}/status`)
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ status: "resolved" });

    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  test("sends email when SMTP is configured and subscriber exists", async () => {
    mockIsEmailConfigured.mockReturnValue(true);
    mockGetDisputeByTicketId.mockReturnValue(baseDispute());
    mockUpdateDisputeStatus.mockReturnValue(baseDispute({ status: "resolved" }));

    // Override the email-digest subscriber mock for this test only
    const { getSubscriberByWallet } = await import("../src/database/email-digest.js");
    getSubscriberByWallet.mockReturnValue({ email: "contributor@example.com" });

    await request(app)
      .patch(`/api/v1/disputes/admin/${TICKET_ID}/status`)
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ status: "resolved", adminNote: "All sorted." });

    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "contributor@example.com",
        subject: expect.stringContaining(TICKET_ID),
      })
    );
  });
});

// ─── Full ticket lifecycle integration test ───────────────────────────────────

describe("Ticket lifecycle (open → under_review → resolved → closed)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ADMIN_ROTATE_TOKEN = ADMIN_TOKEN;
    mockIsEmailConfigured.mockReturnValue(false);
  });

  test("full lifecycle progresses through all statuses", async () => {
    // 1. Contributor submits dispute
    mockCreateDispute.mockReturnValue(baseDispute());
    const submitRes = await request(app)
      .post("/api/v1/disputes")
      .send({
        walletAddress: WALLET,
        contractId: CONTRACT,
        category: "wrong_amount",
        description: "I received less than expected for the last distribution.",
      });
    expect(submitRes.status).toBe(201);
    expect(submitRes.body.data.status).toBe("open");

    // 2. Admin moves to under_review
    mockGetDisputeByTicketId.mockReturnValue(baseDispute());
    mockUpdateDisputeStatus.mockReturnValue(baseDispute({ status: "under_review" }));
    const reviewRes = await request(app)
      .patch(`/api/v1/disputes/admin/${TICKET_ID}/status`)
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ status: "under_review" });
    expect(reviewRes.status).toBe(200);
    expect(reviewRes.body.data.status).toBe("under_review");

    // 3. Admin posts a comment
    mockGetDisputeByTicketId.mockReturnValue(baseDispute({ status: "under_review" }));
    mockAddDisputeComment.mockReturnValue(baseComment());
    const commentRes = await request(app)
      .post(`/api/v1/disputes/admin/${TICKET_ID}/comments`)
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ message: "We are looking into this." });
    expect(commentRes.status).toBe(201);

    // 4. Admin resolves with note
    mockGetDisputeByTicketId.mockReturnValue(baseDispute({ status: "under_review" }));
    mockUpdateDisputeStatus.mockReturnValue(
      baseDispute({ status: "resolved", adminNote: "Corrected. Sending delta." })
    );
    const resolveRes = await request(app)
      .patch(`/api/v1/disputes/admin/${TICKET_ID}/status`)
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ status: "resolved", adminNote: "Corrected. Sending delta." });
    expect(resolveRes.status).toBe(200);
    expect(resolveRes.body.data.adminNote).toBe("Corrected. Sending delta.");

    // 5. Admin closes the ticket
    mockGetDisputeByTicketId.mockReturnValue(baseDispute({ status: "resolved" }));
    mockUpdateDisputeStatus.mockReturnValue(baseDispute({ status: "closed" }));
    const closeRes = await request(app)
      .patch(`/api/v1/disputes/admin/${TICKET_ID}/status`)
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ status: "closed" });
    expect(closeRes.status).toBe(200);
    expect(closeRes.body.data.status).toBe("closed");

    // 6. Contributor can no longer comment
    mockGetDisputeByTicketId.mockReturnValue(baseDispute({ status: "closed" }));
    const lateCommentRes = await request(app)
      .post(`/api/v1/disputes/${TICKET_ID}/comments`)
      .send({ walletAddress: WALLET, message: "Attempting after close." });
    expect(lateCommentRes.status).toBe(409);
    expect(lateCommentRes.body.code).toBe("dispute_closed");
  });
});
