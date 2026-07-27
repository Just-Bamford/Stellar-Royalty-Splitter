/**
 * Tests for KYC Webhook integration (#598).
 */
import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import crypto from "crypto";

// --- Mocks ---
const mockUpsertKycStatus = jest.fn();
const mockGetKycStatus = jest.fn();
const mockLogKycEvent = jest.fn();
const mockGetKycEvents = jest.fn();
const mockGetAllKycEvents = jest.fn();
const mockAddAuditLog = jest.fn();
const mockUpsertContributorOnboarding = jest.fn();

await jest.unstable_mockModule("../src/database/kyc.js", () => ({
  upsertKycStatus: mockUpsertKycStatus,
  getKycStatus: mockGetKycStatus,
  logKycEvent: mockLogKycEvent,
  getKycEvents: mockGetKycEvents,
  getAllKycEvents: mockGetAllKycEvents,
}));

await jest.unstable_mockModule("../src/database/audit.js", () => ({
  addAuditLog: mockAddAuditLog,
}));

await jest.unstable_mockModule("../src/database.js", () => ({
  upsertContributorOnboarding: mockUpsertContributorOnboarding,
  getContributorOnboarding: jest.fn(() => ({})),
}));

await jest.unstable_mockModule("../src/database/index.js", () => ({
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 11),
}));

import express from "express";
const { kycWebhooksRouter } = await import("../src/routes/kyc-webhooks.js");

const app = express();
// Note: do NOT attach express.json() globally — the Veriff route uses its own rawBodyCapture
app.use("/api/v1/kyc", kycWebhooksRouter);
app.use((err, _req, res, _next) => {
  res.status(500).json({ error: err.message ?? "Internal error" });
});

// Valid 56-char Stellar wallet (G + 55 base32 chars)
const WALLET = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

beforeEach(() => {
  jest.clearAllMocks();
  mockLogKycEvent.mockReturnValue(42);
  mockUpsertKycStatus.mockReturnValue({
    walletAddress: WALLET,
    verification_status: "verified",
    provider: "veriff",
  });
  mockGetKycStatus.mockReturnValue({
    walletAddress: WALLET,
    verification_status: "verified",
    provider: "veriff",
    provider_session_id: "abc",
    updated_at: "2026-01-01",
  });
  mockGetKycEvents.mockReturnValue([]);
  mockGetAllKycEvents.mockReturnValue([]);
  delete process.env.KYC_VERIFF_SECRET;
  delete process.env.KYC_JUMIO_CALLBACK_SECRET;
  delete process.env.NODE_ENV;
});

// ---------------------------------------------------------------------------
// Veriff webhook
// ---------------------------------------------------------------------------

describe("POST /api/v1/kyc/webhook/veriff", () => {
  // Helper: send raw body to the Veriff endpoint
  function postVeriff(body, extraHeaders = {}) {
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    return request(app)
      .post("/api/v1/kyc/webhook/veriff")
      .set("Content-Type", "application/octet-stream")
      .set(extraHeaders)
      .send(Buffer.from(raw));
  }

  test("accepts approved payload and maps to verified", async () => {
    const payload = {
      verification: { id: "session-123", status: "approved", vendorData: WALLET },
    };
    const res = await postVeriff(payload);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.resolvedStatus).toBe("verified");
    expect(mockLogKycEvent).toHaveBeenCalledWith(
      "veriff", "approved", WALLET, expect.any(String), "verified"
    );
    expect(mockUpsertKycStatus).toHaveBeenCalledWith(WALLET, "verified", "veriff", "session-123");
  });

  test("maps 'declined' to 'rejected'", async () => {
    const res = await postVeriff({
      verification: { id: "s2", status: "declined", vendorData: WALLET },
    });
    expect(res.status).toBe(200);
    expect(res.body.resolvedStatus).toBe("rejected");
  });

  test("maps 'review' to 'pending'", async () => {
    const res = await postVeriff({
      verification: { id: "s3", status: "review", vendorData: WALLET },
    });
    expect(res.status).toBe(200);
    expect(res.body.resolvedStatus).toBe("pending");
  });

  test("maps 'expired' to 'expired'", async () => {
    const res = await postVeriff({
      verification: { id: "s4", status: "expired", vendorData: WALLET },
    });
    expect(res.status).toBe(200);
    expect(res.body.resolvedStatus).toBe("expired");
  });

  test("handles missing wallet address gracefully (logs but does not update KYC)", async () => {
    const res = await postVeriff({
      verification: { id: "s-no-wallet", status: "approved" },
    });
    expect(res.status).toBe(200);
    expect(res.body.note).toBe("wallet_address_unresolved");
    expect(mockUpsertKycStatus).not.toHaveBeenCalled();
  });

  test("rejects invalid HMAC signature in production", async () => {
    process.env.NODE_ENV = "production";
    process.env.KYC_VERIFF_SECRET = "test-secret";
    const res = await postVeriff(
      { verification: { status: "approved", vendorData: WALLET } },
      { "x-hmac-signature": "0000000000000000000000000000000000000000000000000000000000000000" }
    );
    expect(res.status).toBe(401);
    delete process.env.NODE_ENV;
    delete process.env.KYC_VERIFF_SECRET;
  });

  test("accepts payload with valid HMAC signature", async () => {
    const secret = "test-secret";
    process.env.KYC_VERIFF_SECRET = secret;
    const body = JSON.stringify({
      verification: { id: "s-signed", status: "approved", vendorData: WALLET },
    });
    const sig = crypto.createHmac("sha256", secret).update(body).digest("hex");
    const res = await postVeriff(body, { "x-hmac-signature": sig });
    expect(res.status).toBe(200);
    expect(res.body.resolvedStatus).toBe("verified");
    delete process.env.KYC_VERIFF_SECRET;
  });

  test("logs kyc_status_updated to audit trail", async () => {
    await postVeriff({ verification: { status: "approved", vendorData: WALLET } });
    expect(mockAddAuditLog).toHaveBeenCalledWith(
      "system",
      "kyc_status_updated",
      "veriff-webhook",
      expect.objectContaining({ walletAddress: WALLET, resolvedStatus: "verified" })
    );
  });

  test("syncs KYC status to onboarding checklist", async () => {
    await postVeriff({ verification: { status: "approved", vendorData: WALLET } });
    expect(mockUpsertContributorOnboarding).toHaveBeenCalledWith(
      WALLET,
      expect.objectContaining({ kycStatus: "verified" })
    );
  });
});

// ---------------------------------------------------------------------------
// Jumio webhook
// ---------------------------------------------------------------------------

describe("POST /api/v1/kyc/webhook/jumio", () => {
  test("accepts APPROVED_VERIFIED and maps to verified", async () => {
    const res = await request(app)
      .post("/api/v1/kyc/webhook/jumio")
      .send({
        jumioIdScanReference: "jumio-001",
        merchantIdScanReference: WALLET,
        verificationStatus: "APPROVED_VERIFIED",
        idScanStatus: "SUCCESS",
      });
    expect(res.status).toBe(200);
    expect(res.body.resolvedStatus).toBe("verified");
    expect(mockUpsertKycStatus).toHaveBeenCalledWith(WALLET, "verified", "jumio", "jumio-001");
  });

  test("maps DENIED_FRAUD to rejected", async () => {
    const res = await request(app)
      .post("/api/v1/kyc/webhook/jumio")
      .send({
        jumioIdScanReference: "jumio-002",
        merchantIdScanReference: WALLET,
        verificationStatus: "DENIED_FRAUD",
        idScanStatus: "FAILED",
      });
    expect(res.status).toBe(200);
    expect(res.body.resolvedStatus).toBe("rejected");
  });

  test("rejects unauthorized request in production", async () => {
    process.env.NODE_ENV = "production";
    process.env.KYC_JUMIO_CALLBACK_SECRET = "secure-token";
    const res = await request(app)
      .post("/api/v1/kyc/webhook/jumio")
      .send({ merchantIdScanReference: WALLET, verificationStatus: "APPROVED_VERIFIED" });
    expect(res.status).toBe(401);
    delete process.env.NODE_ENV;
    delete process.env.KYC_JUMIO_CALLBACK_SECRET;
  });

  test("accepts request with correct Basic Auth", async () => {
    process.env.KYC_JUMIO_CALLBACK_SECRET = "secure-token";
    const token = Buffer.from("secure-token").toString("base64");
    const res = await request(app)
      .post("/api/v1/kyc/webhook/jumio")
      .set("Authorization", `Basic ${token}`)
      .send({
        jumioIdScanReference: "jumio-003",
        merchantIdScanReference: WALLET,
        verificationStatus: "APPROVED_VERIFIED",
        idScanStatus: "SUCCESS",
      });
    expect(res.status).toBe(200);
    expect(res.body.resolvedStatus).toBe("verified");
    delete process.env.KYC_JUMIO_CALLBACK_SECRET;
  });

  test("handles missing wallet address gracefully", async () => {
    const res = await request(app)
      .post("/api/v1/kyc/webhook/jumio")
      .send({ jumioIdScanReference: "j-no-wallet", verificationStatus: "APPROVED_VERIFIED" });
    expect(res.status).toBe(200);
    expect(res.body.note).toBe("wallet_address_unresolved");
    expect(mockUpsertKycStatus).not.toHaveBeenCalled();
  });

  test("logs event to kyc_events table", async () => {
    await request(app)
      .post("/api/v1/kyc/webhook/jumio")
      .send({
        jumioIdScanReference: "jumio-004",
        merchantIdScanReference: WALLET,
        verificationStatus: "APPROVED_VERIFIED",
        idScanStatus: "SUCCESS",
      });
    expect(mockLogKycEvent).toHaveBeenCalledWith(
      "jumio",
      expect.any(String),
      WALLET,
      expect.any(String),
      "verified"
    );
  });
});

// ---------------------------------------------------------------------------
// GET /status/:walletAddress
// ---------------------------------------------------------------------------

describe("GET /api/v1/kyc/status/:walletAddress", () => {
  test("returns KYC status for a valid wallet", async () => {
    const res = await request(app).get(`/api/v1/kyc/status/${WALLET}`);
    expect(res.status).toBe(200);
    expect(res.body.data.verification_status).toBe("verified");
    expect(res.body.data.recentEvents).toEqual([]);
  });

  test("returns not_started when no record exists", async () => {
    mockGetKycStatus.mockReturnValue(null);
    const res = await request(app).get(`/api/v1/kyc/status/${WALLET}`);
    expect(res.status).toBe(200);
    expect(res.body.data.verification_status).toBe("not_started");
  });

  test("rejects invalid wallet address", async () => {
    const res = await request(app).get("/api/v1/kyc/status/INVALID_ADDRESS");
    expect(res.status).toBe(400);
  });

  test("includes recent events in response", async () => {
    mockGetKycEvents.mockReturnValue([
      { id: 1, provider: "veriff", event_type: "approved", resolved_status: "verified", created_at: "2026-01-01" },
    ]);
    const res = await request(app).get(`/api/v1/kyc/status/${WALLET}`);
    expect(res.body.data.recentEvents).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// GET /events
// ---------------------------------------------------------------------------

describe("GET /api/v1/kyc/events", () => {
  test("returns all KYC events", async () => {
    mockGetAllKycEvents.mockReturnValue([
      { id: 1, provider: "veriff", event_type: "approved", walletAddress: WALLET, resolved_status: "verified" },
    ]);
    const res = await request(app).get("/api/v1/kyc/events");
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.pagination).toBeDefined();
  });

  test("passes limit and offset to DB", async () => {
    await request(app).get("/api/v1/kyc/events?limit=10&offset=5");
    expect(mockGetAllKycEvents).toHaveBeenCalledWith(10, 5);
  });

  test("clamps limit to max 200", async () => {
    await request(app).get("/api/v1/kyc/events?limit=999");
    expect(mockGetAllKycEvents).toHaveBeenCalledWith(200, 0);
  });
});

// ---------------------------------------------------------------------------
// Status mapping unit tests
// ---------------------------------------------------------------------------

describe("Veriff status mapping", () => {
  function postVeriff(body) {
    const raw = JSON.stringify(body);
    return request(app)
      .post("/api/v1/kyc/webhook/veriff")
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.from(raw));
  }

  const cases = [
    ["approved", "verified"],
    ["declined", "rejected"],
    ["resubmission_requested", "pending"],
    ["review", "pending"],
    ["started", "pending"],
    ["expired", "expired"],
    ["unknown_value", "pending"],
  ];

  for (const [input, expected] of cases) {
    test(`'${input}' maps to '${expected}'`, async () => {
      const res = await postVeriff({ verification: { status: input, vendorData: WALLET } });
      expect(res.body.resolvedStatus).toBe(expected);
    });
  }
});
