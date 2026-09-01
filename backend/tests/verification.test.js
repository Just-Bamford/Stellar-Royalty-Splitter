/**
 * Tests for contributor verification workflow routes — closes #602.
 */
import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import express from "express";

const mockGetVerification      = jest.fn();
const mockUpsertVerification   = jest.fn();
const mockGetVerificationsByStep = jest.fn();

await jest.unstable_mockModule("../src/database/contributor-verification.js", () => ({
  getVerification:         mockGetVerification,
  upsertVerification:      mockUpsertVerification,
  getVerificationsByStep:  mockGetVerificationsByStep,
  VERIFICATION_STEPS:      ["email", "kyc", "manual_review", "verified", "rejected"],
  VERIFICATION_STATUSES:   ["pending", "in_progress", "completed", "failed"],
}));

await jest.unstable_mockModule("../src/database/index.js", () => ({
  getVerification:         mockGetVerification,
  upsertVerification:      mockUpsertVerification,
  getVerificationsByStep:  mockGetVerificationsByStep,
  VERIFICATION_STEPS:      ["email", "kyc", "manual_review", "verified", "rejected"],
  VERIFICATION_STATUSES:   ["pending", "in_progress", "completed", "failed"],
  initializeDatabase:      jest.fn(),
  getMigrationVersion:     jest.fn(() => 12),
}));

const { verificationRouter } = await import("../src/routes/verification.js");

const app = express();
app.use(express.json());
app.use("/api/v1/verification", verificationRouter);
app.use((err, _req, res, _next) => {
  res.status(500).json({ error: err.message ?? "Internal server error" });
});

const WALLET    = "GA7E6YDRQKJ2JNOG27UPSCQ3FQ6U4X3QQGJKHNGF23T7QCI2FM6E3W2P";
const TIMESTAMP = "2026-07-27T10:00:00.000Z";

const verRecord = (overrides = {}) => ({
  walletAddress: WALLET,
  step:      "email",
  status:    "pending",
  adminNote: null,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
  ...overrides,
});

describe("GET /api/v1/verification/:walletAddress", () => {
  beforeEach(() => jest.clearAllMocks());

  test("returns the verification record", async () => {
    mockGetVerification.mockReturnValue(verRecord());

    const res = await request(app).get(`/api/v1/verification/${WALLET}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.step).toBe("email");
    expect(mockGetVerification).toHaveBeenCalledWith(WALLET);
  });

  test("404 when no record exists", async () => {
    mockGetVerification.mockReturnValue(null);

    const res = await request(app).get(`/api/v1/verification/${WALLET}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("verification_not_found");
  });

  test("400 when walletAddress is invalid", async () => {
    const res = await request(app).get("/api/v1/verification/bad-address");

    expect(res.status).toBe(400);
    expect(mockGetVerification).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/verification/start", () => {
  beforeEach(() => jest.clearAllMocks());

  test("creates a new verification record at email/pending", async () => {
    mockGetVerification.mockReturnValue(null);
    mockUpsertVerification.mockReturnValue(verRecord());

    const res = await request(app)
      .post("/api/v1/verification/start")
      .send({ walletAddress: WALLET });

    expect(res.status).toBe(201);
    expect(res.body.data.step).toBe("email");
    expect(res.body.data.status).toBe("pending");
    expect(mockUpsertVerification).toHaveBeenCalledWith(WALLET, "email", "pending");
  });

  test("is idempotent — returns existing record if already started", async () => {
    mockGetVerification.mockReturnValue(verRecord({ step: "kyc", status: "in_progress" }));

    const res = await request(app)
      .post("/api/v1/verification/start")
      .send({ walletAddress: WALLET });

    expect(res.status).toBe(200);
    expect(res.body.data.step).toBe("kyc");
    expect(mockUpsertVerification).not.toHaveBeenCalled();
  });

  test("400 when walletAddress is missing", async () => {
    const res = await request(app)
      .post("/api/v1/verification/start")
      .send({});

    expect(res.status).toBe(400);
    expect(mockUpsertVerification).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/verification/advance", () => {
  beforeEach(() => jest.clearAllMocks());

  test("advances step and returns updated record", async () => {
    mockUpsertVerification.mockReturnValue(verRecord({ step: "kyc", status: "in_progress" }));

    const res = await request(app)
      .post("/api/v1/verification/advance")
      .send({ walletAddress: WALLET, step: "kyc", status: "in_progress" });

    expect(res.status).toBe(200);
    expect(res.body.data.step).toBe("kyc");
    expect(mockUpsertVerification).toHaveBeenCalledWith(WALLET, "kyc", "in_progress", null);
  });

  test("stores adminNote when provided", async () => {
    mockUpsertVerification.mockReturnValue(
      verRecord({ step: "rejected", status: "failed", adminNote: "Docs expired" })
    );

    const res = await request(app)
      .post("/api/v1/verification/advance")
      .send({ walletAddress: WALLET, step: "rejected", status: "failed", adminNote: "Docs expired" });

    expect(res.status).toBe(200);
    expect(mockUpsertVerification).toHaveBeenCalledWith(WALLET, "rejected", "failed", "Docs expired");
  });

  test("400 when step is invalid", async () => {
    const res = await request(app)
      .post("/api/v1/verification/advance")
      .send({ walletAddress: WALLET, step: "unknown_step", status: "pending" });

    expect(res.status).toBe(400);
    expect(mockUpsertVerification).not.toHaveBeenCalled();
  });

  test("400 when status is invalid", async () => {
    const res = await request(app)
      .post("/api/v1/verification/advance")
      .send({ walletAddress: WALLET, step: "kyc", status: "not_a_status" });

    expect(res.status).toBe(400);
  });
});

describe("GET /api/v1/verification/queue/:step", () => {
  beforeEach(() => jest.clearAllMocks());

  test("returns contributors waiting at a given step", async () => {
    mockGetVerificationsByStep.mockReturnValue([verRecord({ step: "manual_review" })]);

    const res = await request(app).get("/api/v1/verification/queue/manual_review");

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(mockGetVerificationsByStep).toHaveBeenCalledWith("manual_review", 50, 0);
  });

  test("400 when step is not a valid value", async () => {
    const res = await request(app).get("/api/v1/verification/queue/not_a_step");

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_step");
    expect(mockGetVerificationsByStep).not.toHaveBeenCalled();
  });
});
