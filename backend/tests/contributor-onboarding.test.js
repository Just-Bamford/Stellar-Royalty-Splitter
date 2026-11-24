import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import express from "express";

const TEST_WALLET = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFXYCZTM6W2XYFORCWA4V";
const INVALID_WALLET = "invalid-address-123";

let dbStore = {};

await jest.unstable_mockModule("../src/database.js", () => ({
  getContributorOnboarding: jest.fn((walletAddress) => {
    if (!walletAddress) return null;
    const record = dbStore[walletAddress];
    return {
      walletAddress,
      email: record?.email || "",
      kycStatus: record?.kycStatus || "pending",
      paymentPreferencesSet: record?.paymentPreferencesSet || 0,
      payoutToken: record?.payoutToken || "XLM",
      taxInfoSubmitted: record?.taxInfoSubmitted || 0,
      firstDistributionReceived: record?.firstDistributionReceived || 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }),
  upsertContributorOnboarding: jest.fn((walletAddress, data = {}) => {
    const existing = dbStore[walletAddress] || {};
    dbStore[walletAddress] = {
      ...existing,
      ...data,
      kycStatus: data.kycStatus !== undefined ? data.kycStatus : existing.kycStatus || "pending",
      paymentPreferencesSet:
        data.paymentPreferencesSet !== undefined
          ? data.paymentPreferencesSet
            ? 1
            : 0
          : existing.paymentPreferencesSet || 0,
      taxInfoSubmitted:
        data.taxInfoSubmitted !== undefined
          ? data.taxInfoSubmitted
            ? 1
            : 0
          : existing.taxInfoSubmitted || 0,
      firstDistributionReceived:
        data.firstDistributionReceived !== undefined
          ? data.firstDistributionReceived
            ? 1
            : 0
          : existing.firstDistributionReceived || 0,
    };
    return dbStore[walletAddress];
  }),
  countWrite: jest.fn(),
}));

await jest.unstable_mockModule("../src/email-template.js", () => ({
  renderOnboardingReminderEmail: jest.fn((payload) => ({
    subject: "Action Required: Onboarding Checklist Progress",
    text: `CHECKLIST SUMMARY: ${payload.completionPercentage}%`,
    incompleteCount: payload.items.filter((i) => !i.completed).length,
  })),
}));

await jest.unstable_mockModule("../src/logger.js", () => ({
  default: {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

await jest.unstable_mockModule("../src/error-response.js", () => ({
  sendError: jest.fn((res, status, code, msg) => {
    return res.status(status).json({ error: msg, code });
  }),
  sendValidationError: jest.fn((res, issues) => {
    const firstIssue = issues[0];
    return res.status(400).json({ error: firstIssue.message || "Validation failed" });
  }),
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

const onboardingRouter = (await import("../src/routes/onboarding.js")).default;

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  if (req.headers["x-user-wallet"]) {
    req.user = { walletAddress: req.headers["x-user-wallet"] };
  }
  next();
});
app.use("/api/v1/onboarding", onboardingRouter);

describe("Contributor Onboarding Router (#567)", () => {
  beforeEach(() => {
    dbStore = {};
  });

  test("GET /api/v1/onboarding/:walletAddress returns initial onboarding status (20% complete with wallet connected)", async () => {
    const res = await request(app).get(`/api/v1/onboarding/${TEST_WALLET}`);

    expect(res.status).toBe(200);
    expect(res.body.walletAddress).toBe(TEST_WALLET);
    expect(res.body.totalCount).toBe(5);
    expect(res.body.completedCount).toBe(1); // Wallet connected
    expect(res.body.completionPercentage).toBe(20);
    expect(res.body.requiredComplete).toBe(false);
    expect(res.body.actionsLocked).toBe(true);
    expect(res.body.nextStep).toEqual({
      id: "kyc_verified",
      label: "KYC verified",
      description: "Complete identity verification for protocol compliance.",
    });
  });

  test("GET /api/v1/onboarding/:walletAddress returns 400 for invalid wallet address", async () => {
    const res = await request(app).get(`/api/v1/onboarding/${INVALID_WALLET}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid Stellar wallet address format");
  });

  test("PATCH /api/v1/onboarding/:walletAddress updates status to 60% complete", async () => {
    const res = await request(app).patch(`/api/v1/onboarding/${TEST_WALLET}`).send({
      email: "contributor@example.com",
      paymentPreferencesSet: true,
      payoutToken: "USDC",
    });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Contributor onboarding checklist updated successfully");
    expect(res.body.summary.email).toBe("contributor@example.com");
    expect(res.body.summary.paymentPreferencesSet).toBe(true);
    expect(res.body.summary.payoutToken).toBe("USDC");
    // Completed: Wallet connected + Payment preferences set = 2 out of 5 = 40%
    expect(res.body.summary.completionPercentage).toBe(40);
  });

  test("PATCH /api/v1/onboarding/:walletAddress completes required items (100% complete state)", async () => {
    const res = await request(app).patch(`/api/v1/onboarding/${TEST_WALLET}`).send({
      email: "contributor@example.com",
      kycStatus: "verified",
      paymentPreferencesSet: true,
      taxInfoSubmitted: true,
    });

    expect(res.status).toBe(200);
    expect(res.body.summary.requiredComplete).toBe(true);
    expect(res.body.summary.actionsLocked).toBe(false);

    // Also mark first distribution received
    dbStore[TEST_WALLET].firstDistributionReceived = 1;
    const res2 = await request(app).get(`/api/v1/onboarding/${TEST_WALLET}`);
    expect(res2.body.completionPercentage).toBe(100);
    expect(res2.body.completedCount).toBe(5);
    expect(res2.body.nextStep).toBeNull();
  });

  test("PATCH /api/v1/onboarding/:walletAddress returns 400 for invalid email", async () => {
    const res = await request(app).patch(`/api/v1/onboarding/${TEST_WALLET}`).send({
      email: "invalid-email",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid email address format");
  });

  test("POST /api/v1/onboarding/:walletAddress/remind sends email reminder", async () => {
    const res = await request(app).post(`/api/v1/onboarding/${TEST_WALLET}/remind`).send({
      email: "contributor@example.com",
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.emailDetails.to).toBe("contributor@example.com");
    expect(res.body.emailDetails.subject).toContain("Action Required");
    expect(res.body.emailDetails.previewText).toContain("CHECKLIST SUMMARY:");
  });

  test("POST /api/v1/onboarding/:walletAddress/remind returns 400 for missing email", async () => {
    const res = await request(app).post(`/api/v1/onboarding/${TEST_WALLET}/remind`).send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Valid email is required for reminder");
  });

  test("PATCH /api/v1/onboarding/:walletAddress returns 403 when requesting wallet does not match auth context (Option B)", async () => {
    const OTHER_WALLET = "GCKFJ2V347BMS4GJUX757Q4NO2Y6CQGZ7V4G3V3B7V6Q5M3B3M3B3M3B";
    const res = await request(app)
      .patch(`/api/v1/onboarding/${TEST_WALLET}`)
      .set("x-user-wallet", OTHER_WALLET)
      .send({
        email: "attacker@example.com",
      });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("forbidden");
  });

  test("PUT /api/v1/onboarding/:walletAddress returns 403 when non-owner attempts update via x-wallet-address", async () => {
    const OTHER_WALLET = "GCKFJ2V347BMS4GJUX757Q4NO2Y6CQGZ7V4G3V3B7V6Q5M3B3M3B3M3B";
    const res = await request(app)
      .put(`/api/v1/onboarding/${TEST_WALLET}`)
      .set("x-wallet-address", OTHER_WALLET)
      .send({
        email: "attacker@example.com",
      });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("forbidden");
  });

  test("PUT /api/v1/onboarding/:walletAddress allows owner to update onboarding record", async () => {
    const res = await request(app)
      .put(`/api/v1/onboarding/${TEST_WALLET}`)
      .set("x-user-wallet", TEST_WALLET)
      .send({
        email: "contributor@example.com",
        paymentPreferencesSet: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.summary.email).toBe("contributor@example.com");
  });
});
