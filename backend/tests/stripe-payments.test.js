/**
 * Route-level tests for the Stripe payment endpoints — closes #924.
 *
 * Persistence, the Stripe service wrapper, the price oracle, and the SMS
 * notification dispatch are all mocked so these tests cover request
 * validation, orchestration, and response shaping without a network or
 * database. Mirrors the mocking approach used by `tests/crm-salesforce.test.js`
 * (#939) for the equivalent Salesforce route tests.
 *
 * Covers the issue's own named E2E acceptance scenario: "request payout,
 * verify Stripe API called with correct amount" (see the payout-request
 * describe block below) — fully achievable locally with mocks.
 */
import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import express from "express";

const WALLET = "GA7E6YDRQKJ2JNOG27UPSCQ3FQ6U4X3QQGJKHNGF23T7QCI2FM6E3W2P";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const dbStore = {
  getStripeAccount: jest.fn(),
  saveStripeAccount: jest.fn(),
  recordStripePayout: jest.fn(),
  getStripePayoutById: jest.fn(),
  getStripePayoutByStripeId: jest.fn(),
  listStripePayoutsByWallet: jest.fn(),
  setStripePayoutExternalId: jest.fn(),
  markStripePayoutFailedById: jest.fn(),
  updateStripePayoutStatusByStripeId: jest.fn(),
  hasProcessedStripeWebhookEvent: jest.fn(),
  recordStripeWebhookEvent: jest.fn(),
};

const stripeService = {
  isStripeConfigured: jest.fn(),
  buildConnectOAuthUrl: jest.fn(),
  verifyConnectState: jest.fn(),
  exchangeConnectCode: jest.fn(),
  createStripePayout: jest.fn(),
  verifyStripeWebhookSignature: jest.fn(),
};

const mockGetXlmUsdPrice = jest.fn();
const mockSendEventSms = jest.fn();

await jest.unstable_mockModule("../src/database/stripe-payouts.js", () => dbStore);

await jest.unstable_mockModule("../src/services/stripe.js", () => stripeService);

await jest.unstable_mockModule("../src/services/price-oracle.js", () => ({
  getXlmUsdPrice: mockGetXlmUsdPrice,
  xlmToUsdCents: (amount, rate) => Math.round(Number(amount) * rate * 100),
}));

await jest.unstable_mockModule("../src/services/sms-notifications.js", () => ({
  sendEventSms: mockSendEventSms,
}));

await jest.unstable_mockModule("../src/middleware/rbac.js", () => ({
  attachRole: (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
  ROLES: ["viewer", "collaborator", "operator", "admin"],
}));

const { stripeRouter } = await import("../src/routes/payments/stripe.js");
const { errorHandler } = await import("../src/error-response.js");

const app = express();
// Match index.js's global body-parsing middleware: capture the raw bytes via
// the `verify` hook so the webhook route can read req.rawBody, the same way
// the real app's express.json() does (see src/index.js).
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  })
);
app.use("/api/v1/payments/stripe", stripeRouter);
app.use(errorHandler);

const accountRow = (overrides = {}) => ({
  walletAddress: WALLET,
  stripeAccountId: "acct_123",
  status: "connected",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const payoutRow = (overrides = {}) => ({
  id: 1,
  walletAddress: WALLET,
  stripeAccountId: "acct_123",
  stripePayoutId: "po_123",
  amountXlm: "100",
  amountUsdCents: 4200,
  xlmUsdRate: "0.42",
  frequency: "once",
  status: "pending",
  failureReason: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  stripeService.isStripeConfigured.mockReturnValue(true);
});

// ─── POST /connect ──────────────────────────────────────────────────────────

describe("POST /api/v1/payments/stripe/connect", () => {
  test("503 when Stripe is not configured", async () => {
    stripeService.isStripeConfigured.mockReturnValue(false);

    const res = await request(app)
      .post("/api/v1/payments/stripe/connect")
      .send({ walletAddress: WALLET, redirectUri: "https://app.example.com/stripe/callback" });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("stripe_not_configured");
  });

  test("initiates the OAuth flow when no code is supplied", async () => {
    stripeService.buildConnectOAuthUrl.mockReturnValue({
      ok: true,
      url: "https://connect.stripe.com/oauth/authorize?client_id=ca_1&state=abc",
      state: "abc",
    });

    const res = await request(app)
      .post("/api/v1/payments/stripe/connect")
      .send({ walletAddress: WALLET, redirectUri: "https://app.example.com/stripe/callback" });

    expect(res.status).toBe(200);
    expect(res.body.data.authorizeUrl).toContain("connect.stripe.com");
    expect(res.body.data.state).toBe("abc");
    expect(stripeService.exchangeConnectCode).not.toHaveBeenCalled();
  });

  test("503 when Stripe Connect itself is not configured", async () => {
    stripeService.buildConnectOAuthUrl.mockReturnValue({ ok: false, reason: "stripe_connect_not_configured" });

    const res = await request(app)
      .post("/api/v1/payments/stripe/connect")
      .send({ walletAddress: WALLET, redirectUri: "https://app.example.com/stripe/callback" });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("stripe_connect_not_configured");
  });

  test("400 when completing the flow without state", async () => {
    const res = await request(app)
      .post("/api/v1/payments/stripe/connect")
      .send({ walletAddress: WALLET, redirectUri: "https://app.example.com/stripe/callback", code: "auth-code" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("missing_state");
  });

  test("400 when the OAuth state is invalid or does not match the wallet", async () => {
    stripeService.verifyConnectState.mockReturnValue(null);

    const res = await request(app).post("/api/v1/payments/stripe/connect").send({
      walletAddress: WALLET,
      redirectUri: "https://app.example.com/stripe/callback",
      code: "auth-code",
      state: "tampered",
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_oauth_state");
    expect(stripeService.exchangeConnectCode).not.toHaveBeenCalled();
  });

  test("400 when the state belongs to a different wallet", async () => {
    stripeService.verifyConnectState.mockReturnValue({ walletAddress: "GDIFFERENTWALLETXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX" });

    const res = await request(app).post("/api/v1/payments/stripe/connect").send({
      walletAddress: WALLET,
      redirectUri: "https://app.example.com/stripe/callback",
      code: "auth-code",
      state: "state-for-another-wallet",
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_oauth_state");
  });

  test("completes the flow, stores the linked account, and never returns the raw Stripe account id", async () => {
    stripeService.verifyConnectState.mockReturnValue({ walletAddress: WALLET });
    stripeService.exchangeConnectCode.mockResolvedValue({ ok: true, stripeAccountId: "acct_123" });
    dbStore.saveStripeAccount.mockReturnValue(accountRow());

    const res = await request(app).post("/api/v1/payments/stripe/connect").send({
      walletAddress: WALLET,
      redirectUri: "https://app.example.com/stripe/callback",
      code: "auth-code",
      state: "state.token",
    });

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe("connected");
    expect(res.body.data.stripeAccountId).toBeUndefined();
    expect(dbStore.saveStripeAccount).toHaveBeenCalledWith(WALLET, {
      stripeAccountId: "acct_123",
      status: "connected",
    });
  });

  test("502 when the OAuth code exchange fails", async () => {
    stripeService.verifyConnectState.mockReturnValue({ walletAddress: WALLET });
    stripeService.exchangeConnectCode.mockResolvedValue({ ok: false, reason: "invalid_grant" });

    const res = await request(app).post("/api/v1/payments/stripe/connect").send({
      walletAddress: WALLET,
      redirectUri: "https://app.example.com/stripe/callback",
      code: "bad-code",
      state: "state.token",
    });

    expect(res.status).toBe(502);
    expect(res.body.code).toBe("stripe_oauth_failed");
    expect(dbStore.saveStripeAccount).not.toHaveBeenCalled();
  });

  test("400 on an invalid wallet address", async () => {
    const res = await request(app)
      .post("/api/v1/payments/stripe/connect")
      .send({ walletAddress: "not-an-address", redirectUri: "https://app.example.com/stripe/callback" });

    expect(res.status).toBe(400);
  });
});

// ─── POST /payout-request ───────────────────────────────────────────────────

describe("POST /api/v1/payments/stripe/payout-request", () => {
  test("400 when no Stripe account is linked", async () => {
    dbStore.getStripeAccount.mockReturnValue(null);

    const res = await request(app)
      .post("/api/v1/payments/stripe/payout-request")
      .send({ walletAddress: WALLET, amount: 100 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("stripe_not_connected");
    expect(mockGetXlmUsdPrice).not.toHaveBeenCalled();
  });

  test("400 when the linked account is disconnected", async () => {
    dbStore.getStripeAccount.mockReturnValue(accountRow({ status: "disconnected" }));

    const res = await request(app)
      .post("/api/v1/payments/stripe/payout-request")
      .send({ walletAddress: WALLET, amount: 100 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("stripe_not_connected");
  });

  test("502 when the price oracle is unavailable", async () => {
    dbStore.getStripeAccount.mockReturnValue(accountRow());
    mockGetXlmUsdPrice.mockResolvedValue({ ok: false, reason: "network_error" });

    const res = await request(app)
      .post("/api/v1/payments/stripe/payout-request")
      .send({ walletAddress: WALLET, amount: 100 });

    expect(res.status).toBe(502);
    expect(res.body.code).toBe("price_oracle_unavailable");
    expect(stripeService.createStripePayout).not.toHaveBeenCalled();
  });

  test("the issue's named E2E scenario: creates a payout and calls the Stripe API with the correctly converted amount", async () => {
    dbStore.getStripeAccount.mockReturnValue(accountRow({ stripeAccountId: "acct_999" }));
    mockGetXlmUsdPrice.mockResolvedValue({ ok: true, rate: 0.42, source: "coingecko" });
    dbStore.recordStripePayout.mockReturnValue({ id: 7 });
    stripeService.createStripePayout.mockResolvedValue({ ok: true, stripePayoutId: "po_777", status: "pending" });
    dbStore.setStripePayoutExternalId.mockReturnValue(payoutRow({ id: 7, stripePayoutId: "po_777", amountUsdCents: 4200 }));

    const res = await request(app)
      .post("/api/v1/payments/stripe/payout-request")
      .send({ walletAddress: WALLET, amount: 100, frequency: "once" });

    expect(res.status).toBe(201);
    // 100 XLM * $0.42/XLM = $42.00 = 4200 cents — assert the Stripe API
    // wrapper was called with exactly that converted amount.
    expect(stripeService.createStripePayout).toHaveBeenCalledWith(
      expect.objectContaining({ stripeAccountId: "acct_999", amountUsdCents: 4200 })
    );
    expect(dbStore.recordStripePayout).toHaveBeenCalledWith(
      expect.objectContaining({
        walletAddress: WALLET,
        stripeAccountId: "acct_999",
        amountXlm: "100",
        amountUsdCents: 4200,
        xlmUsdRate: "0.42",
        frequency: "once",
        status: "pending",
      })
    );
    expect(dbStore.setStripePayoutExternalId).toHaveBeenCalledWith(7, "po_777");
    expect(res.body.data.stripePayoutId).toBe("po_777");
  });

  test("defaults frequency to 'once' when omitted", async () => {
    dbStore.getStripeAccount.mockReturnValue(accountRow());
    mockGetXlmUsdPrice.mockResolvedValue({ ok: true, rate: 0.42, source: "coingecko" });
    dbStore.recordStripePayout.mockReturnValue({ id: 8 });
    stripeService.createStripePayout.mockResolvedValue({ ok: true, stripePayoutId: "po_888", status: "pending" });
    dbStore.setStripePayoutExternalId.mockReturnValue(payoutRow({ id: 8 }));

    await request(app).post("/api/v1/payments/stripe/payout-request").send({ walletAddress: WALLET, amount: 50 });

    expect(dbStore.recordStripePayout).toHaveBeenCalledWith(expect.objectContaining({ frequency: "once" }));
  });

  test("502 and marks the payout failed when the Stripe payout API call fails", async () => {
    dbStore.getStripeAccount.mockReturnValue(accountRow());
    mockGetXlmUsdPrice.mockResolvedValue({ ok: true, rate: 0.42, source: "coingecko" });
    dbStore.recordStripePayout.mockReturnValue({ id: 9 });
    stripeService.createStripePayout.mockResolvedValue({ ok: false, reason: "account_not_ready" });
    dbStore.markStripePayoutFailedById.mockReturnValue(payoutRow({ id: 9, status: "failed", failureReason: "account_not_ready", stripePayoutId: null }));

    const res = await request(app)
      .post("/api/v1/payments/stripe/payout-request")
      .send({ walletAddress: WALLET, amount: 100 });

    expect(res.status).toBe(502);
    expect(res.body.code).toBe("stripe_payout_failed");
    expect(dbStore.markStripePayoutFailedById).toHaveBeenCalledWith(9, "account_not_ready");
    expect(dbStore.setStripePayoutExternalId).not.toHaveBeenCalled();
  });

  test.each([0, -5, 1_000_001])("400 on an out-of-range amount (%p)", async (amount) => {
    const res = await request(app)
      .post("/api/v1/payments/stripe/payout-request")
      .send({ walletAddress: WALLET, amount });
    expect(res.status).toBe(400);
    expect(dbStore.getStripeAccount).not.toHaveBeenCalled();
  });

  test("400 on an invalid frequency", async () => {
    const res = await request(app)
      .post("/api/v1/payments/stripe/payout-request")
      .send({ walletAddress: WALLET, amount: 10, frequency: "daily" });
    expect(res.status).toBe(400);
  });
});

// ─── GET /payout-status ─────────────────────────────────────────────────────

describe("GET /api/v1/payments/stripe/payout-status", () => {
  test("returns a single payout by id when it belongs to the wallet", async () => {
    dbStore.getStripePayoutById.mockReturnValue(payoutRow());

    const res = await request(app).get(
      `/api/v1/payments/stripe/payout-status?walletAddress=${WALLET}&payoutId=1`
    );

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(1);
  });

  test("404 when the payout belongs to a different wallet", async () => {
    dbStore.getStripePayoutById.mockReturnValue(payoutRow({ walletAddress: "GOTHERWALLETXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX" }));

    const res = await request(app).get(
      `/api/v1/payments/stripe/payout-status?walletAddress=${WALLET}&payoutId=1`
    );

    expect(res.status).toBe(404);
  });

  test("404 when the payout does not exist", async () => {
    dbStore.getStripePayoutById.mockReturnValue(null);

    const res = await request(app).get(
      `/api/v1/payments/stripe/payout-status?walletAddress=${WALLET}&payoutId=999`
    );

    expect(res.status).toBe(404);
  });

  test("returns the wallet's payout history when no payoutId is given", async () => {
    dbStore.listStripePayoutsByWallet.mockReturnValue([payoutRow({ id: 1 }), payoutRow({ id: 2 })]);

    const res = await request(app).get(`/api/v1/payments/stripe/payout-status?walletAddress=${WALLET}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(dbStore.listStripePayoutsByWallet).toHaveBeenCalledWith(WALLET, { limit: 20, offset: 0 });
  });

  test("400 on a missing walletAddress", async () => {
    const res = await request(app).get("/api/v1/payments/stripe/payout-status");
    expect(res.status).toBe(400);
  });
});

// ─── POST /webhook ──────────────────────────────────────────────────────────

describe("POST /api/v1/payments/stripe/webhook", () => {
  test("401 when the signature is invalid", async () => {
    stripeService.verifyStripeWebhookSignature.mockReturnValue({ ok: false, reason: "invalid_signature" });

    const res = await request(app)
      .post("/api/v1/payments/stripe/webhook")
      .set("stripe-signature", "t=1,v1=bad")
      .send({ id: "evt_1", type: "payout.paid" });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("invalid_signature");
    expect(dbStore.updateStripePayoutStatusByStripeId).not.toHaveBeenCalled();
  });

  test("deduplicates an already-processed event", async () => {
    stripeService.verifyStripeWebhookSignature.mockReturnValue({
      ok: true,
      event: { id: "evt_dup", type: "payout.paid", data: { object: { id: "po_1" } } },
    });
    dbStore.hasProcessedStripeWebhookEvent.mockReturnValue(true);

    const res = await request(app)
      .post("/api/v1/payments/stripe/webhook")
      .set("stripe-signature", "t=1,v1=ok")
      .send({ id: "evt_dup", type: "payout.paid" });

    expect(res.status).toBe(200);
    expect(res.body.data.deduped).toBe(true);
    expect(dbStore.updateStripePayoutStatusByStripeId).not.toHaveBeenCalled();
  });

  test("payout.paid updates the payout status to completed", async () => {
    stripeService.verifyStripeWebhookSignature.mockReturnValue({
      ok: true,
      event: { id: "evt_paid", type: "payout.paid", data: { object: { id: "po_123" } } },
    });
    dbStore.hasProcessedStripeWebhookEvent.mockReturnValue(false);
    dbStore.updateStripePayoutStatusByStripeId.mockReturnValue(payoutRow({ status: "completed" }));

    const res = await request(app)
      .post("/api/v1/payments/stripe/webhook")
      .set("stripe-signature", "t=1,v1=ok")
      .send({ id: "evt_paid", type: "payout.paid" });

    expect(res.status).toBe(200);
    expect(dbStore.updateStripePayoutStatusByStripeId).toHaveBeenCalledWith("po_123", "completed");
    expect(dbStore.recordStripeWebhookEvent).toHaveBeenCalledWith(
      expect.objectContaining({ stripeEventId: "evt_paid", eventType: "payout.paid", payoutId: 1 })
    );
    expect(mockSendEventSms).not.toHaveBeenCalled();
  });

  test("payout.failed updates status to failed and triggers a notification", async () => {
    stripeService.verifyStripeWebhookSignature.mockReturnValue({
      ok: true,
      event: {
        id: "evt_failed",
        type: "payout.failed",
        data: { object: { id: "po_456", failure_message: "account_closed" } },
      },
    });
    dbStore.hasProcessedStripeWebhookEvent.mockReturnValue(false);
    dbStore.updateStripePayoutStatusByStripeId.mockReturnValue(
      payoutRow({ id: 2, stripePayoutId: "po_456", status: "failed", failureReason: "account_closed" })
    );

    const res = await request(app)
      .post("/api/v1/payments/stripe/webhook")
      .set("stripe-signature", "t=1,v1=ok")
      .send({ id: "evt_failed", type: "payout.failed" });

    expect(res.status).toBe(200);
    expect(dbStore.updateStripePayoutStatusByStripeId).toHaveBeenCalledWith("po_456", "failed", {
      failureReason: "account_closed",
    });
    expect(mockSendEventSms).toHaveBeenCalledWith(
      WALLET,
      "payment_failed",
      expect.objectContaining({ reason: "account_closed" })
    );
  });

  test("payout.canceled is treated the same as payout.failed", async () => {
    stripeService.verifyStripeWebhookSignature.mockReturnValue({
      ok: true,
      event: { id: "evt_cancel", type: "payout.canceled", data: { object: { id: "po_789" } } },
    });
    dbStore.hasProcessedStripeWebhookEvent.mockReturnValue(false);
    dbStore.updateStripePayoutStatusByStripeId.mockReturnValue(payoutRow({ status: "failed" }));

    const res = await request(app)
      .post("/api/v1/payments/stripe/webhook")
      .set("stripe-signature", "t=1,v1=ok")
      .send({ id: "evt_cancel", type: "payout.canceled" });

    expect(res.status).toBe(200);
    expect(dbStore.updateStripePayoutStatusByStripeId).toHaveBeenCalledWith(
      "po_789",
      "failed",
      expect.objectContaining({ failureReason: expect.any(String) })
    );
  });

  test("payout.updated with status in_transit updates the local status", async () => {
    stripeService.verifyStripeWebhookSignature.mockReturnValue({
      ok: true,
      event: { id: "evt_transit", type: "payout.updated", data: { object: { id: "po_321", status: "in_transit" } } },
    });
    dbStore.hasProcessedStripeWebhookEvent.mockReturnValue(false);
    dbStore.updateStripePayoutStatusByStripeId.mockReturnValue(payoutRow({ status: "in_transit" }));

    const res = await request(app)
      .post("/api/v1/payments/stripe/webhook")
      .set("stripe-signature", "t=1,v1=ok")
      .send({ id: "evt_transit", type: "payout.updated" });

    expect(res.status).toBe(200);
    expect(dbStore.updateStripePayoutStatusByStripeId).toHaveBeenCalledWith("po_321", "in_transit");
  });

  test("a dispute event is recorded without updating payout status", async () => {
    stripeService.verifyStripeWebhookSignature.mockReturnValue({
      ok: true,
      event: {
        id: "evt_dispute",
        type: "charge.dispute.created",
        data: { object: { id: "dp_1", payout: "po_555" } },
      },
    });
    dbStore.hasProcessedStripeWebhookEvent.mockReturnValue(false);
    dbStore.getStripePayoutByStripeId.mockReturnValue(payoutRow({ id: 3, stripePayoutId: "po_555" }));

    const res = await request(app)
      .post("/api/v1/payments/stripe/webhook")
      .set("stripe-signature", "t=1,v1=ok")
      .send({ id: "evt_dispute", type: "charge.dispute.created" });

    expect(res.status).toBe(200);
    expect(dbStore.updateStripePayoutStatusByStripeId).not.toHaveBeenCalled();
    expect(dbStore.recordStripeWebhookEvent).toHaveBeenCalledWith(
      expect.objectContaining({ stripeEventId: "evt_dispute", eventType: "charge.dispute.created", payoutId: 3 })
    );
  });

  test("a refund event is recorded", async () => {
    stripeService.verifyStripeWebhookSignature.mockReturnValue({
      ok: true,
      event: { id: "evt_refund", type: "charge.refunded", data: { object: { id: "ch_1" } } },
    });
    dbStore.hasProcessedStripeWebhookEvent.mockReturnValue(false);

    const res = await request(app)
      .post("/api/v1/payments/stripe/webhook")
      .set("stripe-signature", "t=1,v1=ok")
      .send({ id: "evt_refund", type: "charge.refunded" });

    expect(res.status).toBe(200);
    expect(dbStore.recordStripeWebhookEvent).toHaveBeenCalledWith(
      expect.objectContaining({ stripeEventId: "evt_refund", eventType: "charge.refunded" })
    );
  });

  test("an unhandled event type is still acknowledged and recorded", async () => {
    stripeService.verifyStripeWebhookSignature.mockReturnValue({
      ok: true,
      event: { id: "evt_other", type: "account.updated", data: { object: { id: "acct_1" } } },
    });
    dbStore.hasProcessedStripeWebhookEvent.mockReturnValue(false);

    const res = await request(app)
      .post("/api/v1/payments/stripe/webhook")
      .set("stripe-signature", "t=1,v1=ok")
      .send({ id: "evt_other", type: "account.updated" });

    expect(res.status).toBe(200);
    expect(dbStore.recordStripeWebhookEvent).toHaveBeenCalled();
  });

  test("does not send an SMS notification when the failed payout resolves to no local row", async () => {
    stripeService.verifyStripeWebhookSignature.mockReturnValue({
      ok: true,
      event: { id: "evt_unknown", type: "payout.failed", data: { object: { id: "po_unknown" } } },
    });
    dbStore.hasProcessedStripeWebhookEvent.mockReturnValue(false);
    dbStore.updateStripePayoutStatusByStripeId.mockReturnValue(null);

    const res = await request(app)
      .post("/api/v1/payments/stripe/webhook")
      .set("stripe-signature", "t=1,v1=ok")
      .send({ id: "evt_unknown", type: "payout.failed" });

    expect(res.status).toBe(200);
    expect(mockSendEventSms).not.toHaveBeenCalled();
  });
});
