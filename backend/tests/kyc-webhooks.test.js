import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockRecordKycEvent = jest.fn();
const mockGetKycEventsByWallet = jest.fn();
const mockCountKycEventsByWallet = jest.fn();
const mockUpsertVerification = jest.fn();
const mockAddAuditLog = jest.fn();

await jest.unstable_mockModule("../src/database/index.js", () => ({
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 13),
  recordKycEvent: mockRecordKycEvent,
  getKycEventsByWallet: mockGetKycEventsByWallet,
  countKycEventsByWallet: mockCountKycEventsByWallet,
  upsertVerification: mockUpsertVerification,
  addAuditLog: mockAddAuditLog,
  KYC_PROVIDERS: ["veriff", "jumio"],
}));

await jest.unstable_mockModule("../src/middleware/rbac.js", () => ({
  attachRole: (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
  ROLES: ["viewer", "collaborator", "operator", "admin"],
}));

const express = (await import("express")).default;
const { kycWebhooksRouter } = await import("../src/routes/kyc-webhooks.js");

const app = express();
// Don't use express.json() globally - the router has its own body capture middleware
// app.use(express.json());
app.use("/api/v1/kyc", kycWebhooksRouter);

const VALID_WALLET = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

// ─── Veriff webhook ────────────────────────────────────────────────────────────

describe("POST /api/v1/kyc/webhook/veriff", () => {
  beforeEach(() => jest.clearAllMocks());

  const veriffApproved = {
    verification: {
      id: "veriff-session-123",
      status: "approved",
      vendorData: VALID_WALLET,
    },
  };

  test("returns 200 and updates verification on approved callback", async () => {
    mockRecordKycEvent.mockReturnValue(1);
    mockUpsertVerification.mockReturnValue({
      walletAddress: VALID_WALLET,
      step: "verified",
      status: "completed",
    });

    const res = await request(app).post("/api/v1/kyc/webhook/veriff").send(veriffApproved);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.outcome).toBe("approved");
    expect(res.body.data.provider).toBe("veriff");
    expect(res.body.data.providerSessionId).toBe("veriff-session-123");
    expect(mockRecordKycEvent).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "veriff", outcome: "approved" })
    );
    expect(mockUpsertVerification).toHaveBeenCalledWith(
      VALID_WALLET,
      "verified",
      "completed",
      expect.stringContaining("approved")
    );
    expect(mockAddAuditLog).toHaveBeenCalledWith(
      "SYSTEM",
      "kyc_verification_updated",
      VALID_WALLET,
      expect.objectContaining({ provider: "veriff", outcome: "approved" })
    );
  });

  test("maps declined to rejected step", async () => {
    mockRecordKycEvent.mockReturnValue(2);
    mockUpsertVerification.mockReturnValue({
      walletAddress: VALID_WALLET,
      step: "rejected",
      status: "failed",
    });

    const payload = {
      verification: { id: "session-456", status: "declined", vendorData: VALID_WALLET },
    };

    const res = await request(app).post("/api/v1/kyc/webhook/veriff").send(payload);
    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe("declined");
    expect(mockUpsertVerification).toHaveBeenCalledWith(
      VALID_WALLET,
      "rejected",
      "failed",
      expect.any(String)
    );
  });

  test("maps resubmission_requested to kyc/failed step", async () => {
    mockRecordKycEvent.mockReturnValue(3);
    mockUpsertVerification.mockReturnValue({
      walletAddress: VALID_WALLET,
      step: "kyc",
      status: "failed",
    });

    const payload = {
      verification: {
        id: "session-789",
        status: "resubmission_requested",
        vendorData: VALID_WALLET,
      },
    };

    const res = await request(app).post("/api/v1/kyc/webhook/veriff").send(payload);
    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe("resubmission_requested");
  });

  test("still persists event when wallet address is absent", async () => {
    mockRecordKycEvent.mockReturnValue(4);

    const payload = {
      verification: { id: "session-no-wallet", status: "approved" },
    };

    const res = await request(app).post("/api/v1/kyc/webhook/veriff").send(payload);
    expect(res.status).toBe(200);
    expect(res.body.data.walletAddress).toBeNull();
    expect(mockUpsertVerification).not.toHaveBeenCalled();
  });

  test("returns 400 for malformed Veriff payload", async () => {
    const res = await request(app).post("/api/v1/kyc/webhook/veriff").send({ foo: "bar" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_payload");
  });

  test("returns 400 for unsupported provider", async () => {
    const res = await request(app).post("/api/v1/kyc/webhook/unknown").send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("unsupported_provider");
  });
});

// ─── Jumio webhook ─────────────────────────────────────────────────────────────

describe("POST /api/v1/kyc/webhook/jumio", () => {
  beforeEach(() => jest.clearAllMocks());

  const jumioApproved = {
    jumioIdScanReference: "jumio-ref-001",
    verificationStatus: "APPROVED_VERIFIED",
    customerInternalReference: VALID_WALLET,
  };

  test("returns 200 on approved Jumio callback", async () => {
    mockRecordKycEvent.mockReturnValue(10);
    mockUpsertVerification.mockReturnValue({
      walletAddress: VALID_WALLET,
      step: "verified",
      status: "completed",
    });

    const res = await request(app).post("/api/v1/kyc/webhook/jumio").send(jumioApproved);
    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe("approved");
    expect(res.body.data.provider).toBe("jumio");
  });

  test("maps DENIED_FRAUD to declined", async () => {
    mockRecordKycEvent.mockReturnValue(11);
    mockUpsertVerification.mockReturnValue({
      walletAddress: VALID_WALLET,
      step: "rejected",
      status: "failed",
    });

    const payload = {
      jumioIdScanReference: "jumio-ref-002",
      verificationStatus: "DENIED_FRAUD",
      customerInternalReference: VALID_WALLET,
    };

    const res = await request(app).post("/api/v1/kyc/webhook/jumio").send(payload);
    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe("declined");
  });

  test("returns 400 for malformed Jumio payload", async () => {
    const res = await request(app).post("/api/v1/kyc/webhook/jumio").send({ bad: "payload" });
    expect(res.status).toBe(400);
  });
});

// ─── GET KYC events ───────────────────────────────────────────────────────────

describe("GET /api/v1/kyc/events/:walletAddress", () => {
  beforeEach(() => jest.clearAllMocks());

  test("returns paginated KYC event history", async () => {
    mockGetKycEventsByWallet.mockReturnValue([
      {
        id: 1,
        provider: "veriff",
        providerSessionId: "s1",
        walletAddress: VALID_WALLET,
        outcome: "approved",
        rawPayload: '{"verification":{"id":"s1","status":"approved"}}',
        receivedAt: "2026-01-01T00:00:00Z",
      },
    ]);
    mockCountKycEventsByWallet.mockReturnValue(1);

    const res = await request(app).get(`/api/v1/kyc/events/${VALID_WALLET}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.pagination.total).toBe(1);
  });

  test("returns 400 for invalid wallet address", async () => {
    const res = await request(app).get("/api/v1/kyc/events/INVALID_ADDRESS");
    expect(res.status).toBe(400);
  });
});
